# Weekly Report Improvements Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Follow TDD: failing test first, then implementation.

**Goal:** Make the Telegram weekly report user-friendly and fully localized (RU/EN): never show internal category keys, add top-3 categories with percentages, top-5 largest expenses, a conservative week-over-week comparison, a "what changed" block, clear unpaid-planned-payment handling, a non-redundant takeaway, and dedicated first-week handling — without changing spending/currency accounting.

**Architecture:** Add a pure bilingual category resolver in shared, add a pure analytics module (`reportAnalytics.js`) for comparison/changes/takeaway/percentages/largest-expenses, wire it into `repository.buildReportDataForDelivery`, and rewrite `formatWeeklyReport` to the new structure. The monthly report keeps its shape but inherits localized category names through the DTO. No DB migrations, no accounting changes.

**Tech Stack:** Node.js ESM, `node:test` + `node:assert/strict`, plain JS, shared Money Flow helpers.

---

## Key Decisions And Assumptions

- **Category labels:** RU reuses the existing canonical `categoryName()` from `packages/shared/src/categories.js` (zero risk to inference, miniapp, editor). EN is a new map honoring the spec's three explicit examples (`Food & Cafés`, `Home`, `Gifts & Help`) and clean names for the rest. The spec's RU examples use "и" (e.g. `Подарки и помощь`) while the existing canonical RU names use "/" (`Подарки / помощь`); we keep existing RU names to avoid breaking other surfaces. Trivially adjustable in review.
- **Single report generator:** one `formatWeeklyReport` driven by a `language` flag and a shared translation object — no separate RU/EN logic.
- **Comparison availability:** comparable only when the previous full week had spending (`priorTotal > 0`). This covers first-week and gap/missing-data cases. No full-vs-partial comparison.
- **"What changed" thresholds (named constants, conservative):** a category change is shown only when both the absolute and relative thresholds pass; small noisy changes (e.g. 50→100 THB) are hidden. Currency-aware absolute thresholds mirror the existing `reportLargeExpenseThreshold` pattern.
- **Takeaway:** only data-grounded, never invented. Dominant single expense (≥50% of total), category-attribute (≥60% of total delta), or needs-attention pointer; otherwise hidden.
- **Unchanged:** total-spent calculation, currency conversion/rounding, the monthly report structure, budget/planned-payment accounting.

## Thresholds (named constants in `reportAnalytics.js`)

```js
export const COMPARISON_FLAT_PERCENT = 5;          // |Δ%| <= 5  → "roughly unchanged"
export const CHANGE_RELATIVE_MIN = 0.25;           // 25% relative threshold
export const CHANGE_ABSOLUTE_BY_CURRENCY = { THB: 1000, RUB: 2500, USD: 30, EUR: 30 };
export const TAKEAWAY_DOMINANT_EXPENSE_SHARE = 0.5;// single expense ≥ 50% of total
export const TAKEAWAY_FLAT_BAND = 0.15;            // excluding dominant, within 15% of prior
export const TAKEAWAY_CATEGORY_SHARE_OF_DELTA = 0.6;
export const NEEDS_ATTENTION_MAX_SHOWN = 3;
```

## New Weekly Report Structure

```
📊 Итоги недели / Weekly summary
<period label>

💸 Потрачено: <total> / Spent: <total>
≈ <display currency>            (only when display currency differs)

📈 <comparison line>            (only when comparable)
В среднем — <avg>/день / Daily average — <avg>/day

🏷️ Главные категории / Top categories
1. <cat> — <amount> · <pct>%     (up to 3)
<cumulative top-2 share line>   (only when ≥ 2 categories)

🧾 Самые большие расходы / Largest expenses
1. <name> — <amount>            (up to 5, sorted desc)

🔄 Что изменилось / What changed   (only when comparable)
• <change lines>                (up to 3)

⚠️ Требует внимания / Needs attention   (only unpaid, if any)
<name> — <amount>
<per-item sentence>            (new vs still-unpaid wording)
И ещё N оплат / And N more payments   (only when collapsed)

💡 Главное за неделю / This week's takeaway   (only when a defensible takeaway exists)
<takeaway>

<first-week closing line>      (only on first week, replaces takeaway)
```

Blocks that add no value are fully hidden (no empty headers, no triple blank lines).

## File Map

- **Create:** `apps/api/src/reportAnalytics.js` — pure analytics + thresholds + bilingual category resolver re-export.
- **Create:** `apps/api/test/reportAnalytics.test.js` — unit tests for all pure helpers.
- **Modify:** `packages/shared/src/categories.js` — add `CATEGORY_LABELS_EN` + `categoryLabel(slug, language)` (additive).
- **Modify:** `packages/shared/test/categories.test.js` — `categoryLabel` coverage for all slugs, RU/EN, fallback.
- **Modify:** `apps/api/src/repository.js` — localize DTO names; compute largest expenses, comparison, changes, needs-attention, takeaway; widen unpaid lookback (weekly only) for overdue flag.
- **Modify:** `apps/api/src/reportFormat.js` — rewrite `formatWeeklyReport`; add weekly labels; keep `formatMonthlyReport` (localized via DTO).
- **Modify:** `apps/api/test/reportFormat.test.js` — update existing assertions for new structure + add new scenario tests.
- **Modify:** `apps/api/test/repository.test.js` — new DTO fields (largest expenses, comparison, changes, needs-attention, takeaway, first-week, localization) via mock pool.
- **Modify:** `docs/DOMAIN_RULES.md` — Reports section: localization rule, comparison availability, first-week, takeaway non-invention.
- **Modify:** `docs/TESTING_GUIDE.md` — weekly report test pointers.

## Tasks

### Task 1: Bilingual category resolver (shared)

