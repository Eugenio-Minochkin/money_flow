import test from "node:test";
import assert from "node:assert/strict";

import {
  formatBudgetTopupDraft,
  formatBudgetTopupSuccess,
  formatBudgetTopupUndoSuccess,
  formatDraft,
  formatReserveClosedEvent,
  formatSavedSummary,
  formatTotals,
  formatWeeklyReport
} from "../src/telegramFormat.js";
import { categoryName } from "../../../packages/shared/src/categories.js";
import { SUPPORTED_CURRENCY_CODES } from "../../../packages/shared/src/currencies.js";

test("shows mixed-currency draft subtotals with an unavailable-total warning", () => {
  const text = normalizeSpaces(formatDraft(mixedCurrencyExpenses(), {
    language: "en",
    baseCurrency: "USD"
  }));

  assert.doesNotMatch(text, /152,000 USD/);
  assert.match(text, /127,000 IDR \+ 25,000 RUB/);
  assert.match(text, /A reliable total in USD is unavailable\. Amounts are shown by currency\./);
});

test("shows a converted mixed-currency draft preview in the selected locale", () => {
  const options = {
    baseCurrency: "GEL",
    preview: { kind: "converted", baseCurrency: "GEL", total: 245.5 }
  };

  assert.match(formatDraft(mixedCurrencyExpenses(), { ...options, language: "ru" }), /245,50 GEL/);
  assert.match(formatDraft(mixedCurrencyExpenses(), { ...options, language: "en" }), /245\.50 GEL/);
});

test("never labels a raw mixed-currency numeric sum as any base currency without a preview", () => {
  for (const baseCurrency of SUPPORTED_CURRENCY_CODES) {
    for (const firstCurrency of SUPPORTED_CURRENCY_CODES) {
      for (const secondCurrency of SUPPORTED_CURRENCY_CODES) {
        if (firstCurrency === secondCurrency) continue;
        const text = normalizeSpaces(formatDraft([
          draftExpense(127000, firstCurrency),
          draftExpense(25000, secondCurrency)
        ], { language: "en", baseCurrency }));

        assert.doesNotMatch(text, new RegExp(`152,000(?:\\.00)? ${baseCurrency}`), `${firstCurrency} + ${secondCurrency} as ${baseCurrency}`);
        assert.match(text, new RegExp(`\\b${firstCurrency}\\b`));
        assert.match(text, new RegExp(`\\b${secondCurrency}\\b`));
      }
    }
  }
});

test("does not reduce mixed-currency amounts before grouping their subtotals", () => {
  const conversions = { count: 0 };
  const text = formatDraft([
    draftExpense(countedAmount(127000, conversions), "IDR"),
    draftExpense(countedAmount(25000, conversions), "RUB")
  ], { language: "en", baseCurrency: "USD" });

  assert.match(text, /127,000 IDR \+ 25,000 RUB/);
  assert.ok(conversions.count < 6, "mixed drafts must not perform an extra raw-total reduction");
});

test("marks overflowed draft totals unavailable instead of rendering them as zero", () => {
  const mixed = formatDraft([
    draftExpense(1e308, "USD"),
    draftExpense(1e308, "USD"),
    draftExpense(100, "RUB")
  ], { language: "en", baseCurrency: "USD" });
  const singleCurrency = formatDraft([
    draftExpense(1e308, "USD"),
    draftExpense(1e308, "USD")
  ], { language: "en", baseCurrency: "USD" });

  assert.match(mixed, /unavailable USD \+ 100 RUB/);
  assert.match(mixed, /A reliable total in USD is unavailable/);
  assert.doesNotMatch(mixed, /<b>Total:<\/b> 0\.00 USD/);
  assert.match(singleCurrency, /<b>Total:<\/b> unavailable USD/);
  assert.doesNotMatch(singleCurrency, /<b>Total:<\/b> 0\.00 USD/);
});

test("guides a single unresolved draft expense to choose a category", () => {
  const text = formatDraft([
    {
      amount: 70,
      currency: "THB",
      description: "coffee",
      category_slug: "other",
      spent_at: "2026-06-02T09:30:00+07:00",
      needs_review: true
    }
  ]);

  assert.match(text, /coffee/);
  assert.match(text, /02 июн|Jun 02/);
  assert.match(text, /70 THB/);
  assert.match(text, /<b>/);
  assert.match(text, /Не уверен в категории\./);
  assert.match(text, /Выбери подходящую ниже\. Если неверны название или сумма — нажми «Исправить»\./);
  assert.doesNotMatch(text, /Есть сомнительные строки/);
});

