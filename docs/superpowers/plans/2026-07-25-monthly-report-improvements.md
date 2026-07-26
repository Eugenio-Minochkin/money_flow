# Monthly Report Improvements Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Follow TDD: failing test first, then implementation.

**Goal:** Turn the Telegram monthly report into a useful financial summary (not an expanded operation dump): answer budget status + usage %, top-5 categories with percentages, five real largest operations, paid-planned summary with only unpaid detail, conservative month-over-month comparison, full-category-set "what changed", a non-redundant defensible takeaway, and dedicated first-full-month handling — fully bilingual RU/EN, without changing spending/currency/budget accounting.

**Architecture:** Reuse the pure analytics module (`reportAnalytics.js`) and weekly formatter helpers from PR #127, extend them with monthly-specific thresholds and a monthly takeaway, add a timezone-aware `priorMonthlyBounds` in `reportPeriods.js`, wire monthly analytics into `repository.buildReportDataForDelivery`, and rewrite `formatMonthlyReport` to the new structure. No DB migrations, no accounting changes, weekly report untouched.

**Tech Stack:** Node.js ESM, `node:test` + `node:assert/strict`, plain JS, shared Money Flow helpers.

---

## Key Decisions And Assumptions

- **Confirmed with user (Q1):** Monthly change thresholds use the spec's recommended logic — relative **20%** + absolute **`max(currency floor, 5% of max(currentTotal, priorMonthTotal))`**, as named constants. Weekly thresholds (25% / fixed floor) are NOT touched; `categoryChanges` gains optional `relativeMin` + `absoluteFloor` that default to weekly values.
- **Confirmed with user (Q2):** The takeaway "concentration" sentence (`Две главные категории составили N% расходов месяца`) fires only when **top-2 ≥ 50%**. The line under the top-5 list still shows the top-two share whenever ≥ 2 categories (same as weekly).
- **Currency floors reuse** the weekly `CHANGE_ABSOLUTE_BY_CURRENCY` (already covers THB/RUB/USD/EUR/IDR/BYN/GEL); no silent fallback — the default stays but the test over `SUPPORTED_CURRENCY_CODES` guarantees every supported code has an explicit floor.
- **Budget block:** status-based (`✅ ≤89%`, `⚠️ 90–100%`, exceeded `>100%`); hidden when effective budget ≤ 0; top-ups collapse to a single `Including budget top-ups` line inside the budget block (never added to `totalSpent`).
- **Largest expenses:** real top-5 from all period expenses (rent / paid planned allowed), tie-break `amount desc → date asc → id asc`; output shape stays `{name, amount}` so weekly tests are unaffected.
- **Comparison:** comparable only between two fully-observable calendar months (`priorTotal > 0` AND account existed before prior-month start). First full month and mid-prior-month creation hide comparison but are distinguished (first month shows the closing line).
- **Takeaway:** defensible only — budget (notable usage/exceeded), concentration (≥50%), direction-consistent category attribution (≥60% of |Δ|), or a single-operation share (≥25%, states share not cause). Max 2 sentences; hidden otherwise. RU/EN state the same fact.
- **Unchanged:** `totalSpent` calculation, currency conversion/rounding, budget model, exchange rates, domain rounding, weekly report structure, DB schema.

## Thresholds (named constants in `reportAnalytics.js`)

```js
// Existing (weekly) — unchanged
export const CHANGE_RELATIVE_MIN = 0.25;
export const CHANGE_ABSOLUTE_BY_CURRENCY = { THB: 1000, RUB: 2500, USD: 30, EUR: 30, IDR: 500_000, BYN: 100, GEL: 80 };
export const TAKEAWAY_DOMINANT_EXPENSE_SHARE = 0.5;   // weekly
export const TAKEAWAY_CATEGORY_SHARE_OF_DELTA = 0.6;

// New (monthly)
export const MONTHLY_CHANGE_RELATIVE_MIN = 0.20;                  // 20% relative
export const MONTHLY_CHANGE_ABSOLUTE_TOTAL_SHARE = 0.05;          // 5% of max(cur,prior)
export const MONTHLY_TAKEAWAY_DOMINANT_EXPENSE_SHARE = 0.25;      // "> a quarter"
export const MONTHLY_TAKEAWAY_CONCENTRATION_MIN = 50;             // top-2 percent
export const MONTHLY_BUDGET_HIGH_USAGE_MIN_PCT = 90;              // "almost used" / budget takeaway
export const MONTHLY_BUDGET_EXCEEDED_PCT = 100;                   // status boundary
```

## New Monthly Report Structure

