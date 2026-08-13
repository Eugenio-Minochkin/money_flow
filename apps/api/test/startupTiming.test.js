import test from "node:test";
import assert from "node:assert/strict";

import { createStartupTiming } from "../src/startupTiming.js";

test("startup timing measures stable phases and formats Server-Timing", async () => {
  const ticks = [0, 0, 12.345, 12.345, 20.901, 24.901];
  const timing = createStartupTiming({ now: () => ticks.shift() });

  await timing.measure("user_upsert", async () => "user");
  await timing.measure("repository_dashboard", async () => "dashboard");
  timing.add("analytics", 3.333);
  timing.finish();

  assert.equal(
    timing.serverTiming(),
    "user_upsert;dur=12.3, repository_dashboard;dur=8.6, analytics;dur=3.3, total;dur=24.9"
  );
  assert.deepEqual(timing.snapshot(), {
    user_upsert: 12.3,
    repository_dashboard: 8.6,
    analytics: 3.3,
    total: 24.9
  });
});

test("startup timing rejects arbitrary phase names and logs one privacy-safe slow request", () => {
  const warnings = [];
  const ticks = [0, 1501];
  const timing = createStartupTiming({
    now: () => ticks.shift(),
    slowThresholdMs: 1000,
    logger: { warn: (...args) => warnings.push(args) }
  });

  assert.throws(() => timing.add("telegram_init_data", 12), /Unknown startup timing phase/);
  timing.add("auth", 10);
  timing.finish({ route: "/api/dashboard", status: 200 });
  timing.finish({ route: "/api/dashboard", status: 200 });

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], "[startup] slow request");
  assert.deepEqual(warnings[0][1], {
    route: "/api/dashboard",
    status: 200,
    timings: { auth: 10, total: 1501 }
  });
  assert.doesNotMatch(JSON.stringify(warnings), /telegram|initData|token|user/i);
});