**Files:** `packages/shared/src/categories.js`, `packages/shared/test/categories.test.js`

- [ ] Add `CATEGORY_LABELS_EN` map + `categoryLabel(slug, language)` (RU → `categoryName(slug)`, EN → map, fallback → slug with underscores replaced by spaces).
- [ ] Test: all 13 slugs return non-empty RU and EN; no label contains `_`; `categoryLabel("food_cafe","en") === "Food & Cafés"`; fallback for unknown slug has no underscores.
- [ ] Run: `node --test packages/shared/test/categories.test.js`.

### Task 2: Pure analytics module

**Files:** Create `apps/api/src/reportAnalytics.js`, `apps/api/test/reportAnalytics.test.js`

Pure functions taking plain data + `language`:

```js
largestExpenses(expenses, { language, limit = 5 })
categoryPercentages(topCategories, totalSpent, { language })   // adds percent + cumulativeTopTwoShare
weeklyComparison({ currentTotal, priorTotal })                 // { available, direction, percentDelta }
categoryChanges({ current, prior, language, currency })        // up to 3, threshold-gated
weeklyTakeaway({ comparable, currentTotal, priorTotal, largestExpense, changes, language, needsAttention })
needsAttentionFromUnpaid(unpaidItems, { language })            // total + shown(≤3) + moreCount + overdue wording
```

- [ ] Tests cover: largest sorted desc & capped; percentages sum & top-2 share; comparison up/down/flat/unavailable; changes hidden when below abs or relative threshold; takeaway dominant-expense / category-attribute / needs-attention / hidden; needs-attention collapse + overdue wording.
- [ ] Run: `node --test apps/api/test/reportAnalytics.test.js`.

### Task 3: Wire analytics + localization into repository

**Files:** `apps/api/src/repository.js`, `apps/api/test/repository.test.js`

- [ ] In `buildReportDataForDelivery`: localize `topCategories[].name`, large-expense names, insight category via `categoryLabel(slug, user.interface_language)`.
- [ ] Compute `largestExpenses` from fetched expenses; fetch prior-week top categories (reuse `reportTopCategoriesForPeriod` with bounds shifted −7d) → prior totals; derive comparison/changes/takeaway/first-week.
- [ ] Widen unpaid lookback for weekly (`lookbackDays = 7`) so due dates before the period are flagged `overdue`; build `needsAttention` from unpaid only. Monthly path unchanged.
- [ ] Extend weekly DTO with: `comparison`, `changes`, `largestExpenses`, `needsAttention`, `takeaway`, `firstWeek`. Keep monthly fields intact.
- [ ] Tests via mock pool: new fields populated, first-week when prior empty, comparison present when prior has data, no raw slugs in any rendered name.
- [ ] Run: `node --test apps/api/test/repository.test.js --test-name-pattern "[Rr]eport"`.

### Task 4: Rewrite weekly formatter

**Files:** `apps/api/src/reportFormat.js`, `apps/api/test/reportFormat.test.js`

- [ ] Rewrite `formatWeeklyReport` to the new structure (blocks above). Add weekly RU/EN labels. Hide inapplicable/empty blocks. Keep money/date/secondary-currency helpers and HTML escaping.
- [ ] `formatMonthlyReport`: no structural change; category names now arrive localized from the DTO, so update only assertions that asserted raw slugs (there are none currently, but verify).
- [ ] Update existing weekly assertions to the new strings; add scenario tests: top-3 with %, ≤5 largest sorted, no comparison on first week, comparison present, small changes hidden, unpaid excluded from total, empty blocks hidden, RU/EN date/number format.
- [ ] Run: `node --test apps/api/test/reportFormat.test.js`.

### Task 5: Docs

**Files:** `docs/DOMAIN_RULES.md`, `docs/TESTING_GUIDE.md`

- [ ] DOMAIN_RULES Reports section: reports never expose internal category keys (resolve via localized label); week-over-week comparison only when the previous full week had spending; first week shows a dedicated message; takeaway must be data-grounded (no invented causality); unpaid planned payments show only actionable items.
- [ ] TESTING_GUIDE: weekly report test pointers (localization, comparison, first week, takeaway).

### Task 6: Verify and PR

- [ ] Focused: `reportAnalytics`, `categories`, `reportFormat`, `repository` (report), `reportService`, `reportPeriods`, `reportKeyboards`, `reportScheduler`.
- [ ] Full: `npm test`.
- [ ] `git diff --check`.
- [ ] Commit, push, open draft PR with `## User Release Notes`.

## Test Matrix (spec scenarios 1–17)

| # | Scenario | Location |
|---|----------|----------|
| 1 | RU report uses RU category names | reportFormat |
| 2 | EN report uses EN category names | reportFormat |
| 3 | No report contains `gifts_help`/`food_cafe`/`_` keys | reportFormat + categories |
| 4 | Custom/system name priority (system here; custom N/A) | categories |
| 5 | ≤ 3 categories shown | reportFormat |
| 6 | Category percentages correct | reportAnalytics/reportFormat |
| 7 | ≤ 5 expenses shown | reportFormat |
| 8 | Expenses sorted by amount | reportAnalytics |
| 9 | < 5 expenses → no empty lines | reportFormat |
| 10 | First week: no comparison / no "what changed" | reportFormat/repository |
| 11 | Two full weeks → comparison shown | reportFormat/repository |
| 12 | Minor changes excluded | reportAnalytics |
| 13 | Unpaid payment excluded from spent total | repository (existing accounting) |
| 14 | Old unpaid payment → stronger wording | reportAnalytics/reportFormat |
| 15 | Empty/inapplicable blocks hidden | reportFormat |
| 16 | Number/date format correct RU/EN | reportFormat |
| 17 | Existing tests still pass | full suite |
