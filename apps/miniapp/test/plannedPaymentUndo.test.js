import test from "node:test";
import assert from "node:assert/strict";

import { paidPlannedPaymentUndoOccurrences, runPlannedPaymentUndo } from "../src/plannedPaymentUndo.js";

test("planned payment undo confirms an exact occurrence and sends one DELETE lifecycle", async () => {
  const button = { disabled: false, dataset: {}, isConnected: true };
  const calls = [];
  const result = await runPlannedPaymentUndo({
    button,
    item: { id: 41 },
    occurrenceDate: "2026-07-15",
    confirm(message) { calls.push(["confirm", message]); return true; },
    undoRequest(id, occurrenceDate) { calls.push(["undo", id, occurrenceDate]); return Promise.resolve({ status: "undone" }); },
    loadDashboard() { calls.push(["dashboard"]); return Promise.resolve(); },
    loadHistory() { calls.push(["history"]); return Promise.resolve(); },
    showToast(message) { calls.push(["toast", message]); },
    translate(key, values = {}) { return `${key}:${values.date ?? ""}`; },
    formatOccurrenceDate(value) { return `date:${value}`; }
  });

  assert.equal(result.status, "undone");
  assert.deepEqual(calls, [
    ["confirm", "plannedPaymentUndo.confirmation:date:2026-07-15"],
    ["undo", 41, "2026-07-15"],
    ["dashboard"],
    ["history"],
    ["toast", "toast.plannedPaymentUndone:"]
  ]);
  assert.equal(button.disabled, false);
});

test("planned payment undo treats already_unpaid as success and suppresses a duplicate click", async () => {
  const button = { disabled: false, dataset: {}, isConnected: true };
  let requestCount = 0;
  let resolveRequest;
  const pending = runPlannedPaymentUndo({
    button,
    item: { id: 41 },
    occurrenceDate: "2026-07-15",
    confirm: () => true,
    undoRequest() { requestCount += 1; return new Promise((resolve) => { resolveRequest = resolve; }); },
    loadDashboard: async () => {},
    loadHistory: async () => {},
    showToast: () => {},
    translate: (key) => key,
    formatOccurrenceDate: (value) => value
  });

  const duplicate = await runPlannedPaymentUndo({
    button, item: { id: 41 }, occurrenceDate: "2026-07-15",
    confirm: () => true, undoRequest: async () => ({ status: "undone" }),
    loadDashboard: async () => {}, loadHistory: async () => {}, showToast: () => {},
    translate: (key) => key, formatOccurrenceDate: (value) => value
  });
  resolveRequest({ status: "already_unpaid" });
  const first = await pending;

  assert.equal(requestCount, 1);
  assert.equal(duplicate.status, "busy");
  assert.equal(first.status, "already_unpaid");
});

test("planned payment undo restores the selected button after an error", async () => {
  const button = { disabled: false, dataset: {}, isConnected: true };
  let errorMessage;
  const result = await runPlannedPaymentUndo({
    button, item: { id: 41 }, occurrenceDate: "2026-07-15", confirm: () => true,
    undoRequest: async () => { throw new Error("planned_payment_undo_blocked"); },
    loadDashboard: async () => {}, loadHistory: async () => {}, showToast: () => {},
    showError: (message) => { errorMessage = message; },
    translate: (key) => key, formatOccurrenceDate: (value) => value
  });
  assert.equal(result.status, "error");
  assert.equal(button.disabled, false);
  assert.equal(errorMessage, "toast.plannedPaymentUndoBlocked");
});

test("planned payment undo keeps its committed success when refresh fails", async () => {
  const button = { disabled: false, dataset: {}, isConnected: true };
  const calls = [];
  const result = await runPlannedPaymentUndo({
    button, item: { id: 41 }, occurrenceDate: "2026-07-15", confirm: () => true,
    undoRequest: async () => { calls.push("delete"); return { status: "undone" }; },
    loadDashboard: async () => { throw new Error("refresh failed"); },
    loadHistory: async () => { throw new Error("refresh failed"); },
    showToast: (message) => calls.push(message),
    showError: (message) => calls.push(`error:${message}`),
    translate: (key) => key, formatOccurrenceDate: (value) => value
  });

  assert.equal(result.status, "undone");
  assert.deepEqual(calls, ["delete", "toast.plannedPaymentUndone"]);
  assert.equal(button.disabled, false);
});

test("undo controls use factual payment links after a plan schedule changes", () => {
  const dates = paidPlannedPaymentUndoOccurrences({
    recurrence: "monthly",
    due_day: 25,
    paid_occurrence_dates: ["2026-07-08", "2026-07-15"],
    paid_occurrences: {
      "2026-07-08": { expense_id: 10 },
      "2026-07-15": { expense_id: 11 }
    }
  });

  assert.deepEqual(dates, ["2026-07-08", "2026-07-15"]);
});
