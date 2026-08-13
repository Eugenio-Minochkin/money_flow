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
    "forms.additional",
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
    "dashboard.tooltip.heroTodayOnTrack",
    "dashboard.tooltip.heroTodayOverspend",
    "dashboard.tooltip.monthFree",
    "dashboard.tooltip.planned",
    "dashboard.tooltip.month",
    "dashboard.tooltip.week",
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
    "plan.statusPaid",
    "plan.statusUnpaid",
    "plan.statusOverdue",
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
    "budgetAdvice.dangerText",
    "budgetTopup.title",
    "budgetTopup.baseBudget",
    "budgetTopup.baseShort",
    "budgetTopup.topups",
    "budgetTopup.topupsShort",
    "budgetTopup.totalBudget",
    "budgetTopup.total",
    "budgetTopup.details",
    "budgetTopup.collapse",
    "budgetTopup.historyTitle",
    "budgetTopup.recent",
    "budgetTopup.empty",
    "budgetTopup.historyItem",
    "budgetTopup.historyItemCompact"
  ];

  for (const language of ["ru", "en"]) {
    for (const key of requiredKeys) {
      assert.notEqual(translations[language][key], undefined, `${language}.${key}`);
    }
  }
});

test("planned disable UX keys stay in parity for Russian and English", () => {
  const keys = [
    "plannedDisable.confirmation",
    "plannedDisable.resultTitle",
    "plannedDisable.paidOne",
    "plannedDisable.paidFew",
    "plannedDisable.paidMany",
    "plannedDisable.unpaidOne",
    "plannedDisable.unpaidFew",
    "plannedDisable.unpaidMany",
    "plannedDisable.monthUpdated",
    "plannedDisable.dayUnchanged"
  ];

  for (const language of ["ru", "en"]) {
    for (const key of keys) {
      assert.equal(typeof translations[language][key], "string", `${language}.${key}`);
      assert.ok(translations[language][key].length > 0, `${language}.${key} must not be empty`);
    }
  }
});

test("planned archive and recreate UX keys stay in parity for Russian and English", () => {
  const keys = [
    "plan.archiveTitle",
    "plan.archiveLoading",
    "plan.archiveEmpty",
    "plan.archiveError",
    "plan.archiveRetry",
    "plan.archiveDateUnavailable",
    "plan.archivePaymentOne",
    "plan.archivePaymentFew",
    "plan.archivePaymentMany",
    "plan.createAgain",
    "plan.startsOn",
    "toast.plannedRecreated",
    "toast.plannedRefreshWarning"
  ];

  for (const language of ["ru", "en"]) {
    for (const key of keys) assert.equal(typeof translations[language][key], "string", `${language}.${key}`);
  }
});

