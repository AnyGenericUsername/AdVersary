// src/background.js
//
// Controller & state. Runs as a Firefox MV3 event page, so:
//   * every listener is registered synchronously at top level,
//   * nothing important lives only in memory — the schedule is an alarm and
//     state is in storage (storage.session for the active tab id so it never
//     survives a browser restart and collides with a reused tab id),
//   * the injected dwell script sends heartbeats to keep the page alive
//     while a session is in flight.

import { getPersona, PERSONAS } from "./persona.js";
import { planStep, SEARCH_ENGINES } from "./markov.js";
import { evaluateGate, nextDelayMs, normalizeSettings, pruneTimestamps } from "./scheduler.js";
import { cleanupOrphanTab, hasNormalWindow, runSyntheticSession } from "./runner.js";

const ALARM = "adversary-next-session";
const LOG_LIMIT = 50;
const ALL_URLS = { origins: ["<all_urls>"] };

/** In-flight session: { controller, manual, plan } */
let currentRun = null;

// ---------------------------------------------------------------- storage --

async function getSettings() {
  const { settings } = await browser.storage.local.get("settings");
  return normalizeSettings(settings);
}

async function getState() {
  const s = await browser.storage.local.get({
    stats: { total: 0, aborted: 0, failed: 0, lastAt: null },
    recentSessions: [],
    markovTopic: null,
    log: [],
    nextAt: null
  });
  return s;
}

function debug(...args) {
  console.log("[AdVersary]", ...args);
}

async function appendLog(entry) {
  const { log } = await browser.storage.local.get({ log: [] });
  log.unshift({ at: Date.now(), ...entry });
  await browser.storage.local.set({ log: log.slice(0, LOG_LIMIT) });
}

async function setBadge(running) {
  try {
    await browser.action.setBadgeBackgroundColor({ color: "#b4005a" });
    await browser.action.setBadgeText({ text: running ? "●" : "" });
  } catch (_) { /* action API unavailable */ }
}

// -------------------------------------------------------------- scheduling --

async function scheduleNextIfIdle() {
  const settings = await getSettings();
  const idleState = await browser.idle.queryState(settings.idleThresholdSec);
  if (!settings.enabled || idleState === "active") {
    await cancelSchedule();
    return;
  }
  const when = Date.now() + nextDelayMs(settings);
  await browser.alarms.create(ALARM, { when });
  await browser.storage.local.set({ nextAt: when });
  debug(`next session in ${Math.round((when - Date.now()) / 1000)}s`);
}

async function cancelSchedule() {
  await browser.alarms.clear(ALARM);
  await browser.storage.local.set({ nextAt: null });
}

function abortCurrent(reason) {
  if (currentRun) {
    debug(`aborting session: ${reason}`);
    currentRun.controller.abort();
  }
}

// ----------------------------------------------------------------- session --

async function runSession({ manual = false } = {}) {
  if (currentRun) return { ok: false, reason: "busy" };

  const settings = await getSettings();
  const state = await getState();
  const now = Date.now();
  const gate = evaluateGate({
    settings,
    idleState: await browser.idle.queryState(settings.idleThresholdSec),
    online: navigator.onLine,
    hasHostPermission: await browser.permissions.contains(ALL_URLS),
    hasWindow: await hasNormalWindow(),
    recentSessions: state.recentSessions,
    now,
    manual
  });

  if (!gate.ok) {
    debug(`gate closed: ${gate.reason}`);
    if (gate.reason === "throttled" || gate.reason === "offline" || gate.reason === "no-normal-window") {
      await scheduleNextIfIdle();   // retry later while still idle
    }
    if (manual || gate.reason === "missing-host-permission") {
      await appendLog({ type: "skipped", reason: gate.reason });
    }
    return gate;
  }

  const persona = getPersona(settings.personaId);
  const plan = planStep(persona, state.markovTopic, {
    searchEngine: settings.searchEngine,
    maxDepth: settings.maxDepth
  });
  const controller = new AbortController();
  currentRun = { controller, manual, plan };
  await setBadge(true);
  debug(`session start [${plan.topic}/${plan.kind}] ${plan.url}`);

  try {
    const result = await runSyntheticSession(plan, {
      signal: controller.signal,
      onTab: (tabId) => browser.storage.session.set({ activeTabId: tabId }),
      log: debug
    });

    const recentSessions = pruneTimestamps(state.recentSessions, Date.now());
    recentSessions.push(result.startedAt);
    const stats = { ...state.stats, lastAt: Date.now() };
    stats.total += 1;
    if (result.aborted) stats.aborted += 1;

    await browser.storage.local.set({ recentSessions, stats, markovTopic: plan.topic });
    await appendLog({ type: "session", manual, ...result });
    debug("session done", result);
    return { ok: true, result };
  } catch (err) {
    debug("session failed", err);
    const { stats } = await getState();
    stats.failed += 1;
    await browser.storage.local.set({ stats });
    await appendLog({ type: "error", manual, topic: plan.topic, entry: plan.url, error: String(err?.message ?? err) });
    return { ok: false, reason: String(err?.message ?? err) };
  } finally {
    currentRun = null;
    await setBadge(false);
    await scheduleNextIfIdle();
  }
}