```
🧾 Итоги июня / June summary

💸 Потрачено: <total> / Spent: <total>
≈ <display currency>            (only when display currency differs)
📈 <comparison vs prior month>  (only when comparable)
<daily average line>            (only when totalSpent > 0)

🎯 Бюджет месяца / Monthly budget   (only when effective budget > 0)
<status line: ✅ within / ⚠️ almost / exceeded>
Использовано N% из <budget> / Used N% of <budget>
Осталось: <remaining> / Remaining: <remaining>   (only when not exceeded)
≈ <remaining display>
Включая пополнения бюджета: <topups> / Including budget top-ups: <topups>   (only when topups > 0)

🧩 Структура расходов / Spending breakdown   (only when plannedPaidTotal > 0)
Плановые оплаты — <amount> · <pct>% / Planned payments — <amount> · <pct>%
Остальные расходы — <amount> · <pct>% / Other expenses — <amount> · <pct>%
Без плановых оплат — в среднем <avg>/день / Excluding planned payments, the daily average was <avg>

🏷️ Главные категории / Top categories
1. <cat> — <amount> · <pct>%     (up to 5)
<top-two share line>            (only when ≥ 2 categories)

🧾 Самые большие расходы / Largest expenses
1. <name> — <amount>            (up to 5, sorted desc)

🔄 Что изменилось / What changed   (only when comparable)
• <change lines>                (up to 3)

📅 Плановые оплаты / Planned payments   (only when there are planned payments)
✅ Отмечено X из Y / X of Y marked as paid
В расходы месяца включено <paidTotal> / <paidTotal> included in this month's spending
<unpaid detail, max 3, collapsed>   (only unpaid; "всё ещё не отмечена ... не входит в расходы месяца")

💡 Главное за месяц / This month's takeaway   (only when defensible)

<first full month closing line>   (only first month; replaces comparison/changes/takeaway)
```

## Tasks

### 1. Analytics: monthly thresholds + `categoryChanges` options
- [ ] Add monthly constants above.
- [ ] Extend `categoryChanges({ ..., relativeMin = CHANGE_RELATIVE_MIN, absoluteFloor = null })`: `absoluteMin = absoluteFloor != null ? max(floor, absoluteFloor) : floor`; use `relativeMin` in the relative check.
- [ ] Test: monthly thresholds pass the spec example (Дом +3200 shown at 20%/scaled; a 14% noise change hidden); full `SUPPORTED_CURRENCY_CODES` still have explicit floors.

### 2. Analytics: `largestExpenses` stable tie-break
- [ ] Sort `amount desc → local_date asc → id asc`; keep output `{name, amount}`.
- [ ] Test: equal amounts order by earlier date; weekly existing tests unchanged.

### 3. Analytics: extract `findDominantAttribution`, add `monthlyTakeaway`
- [ ] Export `findDominantAttribution(changes, direction, totalAbsDelta)` (≥60% of |Δ|, direction match); refactor `weeklyTakeaway` to use it (identical weekly output).
- [ ] Add `monthlyTakeaway({ comparable, comparisonDirection, currentTotal, priorTotal, budget, topTwoShare, largestExpense, changes, language, formatMoney })` producing ≤2 sentences by priority: budget(notable) → concentration(≥50%) → attribution → dominant-share(≥25%). Null when nothing defensible.
- [ ] Tests: budget-within-high, exceeded, concentration, attribution direction-consistent, dominant share-not-cause, flat→null, not-comparable→null, RU/EN parity.

### 4. Periods: `priorMonthlyBounds`
- [ ] Add `priorMonthlyBounds(period, timeZoneValue)` → `{ start, end, localStartDate, localEndDate, periodKey }` via shared `timeZoneMonthBounds(priorKey, tz)`.
- [ ] Tests: prior month UTC bounds tz-aware; DST `Europe/Berlin` March→April transition correct.

### 5. Repository: wire monthly analytics into `buildReportDataForDelivery`
- [ ] Compute (monthly branch): prior-month bounds + prior categories, `weeklyComparison`, fully-observable gating, `firstMonth`, `categoryChanges` (monthly thresholds), `largestExpenses(expenses)`, `needsAttentionFromUnpaid(unpaid)`, `monthlyTakeaway`.
- [ ] Add `budget.usedPercent`, `budget.available`-ish gate; add `comparison.priorMonthKey`.
- [ ] Tests: comparable month, mid-prior-month creation hides comparison, first month hides comparison+shows closing line, empty prior month hides comparison, largest includes paid planned, unpaid excluded from total.

### 6. Formatter: rewrite `formatMonthlyReport`
- [ ] New structure + monthly labels (title `Итоги июня`/`June summary`, comparison-by-month with prepositional RU month, breakdown, budget statuses, planned summary, firstMonthLine, takeaway heading).
- [ ] Reuse `displayPartition` (reportDisplay) so visible parts add up; reuse `formatLargestExpenses`, `formatWhatChanged`, top-two share.
- [ ] Tests: full RU + EN, no category keys, percentages, top-2 share from raw amounts, visual partition equality, budget statuses (within/almost/exceeded/hidden), top-ups line, first month, unpaid collapse + pluralization, takeaway.

### 7. Regression + PR
- [ ] Weekly report tests unchanged; full `npm test` green.
- [ ] Draft PR with RU/EN/first-month/over-budget/multi-unpaid examples, release notes, DB/prod impact (none).

## Risks / Mitigations
- **Russian month cases:** comparison needs prepositional (`в мае`), title needs genitive (`Итоги июня`); add dedicated helpers, keep existing `monthName` for dates.
- **Test churn:** monthly section of `reportFormat.test.js` + the "monthly insight" repository test change structure; rewrite them to the new contract.
- **Weekly regression:** all weekly constants/helpers keep their defaults; only additive options.