test("guides multiple reviewable draft expenses to edit before saving", () => {
  const text = formatDraft([
    { amount: 70, currency: "THB", description: "coffee", category_slug: "other", needs_review: true },
    { amount: 90, currency: "THB", description: "ride", category_slug: "transport", needs_review: true }
  ], { language: "en" });

  assert.match(text, /I may have misunderstood some expenses\./);
  assert.match(text, /Tap “Edit” and review them before saving\./);
});

test("does not show a review warning for a confident draft expense", () => {
  const text = formatDraft([
    { amount: 70, currency: "THB", description: "coffee", category_slug: "food_cafe", needs_review: false }
  ], { language: "en" });

  assert.doesNotMatch(text, /Not sure about the category|misunderstood some expenses/);
});

test("explains the selected budget treatment for a single draft expense", () => {
  const regular = formatDraft([{
    amount: 120,
    currency: "THB",
    description: "coffee",
    category_slug: "food_cafe",
    spent_at: "2026-07-12T12:30:00.000Z",
    budget_impact: "regular"
  }], { language: "ru" });
  const large = formatDraft([{
    amount: 120,
    currency: "THB",
    description: "coffee",
    category_slug: "food_cafe",
    spent_at: "2026-07-12T12:30:00.000Z",
    budget_impact: "large_oneoff"
  }], { language: "en" });

  assert.match(regular, /Как учесть расход/);
  assert.match(regular, /Учесть сегодня/);
  assert.match(large, /How should this expense affect the budget/);
  assert.match(large, /Spread across remaining days/);
});

test("formats draft dates in Bangkok timezone", () => {
  const text = formatDraft([{
    amount: 40000,
    currency: "IDR",
    description: "Shopee",
    category_slug: "other",
    spent_at: "2026-05-31T17:00:00.000Z",
    needs_review: false
  }], { language: "ru" });

  assert.match(text, /01 июн|01 Ð¸ÑŽÐ½/);
  assert.doesNotMatch(text, /31 мая|31 Ð¼Ð°Ñ/);
});


test("formats draft budget impact markers for planned and large expenses", () => {
  const text = formatDraft([
    {
      amount: 70,
      currency: "THB",
      description: "coffee",
      category_slug: "food_cafe",
      spent_at: "2026-06-02T09:30:00+07:00",
      budget_impact: "regular"
    },
    {
      amount: 1000,
      currency: "THB",
      description: "rent",
      category_slug: "home",
      spent_at: "2026-06-02T09:30:00+07:00",
      budget_impact: "planned"
    },
    {
      amount: 5000,
      currency: "THB",
      description: "phone",
      category_slug: "other",
      spent_at: "2026-06-02T09:30:00+07:00",
      budget_impact: "large_oneoff"
    }
  ], { language: "ru" });

  assert.match(text, /🧾 Плановая/);
  assert.match(text, /📦 Крупная/);
});

test("formats saved summary with budget context", () => {
  const text = formatSavedSummary(75, {
    ...snapshot(),
    recoveryAdvice: {
      active: true,
      state: "warn",
      requiredPerDay: 675,
      forecastOverBudget: 18000
    }
  });
  const normalized = normalizeSpaces(text);

  assert.match(text, /75 THB/);
  assert.match(text, /Обычные/);
  assert.match(normalized, /Обычные: <b>75 THB \/ 1 475 THB<\/b>/);
  assert.match(normalized, /Осталось: <b>1 400 THB<\/b>/);
  assert.match(normalized, /735 THB \/ 42 000 THB/);
  assert.match(text, /1,75%/);
  assert.match(text, /── <b>Сегодня<\/b> ──/);
  assert.match(text, /── <b>Месяц<\/b> ──/);
  assert.match(text, /── <b>Прогноз<\/b> ──/);
  assert.doesNotMatch(text, /Плановые сегодня/);
  assert.doesNotMatch(text, /Крупные сегодня/);
  assert.doesNotMatch(text, /Всего за день/);
  assert.match(text, /Вернуться в бюджет/);
  assert.match(text, /675 THB/);
});

