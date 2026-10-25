# AdVersary

Firefox Manifest V3 extension that obfuscates your programmatic-advertising profile.
While you are away from the keyboard it browses as a synthetic persona in hidden background tabs.
Third-party pixels (Meta, Google, Criteo, …) on those pages record a demographic and interest profile that isn't yours.
The moment you touch the keyboard or mouse, it stops.

```
┌────────────────────────────────────────────────────────┐
│               Firefox Manifest V3 Runtime              │
├───────────────────────────────┬────────────────────────┤
│     Controller & State        │   Adversarial Engine   │
│  background.js / scheduler.js │  markov.js             │
│  - idle state monitoring      │  - topic Markov chain  │
│  - online / hourly throttle   │  - bigram query engine │
│  - history + session scrubber │  - Poisson scheduler   │
│                               │  persona.js seed graph │
├───────────────────────────────┴────────────────────────┤
│           Silent Execution Context (runner.js)         │
│  Hidden, muted, inactive background tab                │
│   ├── Third-party pixels load with full DOM/JS         │
│   └── Injected content/dwell.js (scroll, dwell, links) │
└────────────────────────────────────────────────────────┘
```

## Layout

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest, event-page background (`background.scripts`) |
| `src/background.js` | Controller: idle listener, alarm schedule, gate, stats/log, popup messaging |
| `src/scheduler.js` | Pure gatekeeper and Poisson interval logic |
| `src/markov.js` | Topic transition chain, bigram query generator, step planner |
| `src/persona.js` | Persona seed graphs (topics → queries, seed domains, transitions) |
| `src/runner.js` | Hidden tab lifecycle, multi-hop navigation, history/session scrubbing |
| `src/content/dwell.js` | Injected function: humanized scrolling, dwell, link picking, heartbeat |
| `src/popup/` | Popup + options page: status, settings, manual run, activity log |
| `test/` | `node:test` unit tests for the pure modules |

## Session lifecycle

1. `idle.onStateChanged` → `idle`/`locked` triggers the first session. After that, an alarm schedules each next session.
   The delay is `minIntervalSec + Exp(meanIntervalSec)`, so arrivals form a shifted Poisson process.
2. The gate checks: enabled, host idle, `navigator.onLine`, a normal (non-private) window exists, `<all_urls>` is granted, and the hourly budget isn't used up.
3. `planStep` advances the topic Markov chain. It then either:
   - **searches** a generated query (Google/Bing/DDG) and clicks through to a result, preferring the topic's seed domains, or
   - **visits** a seed domain and follows same-site links, preferring product pages.
4. The runner opens an `about:blank` tab with `active: false`, mutes it, hides it (`tabs.hide`), then navigates it.
   The injected dwell script scrolls irregularly, pauses, and dwells 3–8 s. If hops remain, it returns the next link.
5. Teardown: the tab is removed. Every URL the session touched is deleted from history, including redirect hops caught through `history.onVisited`.
   URLs you had visited **before** the session are left alone. The tab is also removed from *Recently Closed Tabs*.
6. If the state goes back to `active`, the in-flight session is aborted at the next await and its tab is closed and scrubbed.

## Development

```bash
npm install          # installs web-ext locally
npm start            # web-ext run --firefox=firefox, live reload
npm test             # unit tests (Node ≥ 20)
npm run lint         # web-ext lint
npm run build        # dist/adversary-0.1.0.zip
```

**First run:** open the toolbar popup and click **Grant site access** if the banner shows. In Firefox MV3, host permissions are user-controlled.
**Run session now** runs one session right away, skipping the idle gate. Use it for debugging.

To debug, open `about:debugging#/runtime/this-firefox` → AdVersary → **Inspect**. You'll see the `[AdVersary]` log, tab spawns, and network traffic.
Hidden tabs appear under the "List all tabs" menu while a session runs.

## Design decisions & deviations from the original spec

- **No transactional "conversion events".** The spec listed `add_to_cart` / `newsletter_signup`.
  Submitting signup forms would send fake addresses to real businesses. Adding items to carts fires CPA conversion pixels that advertisers pay for.
  Both move from profile obfuscation into spam and ad fraud. Instead, the link picker prefers product detail pages (`productLinkPatterns`), a `view_item`-style interest signal.
  It also refuses login/cart/checkout/newsletter/account links.
- **Tabs, not iframes.** Many sites send `X-Frame-Options`/`frame-ancestors`.
  Frames inside the extension's background page would also have cookies partitioned under the `moz-extension://` top-level site, so they would build no useful profile.
- **Extra permissions:** `tabs` + `scripting` (needed by the runner), `tabHide` (keeps the tab strip clean), `sessions` (Recently Closed scrubbing).
- **`strict_min_version` 115** for `storage.session`. It holds the in-flight tab id, which must not survive a restart where tab ids are reused.
- **30 s floor between sessions:** MV3 alarms aren't dependable below ~30 s, and `setTimeout` doesn't survive event-page suspension.
- **Instant (not smooth) scrolling:** hidden tabs don't tick the refresh driver, and Firefox clamps their timers to ≥1 s.

## Effectiveness caveats

- **Firefox Enhanced Tracking Protection / Total Cookie Protection** blocks or partitions many third-party trackers.
  With Standard or Strict ETP, a lot of the pixels this extension depends on are neutered, in your real browsing as well as in synthetic sessions.
  The strongest effect comes from first-party signals: searches on Google/Bing while signed in, and on-site behaviour at retailers with their own ad networks.
- Background tabs aren't rendered, so ad viewability (IntersectionObserver) mostly won't fire. That keeps publisher impression counts largely untouched.
- Search engines may serve CAPTCHAs if the rate is too high. Keep `maxSessionsPerHour` modest.

## Verification & adversarial auditing

- **Direct profile audit:** every ~3 days, check [Google My Ad Center](https://myadcenter.google.com) and Meta's *Ad topics*.
  Watch for inferred gender/age shifts and new categories (Women's Apparel, Cosmetics, Parenting).
- **Impression sampling:** run a local mock page with Prebid.js / GPT. Log the winning bids' IAB categories (`seatbid[].bid[].cat`) before and after poisoning, then compare the distributions.
