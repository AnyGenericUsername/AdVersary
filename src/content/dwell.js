// src/content/dwell.js
//
// Injected via browser.scripting.executeScript({ func, args }). The function
// is serialized, so it MUST be fully self-contained: no imports, no closures
// over module scope.
//
// Behaviour:
//   * Scrolls in irregular increments with occasional "reading" pauses and
//     small scroll-backs, stopping at the page end or `maxScroll` pixels.
//   * Dwells 3–8 s (configurable) at the end.
//   * Optionally picks a link to follow next (search result, product page…).
//   * Sends a heartbeat message every few seconds so Firefox does not suspend
//     the background event page mid-session.
//
// Note: timers in background tabs are clamped to >= 1 s by Firefox, and
// smooth scrolling relies on the refresh driver (not ticking in hidden tabs),
// so scrolls use instant behaviour.

export function simulateHumanDwell(options = {}) {
  const {
    maxScroll = 2500,
    minDwellMs = 3000,
    maxDwellMs = 8000,
    maxTotalMs = 90000,
    pickLink = null,
    heartbeatMs = 5000
  } = options;

  const rand = (min, max) => min + Math.random() * (max - min);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = globalThis.browser ?? globalThis.chrome;

  const heartbeat = setInterval(() => {
    try {
      const p = api?.runtime?.sendMessage({ type: "adversary:heartbeat" });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_) { /* extension context gone */ }
  }, heartbeatMs);

  function hostMatches(host, domain) {
    host = host.replace(/^www\./, "");
    domain = domain.replace(/^www\./, "");
    return host === domain || host.endsWith("." + domain);
  }

  function chooseLink(cfg) {
    const {
      mode = "same-site",
      preferredHosts = [],
      excludeHosts = [],
      productPatterns = []
    } = cfg;
    const here = location.hostname;
    const blocked = /\b(login|log-in|signin|sign-in|signup|sign-up|register|account|logout|cart|basket|checkout|bag|wishlist|subscribe|newsletter|privacy|terms|cookies?|help|support|contact|careers|preferences|settings|unsubscribe)\b/i;

    const candidates = [];
    for (const a of document.querySelectorAll("a[href]")) {
      let url;
      try { url = new URL(a.href, location.href); } catch (_) { continue; }
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      if (url.href.split("#")[0] === location.href.split("#")[0]) continue;
      if (blocked.test(url.pathname) || blocked.test(a.textContent || "")) continue;
      if (a.closest("header nav, footer, [role='contentinfo']")) continue;
      if (a.getClientRects().length === 0) continue; // not rendered

      const sameSite = hostMatches(url.hostname, here);
      if (mode === "same-site" && !sameSite) continue;
      if (mode === "external") {
        if (sameSite) continue;
        if (excludeHosts.some((h) => hostMatches(url.hostname, h))) continue;
      }

      let weight = 1;
      if (preferredHosts.some((h) => hostMatches(url.hostname, h))) weight += 6;
      if (productPatterns.some((p) => url.pathname.toLowerCase().includes(p))) weight += 4;
      if ((a.textContent || "").trim().split(/\s+/).length >= 3) weight += 1; // descriptive anchor
      candidates.push({ href: url.href, weight });
    }
    if (candidates.length === 0) return null;

    const total = candidates.reduce((s, c) => s + c.weight, 0);
    let r = Math.random() * total;
    for (const c of candidates) {
      r -= c.weight;
      if (r < 0) return c.href;
    }
    return candidates[candidates.length - 1].href;
  }

  async function run() {
    const started = Date.now();
    const scroller = document.scrollingElement || document.documentElement;
    const limit = Math.min(Math.max(0, scroller.scrollHeight - window.innerHeight), maxScroll);
    let scrolled = 0;
    let stalls = 0;

    while (scrolled < limit && Date.now() - started < maxTotalMs) {
      const roll = Math.random();
      if (roll < 0.1) {
        await sleep(rand(1000, 3500));                       // reading pause
      } else if (roll < 0.17 && scrolled > 200) {
        const back = Math.floor(rand(40, 160));             // glance back up
        window.scrollBy({ top: -back, behavior: "instant" });
        scrolled -= back;
      } else {
        const before = scroller.scrollTop;
        const delta = Math.floor(rand(20, 120));
        window.scrollBy({ top: delta, behavior: "instant" });
        const moved = scroller.scrollTop - before;
        scrolled += moved > 0 ? moved : delta;
        stalls = moved > 0 ? 0 : stalls + 1;
        if (stalls >= 5) break;                             // page won't scroll
      }
      await sleep(rand(200, 600));
    }

    await sleep(rand(minDwellMs, maxDwellMs));
    const href = pickLink ? chooseLink(pickLink) : null;
    return { scrolled: Math.max(0, scrolled), href, title: document.title };
  }

  return run().finally(() => clearInterval(heartbeat));
}