test("formats a saved expense without dashboard figures when its snapshot is unavailable", () => {
  const text = formatSavedSummary(80, null, {
    language: "en",
    expenses: [{ amount_original: 80, currency_original: "THB", category_slug: "food_cafe", description: "coffee" }]
  });

  assert.match(text, /<b>Saved:<\/b>/);
  assert.match(text, /coffee/);
  assert.match(text, /Budget summary is temporarily unavailable\./);
  assert.doesNotMatch(text, /<b>Today<\/b>|<b>Month<\/b>|Forecast|Remaining/);
});

test("formats saved summary with the fixed daily budget and saved expense details", () => {
  const text = formatSavedSummary(10, {
    ...snapshot(),
    today: 10,
    dayPlanLimit: 427,
    dayRemaining: 417,
    dayOverrun: 0,
    plannedToday: 1000,
    largeToday: 0
  }, {
    language: "ru",
    expenses: [{
      amount: 10,
      currency: "THB",
      amount_original: 10,
      currency_original: "THB",
      description: "Молоко",
      category_slug: "groceries"
    }]
  });
  const normalized = normalizeSpaces(text);

  assert.match(normalized, /Обычные: <b>10 THB \/ 427 THB<\/b>/);
  assert.match(normalized, /Осталось: <b>417 THB<\/b>/);
  assert.doesNotMatch(normalized, /1 600 THB/);
  assert.doesNotMatch(normalized, /1 590 THB/);
  assert.match(normalized, /🏷️ Продукты · <b>Молоко<\/b> — <b>10 THB<\/b>/);
});

test("formats saved summary month plan delta from forecast minus monthly budget", () => {
  const text = formatSavedSummary(10, {
    ...snapshot(),
    month: 44035,
    monthlyBudget: 48000,
    freeRemaining: 2987,
    plannedRemaining: 977,
    budgetProgressPercent: 91.74,
    forecastMonthTotal: 49699,
    planDeviation: 5635
  }, { language: "ru" });
  const normalized = normalizeSpaces(text);

  assert.match(normalized, /49 699 THB/);
  assert.match(normalized, /1 699 THB/);
  assert.doesNotMatch(normalized, /5 635 THB/);
});

test("saved summary month block separates reserved planned and free money after planned (ru)", () => {
  // Production snapshot fields drive the displayed amounts; no formula is recomputed here.
  // Sanity math: 51000 − 46691 − 3273 = 1036  and  55453 − 51000 = 4453.
  const text = formatSavedSummary(10, {
    month: 46691,
    monthlyBudget: 51000,
    plannedRemaining: 3273,
    freeRemaining: 1036,
    budgetProgressPercent: 91.55,
    forecastMonthTotal: 55453,
    recoveryAdvice: {
      active: true,
      state: "warn",
      requiredPerDay: 130,
      forecastOverBudget: 4453
    }
  }, { language: "ru" });
  const normalized = normalizeSpaces(text);

  assert.match(normalized, /46 691 THB \/ 51 000 THB \(91,55%\)/);
  assert.match(normalized, /В резерве на плановые:<\/b> 3 273 THB/);
  assert.match(normalized, /🟢 <b>Свободно после плановых:<\/b> <b>1 036 THB<\/b>/);
  assert.match(normalized, /\n\n── <b>Прогноз<\/b> ──\nОжидаемые траты: <b>55 453 THB<\/b>\n⚠️ Выше бюджета на <b>4 453 THB<\/b>/);

  // The free amount is no longer shown under the ambiguous bare "Осталось" label.
  assert.doesNotMatch(normalized, /Осталось: <b>1 036 THB<\/b>/);

  // Order: spent, reserved planned, then free after planned.
  assert.ok(
    normalized.indexOf("В резерве на плановые") < normalized.indexOf("Свободно после плановых"),
    "reserved planned must appear before free after planned"
  );

  // Recovery advice must refer to ordinary (regular) spending.
  assert.match(normalized, /Вернуться в бюджет:<\/b> прогноз выше бюджета на 4 453 THB/);
  assert.match(normalized, /Чтобы уложиться в бюджет, держи обычные расходы в пределах <b>130 THB\/день<\/b>/);
});

