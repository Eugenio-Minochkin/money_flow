import test from "node:test";
import assert from "node:assert/strict";

import { recordClientStartupTiming } from "../src/clientStartupTiming.js";

test("records one privacy-safe allowlisted slow client startup", () => {
  const warnings = [];

  const timings = recordClientStartupTiming({
    dashboard_total: 7123.456,
    telegram_sdk: 4987.04,
    telegram_sdk_resource: 4720.02,
    app_bootstrap: 1510.15,
    dashboard_request: 410.44,
    dashboard_render: 42.26,
    navigation_ttfb: 180.18,
    app_entry_resource: 320.32,
    styles_resource: 90.09,
    telegramUserId: 123,
    initData: "secret"
  }, { logger: { warn: (...args) => warnings.push(args) } });

  assert.deepEqual(timings, {
    telegram_sdk: 4987,
    telegram_sdk_resource: 4720,
    app_bootstrap: 1510.2,
    dashboard_request: 410.4,
    dashboard_render: 42.3,
    dashboard_total: 7123.5,
    navigation_ttfb: 180.2,
    app_entry_resource: 320.3,
    styles_resource: 90.1
  });
  assert.deepEqual(warnings, [["[startup] slow client", { timings }]]);
  assert.doesNotMatch(JSON.stringify(warnings), /telegramUserId|initData|secret/);
});

test("rejects malformed client timing reports and keeps fast reports quiet", () => {
  const warnings = [];
  const logger = { warn: (...args) => warnings.push(args) };

  assert.equal(recordClientStartupTiming(null, { logger }), null);
  assert.equal(recordClientStartupTiming({ dashboard_total: "7000" }, { logger }), null);
  assert.equal(recordClientStartupTiming({ dashboard_total: -1 }, { logger }), null);
  assert.deepEqual(recordClientStartupTiming({ dashboard_total: 900, dashboard_request: 200 }, { logger }), {
    dashboard_request: 200,
    dashboard_total: 900
  });
  assert.deepEqual(warnings, []);
});
