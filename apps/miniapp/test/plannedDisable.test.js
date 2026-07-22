import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPlannedDisableConfirmation,
  buildPlannedDisableResult,
  runPlannedDisable
} from "../src/plannedDisable.js";
import { formatMoney } from "../src/formatters.js";
import { createTranslator } from "../src/i18n.js";

const item = { id: 7, description: "English" };
const impact = {
  paidOccurrencesKept: 2,
  paidAmountKept: 2000,
  unpaidOccurrencesRemoved: 3,
  unpaidAmountRemoved: 3000,
  currency: "THB"
};

test("builds the exact Russian disable confirmation and result", () => {
  const translate = createTranslator("ru");

  assert.equal(
    buildPlannedDisableConfirmation(item, { translate }),
    "Отключить «English»?\n\nОплаченные занятия останутся в истории.\nНеоплаченные больше не будут учитываться в плане месяца."
  );
  assert.equal(
    buildPlannedDisableResult(item, impact, { language: "ru", translate, formatMoney }),
    "English отключён.\n\n2 оплаты на 2 000 THB сохранены.\n3 будущие оплаты на 3 000 THB больше не учитываются.\n\nПлан месяца обновлён.\nСегодняшний бюджет дня не изменился."
  );
});

test("builds the exact English disable confirmation and result", () => {
  const translate = createTranslator("en");

  assert.equal(
    buildPlannedDisableConfirmation(item, { translate }),
    "Disable “English”?\n\nPaid sessions will remain in your history.\nUnpaid sessions will no longer be included in the monthly plan."
  );
  assert.equal(
    buildPlannedDisableResult(item, impact, { language: "en", translate, formatMoney }),
    "English was disabled.\n\n2 payments totaling THB 2,000 were kept.\n3 upcoming payments totaling THB 3,000 are no longer reserved.\n\nThe monthly plan has been updated.\nToday's budget remains unchanged."
  );
});

test("returns before disabling when confirmation is cancelled", async () => {
  const button = { disabled: false, isConnected: true };
  let requests = 0;

  const result = await runPlannedDisable({
    button,
    item,
    confirm: () => false,
    disableRequest: async () => { requests += 1; },
    loadDashboard: async () => {},
    showResult: () => {},
    language: "en",
    translate: createTranslator("en"),
    formatMoney
  });

  assert.deepEqual(result, { status: "cancelled" });
  assert.equal(requests, 0);
  assert.equal(button.disabled, false);
});

test("returns before confirmation and DELETE when the button is already busy", async () => {
  const button = { disabled: false, busy: true, isConnected: true };

  const result = await runPlannedDisable({
    button,
    item,
    confirm: () => assert.fail("busy actions must not confirm"),
    disableRequest: async () => assert.fail("busy actions must not request"),
    loadDashboard: async () => {},
    showResult: () => {},
    language: "en",
    translate: createTranslator("en"),
    formatMoney
  });

  assert.deepEqual(result, { status: "busy" });
});

test("locks before DELETE, ignores a double tap, and refreshes before showing backend impact", async () => {
  const events = [];
  const button = { disabled: false, isConnected: true };
  let requests = 0;
  let releaseRequest;
  const requestGate = new Promise((resolve) => { releaseRequest = resolve; });

  const dependencies = {
    button,
    item,
    confirm: () => { events.push("confirm"); return true; },
    disableRequest: async () => {
      assert.equal(button.disabled, true);
      requests += 1;
      events.push("disable");
      await requestGate;
      return { plannedExpense: { ...item, active: false }, impact };
    },
    loadDashboard: async () => { events.push("loadDashboard"); },
    showResult: (message) => {
      events.push("showResult");
      assert.match(message, /2 payments totaling THB 2,000 were kept/);
      assert.match(message, /3 upcoming payments totaling THB 3,000/);
    },
    language: "en",
    translate: createTranslator("en"),
    formatMoney
  };

  const first = runPlannedDisable(dependencies);
  assert.equal(button.disabled, true);
  assert.deepEqual(await runPlannedDisable(dependencies), { status: "busy" });
  assert.equal(requests, 1);

  releaseRequest();
  const result = await first;

  assert.equal(result.status, "disabled");
  assert.equal(button.disabled, false);
  assert.deepEqual(events, ["confirm", "disable", "loadDashboard", "showResult"]);
});

test("propagates request errors, restores a connected button, and never shows success", async () => {
  const button = { disabled: false, isConnected: true };
  let resultMessages = 0;
  const failure = new Error("network_failed");

  await assert.rejects(
    runPlannedDisable({
      button,
      item,
      confirm: () => true,
      disableRequest: async () => { throw failure; },
      loadDashboard: async () => assert.fail("dashboard must not load after failed DELETE"),
      showResult: () => { resultMessages += 1; },
      language: "ru",
      translate: createTranslator("ru"),
      formatMoney
    }),
    failure
  );

  assert.equal(button.disabled, false);
  assert.equal(resultMessages, 0);
});

test("does not mutate a detached button after a successful dashboard rerender", async () => {
  const button = { disabled: false, isConnected: true };

  await runPlannedDisable({
    button,
    item,
    confirm: () => true,
    disableRequest: async () => ({ plannedExpense: { ...item, active: false }, impact }),
    loadDashboard: async () => { button.isConnected = false; },
    showResult: () => {},
    language: "en",
    translate: createTranslator("en"),
    formatMoney
  });

  assert.equal(button.disabled, true);
});

test("keeps one language when the interface changes while disable is pending", async () => {
  const button = { disabled: false, isConnected: true };
  let activeTranslate = createTranslator("ru");
  let releaseRequest;
  let shownMessage = "";
  const requestGate = new Promise((resolve) => { releaseRequest = resolve; });

  const pending = runPlannedDisable({
    button,
    item,
    confirm: (message) => {
      assert.match(message, /^Отключить/);
      return true;
    },
    disableRequest: async () => {
      await requestGate;
      return { plannedExpense: { ...item, active: false }, impact };
    },
    loadDashboard: async () => {},
    showResult: (message) => { shownMessage = message; },
    language: "ru",
    translate: (...args) => activeTranslate(...args),
    createTranslator,
    formatMoney
  });

  activeTranslate = createTranslator("en");
  releaseRequest();
  await pending;

  assert.equal(
    shownMessage,
    "English отключён.\n\n2 оплаты на 2 000 THB сохранены.\n3 будущие оплаты на 3 000 THB больше не учитываются.\n\nПлан месяца обновлён.\nСегодняшний бюджет дня не изменился."
  );
});
