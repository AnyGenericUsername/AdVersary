// src/scheduler.js
//
// Pure scheduling / gating logic. The background script owns all browser API
// calls and passes plain values in, which keeps this module testable in Node.

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  personaId: "female_lifestyle",
  searchEngine: "google",
  idleThresholdSec: 60,      // browser.idle detection interval (min 15)
  meanIntervalSec: 45,       // mean of the exponential inter-arrival time
  minIntervalSec: 30,        // floor added to every delay (alarms granularity)
  maxSessionsPerHour: 20,    // throttle
  maxDepth: 2                // max link-follows per session
});

// Firefox rejects idle detection intervals below 15 seconds.
export const MIN_IDLE_THRESHOLD_SEC = 15;

/**
 * Exponential inter-arrival time in ms: -ln(U) * mean.
 * Successive sessions therefore form a Poisson process.
 */
export function getPoissonInterval(meanSeconds = 45, rng = Math.random) {
  return -Math.log(1 - rng()) * meanSeconds * 1000;
}

/**
 * Delay until the next session: a fixed floor plus an exponential tail.
 * The shifted exponential stays memoryless past the floor, so the arrival
 * pattern does not look periodic while respecting alarm granularity.
 */
export function nextDelayMs(settings, rng = Math.random) {
  const floor = Math.max(0, settings.minIntervalSec ?? DEFAULT_SETTINGS.minIntervalSec) * 1000;
  return floor + getPoissonInterval(settings.meanIntervalSec ?? DEFAULT_SETTINGS.meanIntervalSec, rng);
}

/** Drop session timestamps older than the throttle window. */
export function pruneTimestamps(timestamps, now, windowMs = 60 * 60 * 1000) {
  return (timestamps ?? []).filter((t) => now - t < windowMs);
}

export function normalizeSettings(raw = {}) {
  const s = { ...DEFAULT_SETTINGS, ...raw };
  s.idleThresholdSec = Math.max(MIN_IDLE_THRESHOLD_SEC, Math.round(Number(s.idleThresholdSec) || DEFAULT_SETTINGS.idleThresholdSec));
  s.meanIntervalSec = Math.max(1, Number(s.meanIntervalSec) || DEFAULT_SETTINGS.meanIntervalSec);
  s.minIntervalSec = Math.max(0, Number(s.minIntervalSec) || 0);
  s.maxSessionsPerHour = Math.max(1, Math.round(Number(s.maxSessionsPerHour) || DEFAULT_SETTINGS.maxSessionsPerHour));
  s.maxDepth = Math.min(5, Math.max(0, Math.round(Number(s.maxDepth))));
  if (Number.isNaN(s.maxDepth)) s.maxDepth = DEFAULT_SETTINGS.maxDepth;
  s.enabled = Boolean(s.enabled);
  return s;
}

/**
 * Execution gatekeeper. Returns `{ ok: true }` or `{ ok: false, reason }`.
 * `manual` bypasses the enabled/idle checks (used by "Run session now").
 */
export function evaluateGate({
  settings,
  idleState,
  online,
  hasHostPermission,
  hasWindow,
  recentSessions,
  now,
  manual = false
}) {
  if (!hasHostPermission) return { ok: false, reason: "missing-host-permission" };
  if (!manual && !settings.enabled) return { ok: false, reason: "disabled" };
  if (!manual && idleState === "active") return { ok: false, reason: "user-active" };
  if (!online) return { ok: false, reason: "offline" };
  if (!hasWindow) return { ok: false, reason: "no-normal-window" };
  const recent = pruneTimestamps(recentSessions, now);
  if (!manual && recent.length >= settings.maxSessionsPerHour) {
    return { ok: false, reason: "throttled" };
  }
  return { ok: true };
}
