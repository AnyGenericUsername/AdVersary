import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getPoissonInterval, nextDelayMs, pruneTimestamps, normalizeSettings,
  evaluateGate, DEFAULT_SETTINGS, MIN_IDLE_THRESHOLD_SEC
} from "../src/scheduler.js";
import { createRng } from "../src/markov.js";

test("Poisson inter-arrival times are exponential with the requested mean", () => {
  const rng = createRng(123);
  const n = 50000;
  let sum = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    const x = getPoissonInterval(45, rng) / 1000;
    assert.ok(x >= 0);
    sum += x; sumSq += x * x;
  }
  const mean = sum / n;
  const sd = Math.sqrt(sumSq / n - mean * mean);
  assert.ok(Math.abs(mean - 45) < 1.5, `mean ${mean}`);
  assert.ok(Math.abs(sd - 45) < 2.5, `sd ${sd}`);   // exponential: sd == mean
});

test("nextDelayMs never undercuts the floor", () => {
  const rng = createRng(1);
  for (let i = 0; i < 1000; i++) {
    assert.ok(nextDelayMs({ meanIntervalSec: 10, minIntervalSec: 30 }, rng) >= 30000);
  }
});

test("pruneTimestamps keeps only the last hour", () => {
  const now = 10_000_000;
  assert.deepEqual(pruneTimestamps([now - 3_700_000, now - 10, now - 3_500_000], now), [now - 10, now - 3_500_000]);
  assert.deepEqual(pruneTimestamps(undefined, now), []);
});

test("normalizeSettings clamps and fills defaults", () => {
  const s = normalizeSettings({ idleThresholdSec: 3, maxDepth: 99, maxSessionsPerHour: "0", meanIntervalSec: "abc" });
  assert.equal(s.idleThresholdSec, MIN_IDLE_THRESHOLD_SEC);
  assert.equal(s.maxDepth, 5);
  assert.equal(s.maxSessionsPerHour, DEFAULT_SETTINGS.maxSessionsPerHour);
  assert.equal(s.meanIntervalSec, DEFAULT_SETTINGS.meanIntervalSec);
  assert.equal(normalizeSettings({}).maxDepth, DEFAULT_SETTINGS.maxDepth);
  assert.equal(normalizeSettings({ maxDepth: "0" }).maxDepth, 0);
});

const base = {
  settings: normalizeSettings({}),
  idleState: "idle",
  online: true,
  hasHostPermission: true,
  hasWindow: true,
  recentSessions: [],
  now: 10_000_000
};

test("gate opens when idle, online, permitted and under budget", () => {
  assert.deepEqual(evaluateGate(base), { ok: true });
  assert.deepEqual(evaluateGate({ ...base, idleState: "locked" }), { ok: true });
});

test("gate closes for each failing condition", () => {
  assert.equal(evaluateGate({ ...base, idleState: "active" }).reason, "user-active");
  assert.equal(evaluateGate({ ...base, online: false }).reason, "offline");
  assert.equal(evaluateGate({ ...base, hasHostPermission: false }).reason, "missing-host-permission");
  assert.equal(evaluateGate({ ...base, hasWindow: false }).reason, "no-normal-window");
  assert.equal(evaluateGate({ ...base, settings: { ...base.settings, enabled: false } }).reason, "disabled");
  const full = Array.from({ length: base.settings.maxSessionsPerHour }, (_, i) => base.now - i * 1000);
  assert.equal(evaluateGate({ ...base, recentSessions: full }).reason, "throttled");
});

test("manual runs bypass idle, enabled and throttle checks but not permission", () => {
  const full = Array.from({ length: 100 }, () => base.now);
  const manual = { ...base, manual: true, idleState: "active", recentSessions: full, settings: { ...base.settings, enabled: false } };
  assert.deepEqual(evaluateGate(manual), { ok: true });
  assert.equal(evaluateGate({ ...manual, hasHostPermission: false }).reason, "missing-host-permission");
});
