// src/runner.js
//
// Silent execution context. A synthetic session:
//   1. creates an inactive, muted, hidden tab in a normal (non-private) window
//   2. navigates it to the planned URL and waits for load
//   3. injects the humanized dwell script; optionally follows a picked link
//      up to `plan.depth` times
//   4. tears the tab down
//   5. scrubs every URL the session produced from history (preserving URLs
//      the user had visited before) and from "Recently Closed Tabs"
//
// Sessions are abortable through an AbortSignal — the background aborts the
// moment the user becomes active again.

import { simulateHumanDwell } from "./content/dwell.js";

const PAGE_LOAD_TIMEOUT_MS = 30000;
const SCRIPT_TIMEOUT_MS = 120000;

export class SessionAborted extends Error {
  constructor(reason = "aborted") {
    super(reason);
    this.name = "SessionAborted";
  }
}

function abortPromise(signal) {
  return new Promise((_, reject) => {
    if (signal?.aborted) return reject(new SessionAborted());
    signal?.addEventListener("abort", () => reject(new SessionAborted()), { once: true });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isWebUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return null; }
}

/**
 * Navigate `tabId` to `url` and resolve once the new document reaches
 * status "complete" (or after a timeout — some pages never settle).
 * The listener is attached before navigation starts to avoid races, and a
 * "loading" transition must be observed first so a stale "complete" from the
 * previous document is ignored.
 */
async function navigateAndWait(tabId, url, signal) {
  let cleanup = () => {};
  const loaded = new Promise((resolve, reject) => {
    let sawLoading = false;
    const onUpdated = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "loading") sawLoading = true;
      if (info.status === "complete" && sawLoading) { cleanup(); resolve("complete"); }
    };
    const onRemoved = (id) => {
      if (id === tabId) { cleanup(); reject(new SessionAborted("tab-closed")); }
    };
    const timer = setTimeout(() => { cleanup(); resolve("timeout"); }, PAGE_LOAD_TIMEOUT_MS);
    cleanup = () => {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
    };
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);
  });

  try {
    await browser.tabs.update(tabId, { url });
    return await Promise.race([loaded, abortPromise(signal)]);
  } finally {
    cleanup();
  }
}

async function injectDwell(tabId, options, signal) {
  const exec = browser.scripting
    .executeScript({ target: { tabId }, func: simulateHumanDwell, args: [options] })
    .then((results) => results?.[0]?.result ?? null);
  const timeout = sleep(SCRIPT_TIMEOUT_MS).then(() => null);
  return Promise.race([exec, timeout, abortPromise(signal)]);
}

async function findNormalWindowId() {
  const windows = await browser.windows.getAll({ windowTypes: ["normal"] });
  const win = windows.find((w) => !w.incognito && w.focused) ?? windows.find((w) => !w.incognito);
  return win?.id;
}

export async function hasNormalWindow() {
  return (await findNormalWindowId()) !== undefined;
}

/** Remove synthetic URLs from history, keeping any the user visited before the session. */
async function scrubHistory(urls, sessionStart, log) {
  let deleted = 0;
  let preserved = 0;
  for (const url of urls) {
    try {
      const visits = await browser.history.getVisits({ url });
      if (visits.some((v) => v.visitTime < sessionStart - 1000)) {
        preserved++;
        continue;
      }
      await browser.history.deleteUrl({ url });
      deleted++;
    } catch (err) {
      log?.(`history scrub failed for ${url}: ${err.message}`);
    }
  }
  return { deleted, preserved };
}

/** Forget the torn-down tab from "Recently Closed Tabs" (session history). */
async function scrubClosedTabs(urls, sessionStart, log) {
  let forgotten = 0;
  // The session store records the closed tab asynchronously; retry briefly.
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(400);
    try {
      const closed = await browser.sessions.getRecentlyClosed({ maxResults: 25 });
      for (const entry of closed) {
        const tab = entry.tab;
        if (!tab?.sessionId || entry.lastModified < sessionStart - 1000) continue;
        if (!urls.has(tab.url)) continue;
        await browser.sessions.forgetClosedTab(tab.windowId, tab.sessionId);
        forgotten++;
      }
    } catch (err) {
      log?.(`closed-tab scrub failed: ${err.message}`);
      break;
    }
    if (forgotten > 0) break;
  }
  return forgotten;
}