// --------------------------------------------------------------- listeners --

async function applySettings() {
  const settings = await getSettings();
  browser.idle.setDetectionInterval(settings.idleThresholdSec);
  if (!settings.enabled) {
    abortCurrent("disabled");
    await cancelSchedule();
  } else {
    await scheduleNextIfIdle();
  }
}

browser.idle.onStateChanged.addListener(async (state) => {
  debug(`idle state -> ${state}`);
  if (state === "idle" || state === "locked") {
    const settings = await getSettings();
    if (settings.enabled && !currentRun) {
      debug("host idle/locked: initiating synthetic session");
      runSession();
    }
  } else if (state === "active") {
    debug("user returned: pausing immediately");
    if (currentRun && !currentRun.manual) abortCurrent("user-active");
    await cancelSchedule();
  }
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) runSession();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) applySettings();
});

browser.runtime.onMessage.addListener((msg) => {
  switch (msg?.type) {
    case "adversary:heartbeat":
      return undefined; // receiving the event is enough to keep us alive
    case "adversary:getStatus":
      return getStatus();
    case "adversary:saveSettings":
      return browser.storage.local
        .set({ settings: normalizeSettings(msg.settings) })
        .then(() => ({ ok: true }));
    case "adversary:runNow":
      runSession({ manual: true });
      return Promise.resolve({ ok: true });
    case "adversary:stop":
      abortCurrent("user-request");
      return Promise.resolve({ ok: true });
    case "adversary:clearLog":
      return browser.storage.local.set({ log: [] }).then(() => ({ ok: true }));
    default:
      return undefined;
  }
});

async function getStatus() {
  const settings = await getSettings();
  const state = await getState();
  return {
    settings,
    idleState: await browser.idle.queryState(settings.idleThresholdSec),
    hasHostPermission: await browser.permissions.contains(ALL_URLS),
    running: currentRun
      ? { manual: currentRun.manual, topic: currentRun.plan.topic, kind: currentRun.plan.kind, url: currentRun.plan.url }
      : null,
    stats: state.stats,
    sessionsLastHour: pruneTimestamps(state.recentSessions, Date.now()).length,
    nextAt: state.nextAt,
    log: state.log,
    personas: Object.values(PERSONAS).map((p) => ({ id: p.id, label: p.label })),
    engines: Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, label: e.label }))
  };
}

// -------------------------------------------------------------------- boot --

async function boot() {
  const settings = await getSettings();
  browser.idle.setDetectionInterval(settings.idleThresholdSec);

  // If the event page was torn down mid-session, a hidden tab may linger.
  const { activeTabId } = await browser.storage.session.get("activeTabId");
  if (activeTabId !== undefined && activeTabId !== null && !currentRun) {
    await cleanupOrphanTab(activeTabId, debug);
    await browser.storage.session.set({ activeTabId: null });
  }

  // Re-arm the schedule if we woke up idle with no pending alarm.
  const alarm = await browser.alarms.get(ALARM);
  if (!alarm) await scheduleNextIfIdle();
}

browser.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") {
    // Firefox MV3 host permissions are user-controlled; nudge setup.
    if (!(await browser.permissions.contains(ALL_URLS))) {
      await browser.runtime.openOptionsPage?.().catch(() => {});
    }
  }
});

boot().catch((err) => debug("boot failed", err));
