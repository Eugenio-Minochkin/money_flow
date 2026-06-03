import test from "node:test";
import assert from "node:assert/strict";

import { createTranslator, translations } from "../src/i18n.js";

test("Mini App translations cover dashboard, plan, history and settings labels", () => {
  const requiredKeys = [
    "actions.add",
    "actions.close",
    "actions.delete",
    "actions.edit",
    "actions.find",
    "actions.pay",
    "dashboard.safeToday",
    "dashboard.afterBudgetAndPlanned",
    "dashboard.today",
    "dashboard.week",
    "dashboard.remaining",
    "dashboard.month",
    "history.latestExpenses",
    "history.search",
    "plan.monthTitle",
    "plan.nextPlanned",
    "plan.todayDue",
    "plan.plannedExpenses",
    "settings.title",
    "settings.formNote",
    "settings.weeklyBudgetPlaceholder",
    "settings.budgetAdvice",
    "settings.budgetAdviceHint",
    "budgetAdvice.title",
    "budgetAdvice.warnText",
    "budgetAdvice.dangerText"
  ];

  for (const language of ["ru", "en"]) {
    for (const key of requiredKeys) {
      assert.notEqual(translations[language][key], undefined, `${language}.${key}`);
    }
  }
});

test("translator falls back to English and formats count labels", () => {
  assert.equal(createTranslator("ru")("actions.pay"), "Оплатить");
  assert.equal(createTranslator("en")("actions.pay"), "Pay");
  assert.equal(createTranslator("unknown")("actions.pay"), "Pay");
  assert.equal(createTranslator("en")("history.inboxCount", { count: 2 }), "Needs review: 2");
});