test("saved summary month block separates reserved planned and free money after planned (en)", () => {
  const text = formatSavedSummary(10, {
    month: 46691,
    monthlyBudget: 51000,
    plannedRemaining: 3273,
    freeRemaining: 1036,
    budgetProgressPercent: 91.55,
    forecastMonthTotal: 55453,
    recoveryAdvice: {
      active: true,
      state: "warn",
      requiredPerDay: 130,
      forecastOverBudget: 4453
    }
  }, { language: "en" });
  const normalized = normalizeSpaces(text);

  assert.match(normalized, /46,691 THB \/ 51,000 THB \(91.55%\)/);
  assert.match(normalized, /Reserved for planned payments:<\/b> 3,273 THB/);
  assert.match(normalized, /🟢 <b>Free after planned payments:<\/b> <b>1,036 THB<\/b>/);
  assert.match(normalized, /\n\n── <b>Forecast<\/b> ──\nExpected spending: <b>55,453 THB<\/b>\n⚠️ Above budget by <b>4,453 THB<\/b>/);

  assert.ok(
    normalized.indexOf("Reserved for planned payments") < normalized.indexOf("Free after planned payments"),
    "reserved planned must appear before free after planned"
  );

  assert.match(normalized, /Get back on budget:<\/b> forecast is over budget by 4,453 THB/);
  assert.match(normalized, /To stay within budget, keep regular spending within <b>130 THB\/day<\/b>/);
});

test("saved summary month block shows a green below-budget forecast status line", () => {
  const text = formatSavedSummary(10, {
    ...snapshot(),
    monthlyBudget: 51000,
    forecastMonthTotal: 48000
  }, { language: "ru" });
  const normalized = normalizeSpaces(text);

  assert.match(normalized, /🟢 Ниже бюджета на <b>3 000 THB<\/b>/);
});

test("formats saved expense hierarchy without dangling separators for empty descriptions", () => {
  const text = formatSavedSummary(25, null, {
    language: "ru",
    expenses: [
      { amount_original: 10, currency_original: "THB", category_slug: "groceries", description: "Молоко" },
      { amount_original: 15, currency_original: "THB", category_slug: "food_cafe", description: "" }
    ]
  });

  assert.match(text, /1\. 🏷️ Продукты · <b>Молоко<\/b> — <b>10 THB<\/b>/);
  assert.match(text, /2\. 🏷️ Еда и кафе · <b>15 THB<\/b>/);
  assert.doesNotMatch(text, /<b>Продукты<\/b>|· —|<b><\/b>/);
});

test("saved summary marks negative free remaining red without changing displayed values", () => {
  const text = formatSavedSummary(10, {
    ...snapshot(),
    freeRemaining: -1470,
    forecastMonthTotal: 57470,
    monthlyBudget: 56000
  }, { language: "ru" });
  const normalized = normalizeSpaces(text);

  assert.match(normalized, /🔴 <b>Свободно после плановых:<\/b> <b>-1 470 THB<\/b>/);
  assert.match(normalized, /Ожидаемые траты: <b>57 470 THB<\/b>/);
  assert.match(normalized, /⚠️ Выше бюджета на <b>1 470 THB<\/b>/);
});

test("formats saved summary with planned and large daily aggregates", () => {
  const text = formatSavedSummary(80, {
    ...snapshot(),
    today: 802,
    dayPlanLimit: 1000,
    dayRemaining: 198,
    dayOverrun: 0,
    plannedToday: 1000,
    largeToday: 2000
  });
  const normalized = normalizeSpaces(text);

  assert.match(normalized, /Обычные: <b>802 THB \/ 1 000 THB<\/b>/);
  assert.match(normalized, /Плановые сегодня: <b>1 000 THB<\/b>/);
  assert.match(normalized, /Крупные сегодня: <b>2 000 THB<\/b>/);
  assert.match(normalized, /Всего за день: <b>3 802 THB<\/b>/);
});

test("saved summary hides a zero forecast deviation but preserves negative financial values", () => {
  const text = formatSavedSummary(80, {
    ...snapshot(),
    monthlyBudget: 123456789,
    forecastMonthTotal: 123456789,
    freeRemaining: -123456789,
    plannedToday: 0,
    largeToday: 0
  }, { language: "en" });
  const normalized = normalizeSpaces(text);

  assert.match(normalized, /-123,456,789 THB/);
  assert.doesNotMatch(normalized, /Planned today|Large today|Total today/);
  assert.doesNotMatch(normalized, /Above budget by|Below budget by/);
});

test("formats saved summary overrun when regular spend exceeds the day budget", () => {
  const text = formatSavedSummary(500, {
    ...snapshot(),
    today: 500,
    dayPlanLimit: 427,
    dayRemaining: 0,
    dayOverrun: 73
  }, { language: "ru" });
  const normalized = normalizeSpaces(text);

  assert.match(normalized, /Обычные: <b>500 THB \/ 427 THB<\/b>/);
  assert.match(normalized, /Перерасход: <b>73 THB<\/b>/);
});

