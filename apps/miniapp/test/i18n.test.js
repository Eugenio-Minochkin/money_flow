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
    "dashboard.limitPrefix",
    "dashboard.leftTodayPrefix",
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
    "settings.interfaceTheme",
    "settings.themeDark",
    "settings.themeLight",
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

test("settings translations cover interface themes", () => {
  assert.equal(createTranslator("ru")("settings.interfaceTheme"), "Тема интерфейса");
  assert.equal(createTranslator("ru")("settings.themeDark"), "Темная");
  assert.equal(createTranslator("ru")("settings.themeLight"), "Светлая");
  assert.equal(createTranslator("en")("settings.interfaceTheme"), "Interface theme");
  assert.equal(createTranslator("en")("settings.themeDark"), "Dark");
  assert.equal(createTranslator("en")("settings.themeLight"), "Light");
});

test("dashboard labels distinguish today's limit from daily budget", () => {
  assert.equal(createTranslator("ru")("dashboard.limitPrefix"), "лимит");
  assert.equal(createTranslator("ru")("dashboard.leftTodayPrefix"), "можно еще");
  assert.equal(createTranslator("en")("dashboard.limitPrefix"), "limit");
  assert.equal(createTranslator("en")("dashboard.leftTodayPrefix"), "left today");
});

test("translator falls back to English and formats count labels", () => {
  assert.equal(createTranslator("ru")("actions.pay"), "Оплатить");
  assert.equal(createTranslator("en")("actions.pay"), "Pay");
  assert.equal(createTranslator("unknown")("actions.pay"), "Pay");
  assert.equal(createTranslator("en")("history.inboxCount", { count: 2 }), "Needs review: 2");
});
