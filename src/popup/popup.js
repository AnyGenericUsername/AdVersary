// src/popup/popup.js
const ALL_URLS = { origins: ["<all_urls>"] };
const $ = (id) => document.getElementById(id);

const send = (type, extra = {}) => browser.runtime.sendMessage({ type: `adversary:${type}`, ...extra });

function relTime(ts) {
  if (!ts) return "–";
  const diff = Math.round((ts - Date.now()) / 1000);
  const abs = Math.abs(diff);
  const s = abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.round(abs / 60)}m` : `${Math.round(abs / 3600)}h`;
  return diff >= 0 ? `in ${s}` : `${s} ago`;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

function fillSelect(select, items, value) {
  if (select.options.length === 0) {
    for (const { id, label } of items) select.append(el("option", { value: id, textContent: label }));
  }
  select.value = value;
}

function renderLog(log) {
  const list = $("log");
  list.replaceChildren();
  if (!log.length) {
    list.append(el("li", { className: "meta", textContent: "No sessions yet." }));
    return;
  }
  for (const entry of log) {
    const when = new Date(entry.at).toLocaleTimeString();
    if (entry.type === "session") {
      const title = entry.kind === "search" ? `🔎 ${entry.query}` : `🌐 ${entry.entry}`;
      const hops = entry.steps.map((s) => s.url);
      const flags = [
        entry.manual ? "manual" : null,
        entry.aborted ? "aborted" : null,
        `${Math.round(entry.durationMs / 1000)}s`,
        `scrubbed ${entry.scrub.deleted}`
      ].filter(Boolean).join(" · ");
      list.append(el("li", {}, [
        el("div", { textContent: title }),
        ...hops.slice(1).map((u) => el("span", { className: "url meta", textContent: `→ ${u}`, title: u })),
        el("div", { className: "meta", textContent: `${when} · ${entry.topic} · ${flags}` })
      ]));
    } else {
      const text = entry.type === "error" ? `Error: ${entry.error}` : `Skipped: ${entry.reason}`;
      list.append(el("li", {}, [
        el("div", { className: entry.type === "error" ? "err" : "", textContent: text }),
        el("div", { className: "meta", textContent: when })
      ]));
    }
  }
}

async function refresh() {
  const st = await send("getStatus");
  if (!st) return;

  $("permission-banner").hidden = st.hasHostPermission;
  $("enabled").checked = st.settings.enabled;

  const idle = $("idle-state");
  idle.textContent = st.idleState;
  idle.className = `v ${st.idleState === "active" ? "" : "ok"}`;

  const running = $("running");
  running.textContent = st.running ? `${st.running.topic} (${st.running.kind})` : "none";
  running.title = st.running?.url ?? "";
  running.className = `v ${st.running ? "ok" : ""}`;

  $("next-at").textContent = st.settings.enabled ? relTime(st.nextAt) : "disabled";
  $("last-hour").textContent = `${st.sessionsLastHour} / ${st.settings.maxSessionsPerHour}`;
  $("total").textContent = `${st.stats.total}${st.stats.failed ? ` (${st.stats.failed} err)` : ""}`;

  $("run-now").disabled = Boolean(st.running) || !st.hasHostPermission;
  $("stop").disabled = !st.running;

  const form = $("settings");
  if (!form.contains(document.activeElement)) {
    fillSelect($("personaId"), st.personas, st.settings.personaId);
    fillSelect($("searchEngine"), st.engines, st.settings.searchEngine);
    for (const key of ["idleThresholdSec", "meanIntervalSec", "minIntervalSec", "maxSessionsPerHour", "maxDepth"]) {
      form.elements[key].value = st.settings[key];
    }
  }

  renderLog(st.log);
  return st;
}

$("grant").addEventListener("click", async () => {
  // Must be called synchronously from the user gesture.
  await browser.permissions.request(ALL_URLS);
  refresh();
});

$("enabled").addEventListener("change", async (e) => {
  const st = await send("getStatus");
  await send("saveSettings", { settings: { ...st.settings, enabled: e.target.checked } });
  refresh();
});

$("run-now").addEventListener("click", async () => {
  await send("runNow");
  setTimeout(refresh, 300);
});

$("stop").addEventListener("click", async () => {
  await send("stop");
  setTimeout(refresh, 300);
});

$("clear-log").addEventListener("click", async () => {
  await send("clearLog");
  refresh();
});

$("settings").addEventListener("submit", async (e) => {
  e.preventDefault();
  const st = await send("getStatus");
  const data = Object.fromEntries(new FormData(e.target).entries());
  await send("saveSettings", { settings: { ...st.settings, ...data } });
  document.activeElement?.blur();
  refresh();
});

refresh();
setInterval(refresh, 2000);
