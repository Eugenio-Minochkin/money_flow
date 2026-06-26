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
    "dashboard.safeToSpendPerDay",
    "dashboard.todayRemaining",
    "dashboard.todayOverrun",
    "dashboard.todayCaption",
    "dashboard.dayBudget",
    "dashboard.afterBudgetAndPlanned",
    "dashboard.untilMonthEnd",
    "dashboard.plannedAhead",
    "dashboard.plannedAheadCaption",
    "dashboard.noPlannedAhead",
    "dashboard.freeAfterPlanned",
    "dashboard.freeAfterPlannedAndReserve",
    "dashboard.reserveIncluded",
    "dashboard.spent",
    "dashboard.available",
    "dashboard.explain",
    "dashboard.tooltip.monthFree.title",
    "dashboard.tooltip.monthFree.body",
    "dashboard.tooltip.planned.title",
    "dashboard.tooltip.planned.body",
    "dashboard.tooltip.month.title",
    "dashboard.tooltip.month.body",
    "dashboard.tooltip.heroToday.title",
    "dashboard.tooltip.heroToday.body",
    "dashboard.tooltip.week.title",
    "dashboard.tooltip.week.body",
    "dashboard.week",
    "dashboard.month",
    "history.latestExpenses",
    "history.search",
    "history.choosePeriod",
    "history.closePeriod",
    "history.previousMonthAction",
    "history.nextMonthAction",
    "history.selectedPeriod",
    "plan.monthTitle",
    "plan.nextPlanned",
    "plan.todayDue",
    "plan.plannedExpenses",
    "settings.title",
    "settings.formNote",
    "settings.currentMonthBudget",
    "settings.currentMonthBudgetHint",
    "settings.editCurrentMonthBudget",
    "settings.weeklyBudgetPlaceholder",
    "settings.budgetAdvice",
    "settings.budgetAdviceHint",
    "settings.interfaceTheme",
    "settings.timezone",
    "settings.detectTimezone",
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

test("settings translations distinguish regular and current month budgets", () => {
  assert.equal(createTranslator("ru")("settings.editCurrentMonthBudget"), "Изменить бюджет на этот месяц");
  assert.equal(createTranslator("en")("settings.editCurrentMonthBudget"), "Edit this month’s budget");
  assert.equal(createTranslator("en")("settings.currentMonthBudgetHint"), "Only changes the limit for the current month. Your regular monthly budget will not change.");
});

test("dashboard labels use the semantic cleanup vocabulary", () => {
  assert.equal(createTranslator("ru")("dashboard.todayRemaining"), "Осталось сегодня");
  assert.equal(createTranslator("ru")("dashboard.untilMonthEnd"), "До конца месяца");
  assert.equal(createTranslator("ru")("dashboard.todayCaption", { spent: "676 THB", budget: "397 THB" }), "потрачено 676 THB · бюджет дня 397 THB");
  assert.equal(createTranslator("en")("dashboard.todayRemaining"), "Left today");
  assert.equal(createTranslator("en")("dashboard.untilMonthEnd"), "Until month-end");
  assert.equal(createTranslator("en")("dashboard.todayCaption", { spent: "676 THB", budget: "397 THB" }), "spent 676 THB · day budget 397 THB");
});

test("dashboard tooltip translations interpolate placeholders and split title/body", () => {
  assert.equal(
    createTranslator("ru")("dashboard.tooltip.month.title", {
      remaining: "2 327 THB",
      budget: "48 000 THB",
      spent: "45 673 THB"
    }),
    "Сколько осталось от общего бюджета месяца: 2 327 THB из 48 000 THB (потрачено 45 673 THB)."
  );
  assert.equal(
    createTranslator("en")("dashboard.tooltip.month.title", {
      remaining: "2,327 THB",
      budget: "48,000 THB",
      spent: "45,673 THB"
    }),
    "What's left of your monthly budget: 2,327 THB of 48,000 THB (45,673 THB spent)."
  );
  assert.equal(
    createTranslator("en")("dashboard.tooltip.week.body", {
      weeklyPace: "7,326 THB",
      monthlyAllowance: "1,570 THB"
    }),
    "Your weekly pace says 7,326 THB; the month only allows 1,570 THB, so we take the smaller one. One generous week won't leave you broke by month-end."
  );
  assert.match(createTranslator("ru")("dashboard.tooltip.monthFree.title"), /реально можно распоряжаться/i);
  assert.match(createTranslator("ru")("dashboard.tooltip.heroToday.body"), /плановые уже отложены/i);
  assert.match(createTranslator("en")("dashboard.tooltip.heroToday.body"), /planned bills already set aside/i);
});

test("translator falls back to English and formats count labels", () => {
  assert.equal(createTranslator("ru")("actions.pay"), "Оплатить");
  assert.equal(createTranslator("en")("actions.pay"), "Pay");
  assert.equal(createTranslator("unknown")("actions.pay"), "Pay");
  assert.equal(createTranslator("en")("history.inboxCount", { count: 2 }), "Needs review: 2");
});

test("translations cover budget reserve states and actions", () => {
  for (const language of ["ru", "en"]) {
    assert.notEqual(translations[language]["reserve.saved"], undefined);
    assert.notEqual(translations[language]["reserve.atRisk"], undefined);
    assert.notEqual(translations[language]["reserve.usedUp"], undefined);
    assert.notEqual(translations[language]["reserve.blocked"], undefined);
    assert.notEqual(translations[language]["reserve.validationError"], undefined);
  }
});

test("saved expenses heading is translated for both languages", () => {
  assert.equal(createTranslator("ru")("history.savedExpenses"), "Записанные расходы");
  assert.equal(createTranslator("en")("history.savedExpenses"), "Saved expenses");
});

test("draft confirm flow keys are translated for both languages", () => {
  const draftConfirmKeys = [
    "actions.saveChanges",
    "actions.cancelDraft",
    "confirmations.closeWithoutSaving",
    "toast.draftConflict",
    "toast.alreadySaved"
  ];

  for (const language of ["ru", "en"]) {
    for (const key of draftConfirmKeys) {
      const value = createTranslator(language)(key);
      assert.equal(typeof value, "string", `${language}.${key} should be a string`);
      assert.ok(value.length > 0, `${language}.${key} should be a non-empty string`);
      assert.notEqual(translations[language][key], undefined, `${language}.${key} should be defined in translations map`);
    }
  }
});