/**
 * Run one synthetic session for a plan produced by markov.planStep().
 *
 * @param {object} plan
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {(tabId: number|null) => void} [opts.onTab]  persist / clear the active tab id
 * @param {(msg: string) => void} [opts.log]
 */
export async function runSyntheticSession(plan, { signal, onTab, log } = {}) {
  const sessionStart = Date.now();
  const urls = new Set([plan.url]);
  const hosts = new Set([hostOf(plan.url), ...plan.preferredHosts, ...plan.excludeHosts]);
  const historyVisits = [];
  const steps = [];
  let aborted = false;
  let tabId = null;

  const windowId = await findNormalWindowId();
  if (windowId === undefined) throw new Error("no-normal-window");

  const onUpdated = (id, info) => {
    if (id === tabId && isWebUrl(info.url)) {
      urls.add(info.url);
      hosts.add(hostOf(info.url));
    }
  };
  // Catches redirect hops that never surface as a tab URL.
  const onVisited = (item) => {
    if (item.lastVisitTime >= sessionStart - 1000) historyVisits.push(item.url);
  };
  browser.tabs.onUpdated.addListener(onUpdated);
  browser.history.onVisited.addListener(onVisited);

  try {
    // 1. Background, unselected tab. Start blank so the load listener can be
    //    attached before the real navigation begins.
    const tab = await browser.tabs.create({ url: "about:blank", active: false, windowId });
    tabId = tab.id;
    onTab?.(tabId);
    await browser.tabs.update(tabId, { muted: true }).catch(() => {});
    await browser.tabs.hide(tabId).catch((e) => log?.(`tabs.hide unavailable: ${e.message}`));

    let nextUrl = plan.url;
    for (let hop = 0; hop <= plan.depth && nextUrl; hop++) {
      if (signal?.aborted) throw new SessionAborted();
      urls.add(nextUrl);

      // 2. Navigate and wait for load.
      const loadState = await navigateAndWait(tabId, nextUrl, signal);
      const current = await browser.tabs.get(tabId);
      if (!isWebUrl(current.url)) {
        log?.(`hop ${hop}: non-web page (${current.url}), stopping`);
        break;
      }

      // 3. Human-like scrolling and dwell; pick the next link if hops remain.
      const wantLink = hop < plan.depth;
      const result = await injectDwell(tabId, {
        pickLink: wantLink
          ? {
              mode: hop === 0 ? plan.linkMode : "same-site",
              preferredHosts: plan.preferredHosts,
              excludeHosts: plan.excludeHosts,
              productPatterns: plan.productPatterns
            }
          : null
      }, signal).catch((err) => {
        if (err instanceof SessionAborted) throw err;
        log?.(`inject failed on ${current.url}: ${err.message}`);
        return null;
      });

      steps.push({
        url: current.url,
        title: result?.title ?? current.title ?? "",
        scrolled: result?.scrolled ?? 0,
        load: loadState
      });
      nextUrl = result?.href ?? null;
    }
  } catch (err) {
    if (err instanceof SessionAborted) aborted = true;
    else throw err;
  } finally {
    browser.tabs.onUpdated.removeListener(onUpdated);

    // 4. Tear down the tab.
    if (tabId !== null) {
      await browser.tabs.remove(tabId).catch(() => {});
      onTab?.(null);
    }

    // Give late history writes a moment to land, then stop listening.
    await sleep(300);
    browser.history.onVisited.removeListener(onVisited);
    for (const url of historyVisits) {
      if (hosts.has(hostOf(url))) urls.add(url);
    }
  }

  // 5. Scrub history + recently closed tabs.
  const history = await scrubHistory(urls, sessionStart, log);
  const closedTabsForgotten = await scrubClosedTabs(urls, sessionStart, log);

  return {
    startedAt: sessionStart,
    durationMs: Date.now() - sessionStart,
    topic: plan.topic,
    kind: plan.kind,
    query: plan.query ?? null,
    entry: plan.url,
    steps,
    aborted,
    scrub: { ...history, closedTabsForgotten }
  };
}

/** Remove a tab left behind if the event page was suspended mid-session. */
export async function cleanupOrphanTab(tabId, log) {
  if (tabId === null || tabId === undefined) return;
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.hidden || !tab.active) {
      await browser.tabs.remove(tabId);
      log?.(`removed orphaned synthetic tab ${tabId}`);
    }
  } catch (_) { /* already gone */ }
}