test("plan and reserve explanation keys stay in parity for Russian and English", () => {
  const keys = [
    "plan.summaryTitle",
    "plan.infoLabel",
    "plan.infoPlannedTitle",
    "plan.infoPlannedBody",
    "plan.infoReserveTitle",
    "plan.infoReserveBody",
    "plan.moreActions",
    "reserve.notSet",
    "reserve.explanation",
    "reserve.thisMonth",
    "reserve.everyMonth"
  ];

  for (const language of ["ru", "en"]) {
    for (const key of keys) assert.equal(typeof translations[language][key], "string", `${language}.${key}`);
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
  assert.equal(createTranslator("ru")("dashboard.hero.safeToday"), "Можно потратить сегодня");
  assert.equal(createTranslator("en")("dashboard.hero.safeToday"), "Safe to spend today");
  assert.equal(createTranslator("ru")("dashboard.hero.dayOverrun"), "Сегодня выше ориентира");
  assert.equal(createTranslator("en")("dashboard.hero.dayOverrun"), "Today’s spending is above target");
  assert.equal(createTranslator("ru")("dashboard.hero.freeDeficit"), "После плановых оплат не хватит");
  assert.equal(createTranslator("en")("dashboard.hero.freeDeficit"), "You’ll be short after scheduled payments");
  assert.equal(createTranslator("ru")("dashboard.hero.why"), "Как посчитано?");
  assert.equal(createTranslator("en")("dashboard.hero.why"), "How is this calculated?");
  assert.equal(createTranslator("ru")("dashboard.hero.calculationTitle"), "Как посчитано?");
  assert.equal(createTranslator("en")("dashboard.hero.calculationTitle"), "How is this calculated?");
  assert.equal(createTranslator("ru")("dashboard.untilMonthEnd"), "До конца месяца");
  assert.equal(createTranslator("en")("dashboard.untilMonthEnd"), "Rest of the month");
  assert.equal(createTranslator("ru")("dashboard.budgetPlan"), "Бюджет и план");
  assert.equal(createTranslator("en")("dashboard.budgetPlan"), "Budget & plan");
  assert.equal(createTranslator("ru")("actions.showAll"), "Вся история");
  assert.equal(createTranslator("en")("actions.showAll"), "View history");
  assert.equal(createTranslator("ru")("history.latestExpenses"), "Последние расходы");
  assert.equal(createTranslator("en")("history.latestExpenses"), "Recent expenses");
  assert.equal(createTranslator("en")("dashboard.categoriesAndTags"), "Categories & tags");
  assert.equal(createTranslator("en")("dashboard.activityByDay"), "Daily activity");
  assert.equal(createTranslator("ru")("dashboard.weekPlanExceeded"), "Недельный план превышен");
  assert.equal(createTranslator("en")("dashboard.weekPlanExceeded"), "Weekly plan exceeded");
  assert.equal(createTranslator("ru")("dashboard.tooltip.week"), "Сколько осталось от недельного бюджета с учётом расходов этой недели.");
  assert.equal(createTranslator("en")("dashboard.tooltip.week"), "How much remains from this week’s budget after this week’s spending.");
  assert.equal(createTranslator("ru")("dashboard.hero.freeDeficitWithReserve"), "После плановых оплат и резерва не хватит");
  assert.equal(createTranslator("en")("dashboard.hero.freeDeficitWithReserve"), "You’ll be short after scheduled payments and reserves");
});

test("new dashboard copy exists in both locales with no cross-language fallback", () => {
  const keys = [
    "dashboard.hero.calculationTitle",
    "dashboard.hero.monthBudget",
    "dashboard.hero.topups",
    "dashboard.hero.spentSoFar",
    "dashboard.hero.planned",
    "dashboard.hero.reserve",
    "dashboard.hero.free",
    "dashboard.hero.shortAfterPlanned",
    "dashboard.hero.shortAfterPlannedAndReserve",
    "dashboard.hero.dayPlan",
    "dashboard.hero.zeroTargetExplanation",
    "dashboard.weekPlanExceeded",
    "actions.showAll",
    "history.latestExpenses",
    "screen.dashboard",
    "screen.history",
    "screen.plan",
    "screen.settings"
  ];

  for (const key of keys) {
    assert.equal(typeof translations.ru[key], "string", `ru.${key}`);
    assert.equal(typeof translations.en[key], "string", `en.${key}`);
    assert.notEqual(translations.ru[key], translations.en[key], key);
    assert.doesNotMatch(translations.en[key], /[А-Яа-яЁё]/u, `en.${key}`);
  }
});

test("dashboard tooltip translations are short hints without numeric formulas", () => {
  assert.equal(
    createTranslator("ru")("dashboard.tooltip.month"),
    "Остаток общего бюджета месяца. Плановые, которые ещё не оплачены, здесь не вычтены."
  );
  assert.equal(
    createTranslator("en")("dashboard.tooltip.month"),
    "Total monthly budget left. Planned payments not paid yet are not deducted here."
  );
  for (const language of ["ru", "en"]) {
    const t = createTranslator(language);
    for (const key of [
      "dashboard.tooltip.heroTodayOnTrack",
      "dashboard.tooltip.heroTodayOverspend",
      "dashboard.tooltip.monthFree",
      "dashboard.tooltip.planned",
      "dashboard.tooltip.month",
      "dashboard.tooltip.week"
    ]) {
      assert.doesNotMatch(t(key), /\{/, `${language}.${key} must not keep a raw placeholder`);
    }
  }
  assert.match(createTranslator("ru")("dashboard.tooltip.monthFree"), /реально можно распоряжаться/i);
  assert.match(createTranslator("ru")("dashboard.tooltip.heroTodayOnTrack"), /Плановые оплаты уже вычтены/i);
  assert.match(createTranslator("en")("dashboard.tooltip.heroTodayOverspend"), /already deducted/i);
  assert.equal(translations.ru["dashboard.monthBudgetExhausted"], undefined);
  assert.equal(translations.en["dashboard.monthBudgetExhausted"], undefined);
  assert.equal(translations.ru["dashboard.tooltip.weekMonthBinding"], undefined);
  assert.equal(translations.en["dashboard.tooltip.weekMonthBinding"], undefined);
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