test("formats command totals for month and budget", () => {
  assert.match(normalizeSpaces(formatTotals("/month", snapshot())), /735 THB \/ 42 000 THB/);
  assert.match(normalizeSpaces(formatTotals("/budget", snapshot())), /15 270 THB/);
});

test("budget command omits an empty planned reserve without hiding useful status", () => {
  const text = formatTotals("/budget", {
    ...snapshot(),
    plannedRemaining: 0
  }, { language: "en" });

  assert.doesNotMatch(text, /Planned:/);
  assert.match(text, /Remaining:/);
  assert.match(text, /Status:/);
});

test("formats reserve and available regular spending in budget command", () => {
  const text = normalizeSpaces(formatTotals("/budget", {
    ...snapshot(),
    availableRegular: 26000,
    reserve: {
      amount: 4000,
      savedAmount: 2800,
      eatenAmount: 1200,
      status: "partially_used"
    }
  }, { language: "en" }));

  assert.match(text, /Reserve at risk/);
  assert.match(text, /1,200 THB/);
  assert.match(text, /Available for regular spending/);
  assert.match(text, /26,000 THB/);
});

test("formats a partially used reserve close event in both languages", () => {
  const event = {
    currency: "THB",
    reserve_amount: 4000,
    saved_amount: 2800,
    eaten_amount: 1200,
    over_budget_amount: 0,
    status: "partially_used"
  };

  assert.match(normalizeSpaces(formatReserveClosedEvent(event, { language: "ru" })), /2 800 THB из 4 000 THB/);
  assert.match(formatReserveClosedEvent(event, { language: "en" }), /2,800 THB out of your 4,000 THB/);
});

test("formats money decimals by currency in Telegram UI", () => {
  assert.match(normalizeSpaces(formatDraft([{ amount: 8720.81, currency: "THB", description: "food", category_slug: "other" }])), /8 721 THB/);
  assert.match(normalizeSpaces(formatDraft([{ amount: 266.58, currency: "USD", description: "food", category_slug: "other" }], { language: "en" })), /266\.58 USD/);
  assert.match(normalizeSpaces(formatDraft([{ amount: 45.2, currency: "EUR", description: "food", category_slug: "other" }], { language: "en" })), /45\.20 EUR/);
  assert.match(normalizeSpaces(formatDraft([{ amount: 120.5, currency: "GEL", description: "food", category_slug: "other" }], { language: "en" })), /120\.50 GEL/);
});

test("formats budget top-up draft with compact title and large warning", () => {
  const normal = formatBudgetTopupDraft({
    amount: 200,
    currency: "USD",
    occurred_at: "2026-06-15T10:00:00Z"
  }, { language: "en", large: false });
  const large = formatBudgetTopupDraft({
    amount: 1000000,
    currency: "THB",
    occurred_at: "2026-06-15T10:00:00Z"
  }, { language: "en", large: true });

  assert.match(normal, /\u2795 <b>Budget top-up:<\/b>/);
  assert.match(normal, /\+200\.00 USD/);
  assert.match(normal, /Add it to your June budget\?/);
  assert.match(large, /\u26a0\ufe0f <b>Very large top-up:<\/b>/);
  assert.match(large, /\+1,000,000 THB/);
  assert.match(large, /Please check the amount/);
});

test("formats budget top-up success with budget context and undo hint", () => {
  const text = formatBudgetTopupSuccess({
    amount_original: 200,
    currency_original: "USD",
    amount_base: 7300,
    base_currency: "THB",
    kind: "salary"
  }, {
    baseCurrency: "THB",
    monthlyBudget: 55300,
    freeRemaining: 14000
  }, "en");
  const normalized = normalizeSpaces(text);

  assert.match(normalized, /\u2705 <b>Budget updated:<\/b>/);
  assert.match(normalized, /\+200\.00 USD/);
  assert.match(normalized, /Budget top-up/);
  assert.match(normalized, /In your budget currency, that is \+7,300 THB/);
  assert.match(normalized, /Monthly budget: <b>55,300 THB<\/b>/);
  assert.match(normalized, /Remaining: <b>14,000 THB<\/b>/);
  assert.match(normalized, /\u21a9\ufe0f You can undo this top-up for 10 minutes/);
});

