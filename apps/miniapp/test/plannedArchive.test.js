import test from "node:test";
import assert from "node:assert/strict";

import {
  archivePaymentCountKey,
  buildArchivedPlanView,
  collapsePlannedArchive,
  createPlannedArchiveState,
  expandPlannedArchive,
  invalidatePlannedArchive
} from "../src/plannedArchive.js";
import { createTranslator } from "../src/i18n.js";

test("starts collapsed and idle without loading archive data", () => {
  const state = createPlannedArchiveState();

  assert.deepEqual(state, {
    expanded: false,
    status: "idle",
    items: [],
    stale: false,
    error: null,
    inFlight: null
  });
  collapsePlannedArchive(state);
  assert.equal(state.expanded, false);
  assert.equal(state.status, "idle");
});

test("deduplicates in-flight loads and caches a successful archive", async () => {
  const state = createPlannedArchiveState();
  let requests = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const loadArchive = async () => {
    requests += 1;
    await gate;
    return [{ id: 7 }];
  };

  const first = expandPlannedArchive(state, { load: loadArchive });
  const second = expandPlannedArchive(state, { load: loadArchive });
  assert.equal(requests, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), [[{ id: 7 }], [{ id: 7 }]]);
  assert.equal(state.inFlight, null);
  assert.equal(state.status, "loaded");

  await expandPlannedArchive(state, { load: loadArchive });
  assert.equal(requests, 1);
});

test("keeps an error retryable and caches only the next success", async () => {
  const state = createPlannedArchiveState();
  let requests = 0;
  const load = async () => {
    requests += 1;
    if (requests === 1) throw new Error("network_failed");
    return [{ id: 9 }];
  };

  await assert.rejects(expandPlannedArchive(state, { load }), /network_failed/);
  assert.equal(state.status, "error");
  assert.equal(state.inFlight, null);
  assert.deepEqual(await expandPlannedArchive(state, { load }), [{ id: 9 }]);
  assert.equal(requests, 2);
  assert.equal(state.error, null);
});

test("invalidates only loaded archive state and refreshes immediately only while expanded", async () => {
  const idle = createPlannedArchiveState();
  assert.equal(invalidatePlannedArchive(idle), false);
  assert.equal(idle.stale, false);

  const collapsed = createPlannedArchiveState();
  await expandPlannedArchive(collapsed, { load: async () => [{ id: 1 }] });
  collapsePlannedArchive(collapsed);
  assert.equal(invalidatePlannedArchive(collapsed), false);
  assert.equal(collapsed.stale, true);

  const expanded = createPlannedArchiveState();
  await expandPlannedArchive(expanded, { load: async () => [{ id: 2 }] });
  assert.equal(invalidatePlannedArchive(expanded), true);
  assert.equal(expanded.stale, true);
});

test("selects Russian and English saved-payment plural keys", () => {
  assert.equal(archivePaymentCountKey(1, "ru"), "plan.archivePaymentOne");
  assert.equal(archivePaymentCountKey(2, "ru"), "plan.archivePaymentFew");
  assert.equal(archivePaymentCountKey(5, "ru"), "plan.archivePaymentMany");
  assert.equal(archivePaymentCountKey(1, "en"), "plan.archivePaymentOne");
  assert.equal(archivePaymentCountKey(2, "en"), "plan.archivePaymentMany");
});

test("builds localized archive payment and null-date copy without inventing a date", () => {
  const item = {
    id: 7,
    description: "English class",
    amount: 1000,
    currency: "THB",
    recurrence: "weekly",
    weekday: 3,
    disabled_at: null,
    paid_count: 2,
    paid_amount_base: 1750,
    display: { amount: 30.67, paid_amount: 53.62, currency: "USD" }
  };

  const ru = buildArchivedPlanView(item, { language: "ru", translate: createTranslator("ru") });
  const en = buildArchivedPlanView(item, { language: "en", translate: createTranslator("en") });

  assert.equal(ru.paymentLabel, "2 сохранённые оплаты");
  assert.equal(en.paymentLabel, "2 saved payments");
  assert.equal(ru.disabledLabel, "Дата отключения не сохранена");
  assert.equal(en.disabledLabel, "Disable date unavailable");
  assert.equal(ru.disabledAt, null);
  assert.equal(en.disabledAt, null);
});