test("formats budget top-up undo success with amount when available", () => {
  const text = formatBudgetTopupUndoSuccess({
    amount_original: 200,
    currency_original: "USD"
  }, {
    baseCurrency: "THB",
    monthlyBudget: 48000,
    freeRemaining: 9000
  }, "en");
  const normalized = normalizeSpaces(text);

  assert.match(normalized, /\u21a9\ufe0f <b>Top-up undone:<\/b>/);
  assert.match(normalized, /-200\.00 USD/);
  assert.match(normalized, /Monthly budget: <b>48,000 THB<\/b>/);
  assert.match(normalized, /Remaining: <b>9,000 THB<\/b>/);
});

test("formats weekly report with top categories", () => {
  const text = formatWeeklyReport({
    snapshot: snapshot(),
    topCategories: [{ category_slug: "food_cafe", total: 735 }]
  });

  assert.match(text, /735 THB/);
  assert.match(normalizeSpaces(text), /42 000 THB/);
});

test("formats saved summary in English when requested", () => {
  const text = formatSavedSummary(75, snapshot(), { language: "en" });

  assert.match(text, /Saved/);
  assert.match(text, /Today/);
  assert.match(text, /Month/);
  assert.doesNotMatch(text, /Записал/);
});

function snapshot() {
  return {
    today: 75,
    dayPlanLimit: 1475,
    dayRemaining: 1400,
    dayOverrun: 0,
    week: 735,
    weekPlanLimit: 9800,
    month: 735,
    monthlyBudget: 42000,
    plannedRemaining: 15269.99,
    freeRemaining: 25995.01,
    budgetProgressPercent: 1.75,
    forecastMonthTotal: 11025,
    planDeviation: -2065,
    safeToSpendPerDay: 896.38,
    status: "below_plan"
  };
}

test("single-expense saved summary shows the saved line", () => {
  const text = formatSavedSummary(80, snapshot(), { language: "en", expenses: [{ amount_base: 80, category_slug: "food_cafe", description: "coffee" }] });
  assert.match(text, /coffee/);
});

test("multi-expense saved summary lists each expense and a total", () => {
  const text = formatSavedSummary(280, snapshot(), { language: "en", expenses: [
    { amount_base: 80, category_slug: "food_cafe", description: "coffee" },
    { amount_base: 200, category_slug: "transport", description: "taxi" }
  ] });
  assert.match(text, /coffee/);
  assert.match(text, /taxi/);
  const normalized = normalizeSpaces(text);
  assert.match(normalized, /<b>Total:<\/b> 280 THB/);
  assert.ok(normalized.indexOf("coffee") < normalized.indexOf("── <b>Today"), "saved-expense lines appear before the today header");
});

test("draft preview and saved summary show the same category label for a slug", () => {
  for (const slug of ["food_cafe", "groceries", "gifts_help", "transport", "other"]) {
    const item = { amount: 1, currency: "THB", amount_base: 1, category_slug: slug, description: "x", spent_at: "2026-06-26T10:00:00Z", budget_impact: "regular", tags: [] };
    const draft = formatDraft([item], { language: "ru", baseCurrency: "THB" });
    const saved = formatSavedSummary(1, snapshot(), { language: "ru", expenses: [item] });
    const label = categoryName(slug);
    assert.match(draft, new RegExp(escapeRegExp(label)), `draft missing label for ${slug}`);
    assert.match(saved, new RegExp(escapeRegExp(label)), `saved missing label for ${slug}`);
  }
});

test("food_cafe saved summary shows the food label and never the gifts label", () => {
  const item = { amount: 1, currency: "THB", amount_base: 1, category_slug: "food_cafe", description: "x" };
  const saved = formatSavedSummary(1, snapshot(), { language: "ru", expenses: [item] });
  assert.match(saved, new RegExp(escapeRegExp(categoryName("food_cafe"))));
  assert.doesNotMatch(saved, /Подарки/);
});

function escapeRegExp(text) {
  return String(text ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mixedCurrencyExpenses() {
  return [
    draftExpense(127000, "IDR"),
    draftExpense(25000, "RUB")
  ];
}

function draftExpense(amount, currency) {
  return {
    amount,
    currency,
    description: "expense",
    category_slug: "other",
    spent_at: "2026-06-02T09:30:00+07:00"
  };
}

function countedAmount(value, conversions) {
  return {
    valueOf() {
      conversions.count += 1;
      return value;
    }
  };
}

function normalizeSpaces(value) {
  return value.replaceAll("\u00a0", " ");
}
