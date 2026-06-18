# History Period Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the inline history date inputs with an adaptive fixed `Даты` action and a dependency-free calendar bottom sheet that selects one day or an inclusive range.

**Architecture:** Keep the applied filter in the existing `historyFilterState` and introduce a separate draft calendar state while the sheet is open. Put deterministic date parsing, range selection, month-grid generation, and labels in `history.js`; keep DOM rendering and event wiring in `app.js`. Reuse the current `/api/expenses` contract with `period` or `fromDate`/`toDate`.

**Tech Stack:** Vanilla HTML, CSS, JavaScript ES modules, Node.js built-in test runner, Codex in-app browser.

---

### Task 1: Calendar domain helpers

**Files:**
- Modify: `apps/miniapp/src/history.js`
- Modify: `apps/miniapp/test/history.test.js`

- [ ] **Step 1: Write failing tests for date-range selection**

Add tests that import `selectRangeDate` and assert:

```js
assert.deepEqual(selectRangeDate({}, "2026-06-10"), {
  startDate: "2026-06-10",
  endDate: "2026-06-10",
  selectionComplete: false
});
assert.deepEqual(selectRangeDate({
  startDate: "2026-06-10",
  endDate: "2026-06-10",
  selectionComplete: false
}, "2026-06-08"), {
  startDate: "2026-06-08",
  endDate: "2026-06-10",
  selectionComplete: true
});
assert.deepEqual(selectRangeDate({
  startDate: "2026-06-08",
  endDate: "2026-06-10",
  selectionComplete: true
}, "2026-06-15"), {
  startDate: "2026-06-15",
  endDate: "2026-06-15",
  selectionComplete: false
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test apps/miniapp/test/history.test.js`

Expected: FAIL because `selectRangeDate` is not exported.

- [ ] **Step 3: Implement minimal local-date helpers**

Add exported helpers:

```js
export function selectRangeDate(state, date) { /* first, second, third tap rules */ }
export function compareYmd(left, right) { /* lexical comparison after validation */ }
export function isFutureYmd(value, today) { /* compare valid local date strings */ }
```

Invalid `YYYY-MM-DD` input must return the unchanged state or `false`, never create an invalid range.

- [ ] **Step 4: Add failing month-grid tests**

Test `buildCalendarMonth("2026-06", "2026-06-18")` for:

- Monday-first placement;
- 30 June days;
- disabled dates after June 18;
- selected-range flags supplied through options;
- no enabled future dates.

Test `canNavigateToMonth("2026-07", "2026-06-18") === false` and navigation to June or earlier is allowed.

- [ ] **Step 5: Implement month-grid helpers and run GREEN**

Add:

```js
export function buildCalendarMonth(month, today, range = {}) { /* calendar cells */ }
export function shiftCalendarMonth(month, delta) { /* YYYY-MM */ }
export function canNavigateToMonth(month, today) { /* block future month */ }
```

Run: `node --test apps/miniapp/test/history.test.js`

Expected: PASS.

- [ ] **Step 6: Commit domain helpers**

```powershell
git add -- apps/miniapp/src/history.js apps/miniapp/test/history.test.js
git commit -m "Добавить логику календарного диапазона"
```

### Task 2: Bottom-sheet markup and translations

**Files:**
- Modify: `apps/miniapp/src/index.html`
- Modify: `apps/miniapp/src/i18n.js`
- Modify: `apps/miniapp/test/i18n.test.js`
- Modify: `apps/miniapp/test/smokeAssets.test.js`

- [ ] **Step 1: Write failing asset and translation tests**

Assert that `index.html`:

- has `#historyQuickPeriods`, `#openHistoryDatePicker`, `#historyDateSheet`;
- has one calendar container and no `#historyFromDate`, `#historyToDate`, or `#historyCustomRange`;
- does not expose `data-history-period="previous_month"`;
- gives the sheet `role="dialog"` and `aria-modal="true"`.

Assert both languages contain:

```text
history.choosePeriod
history.closePeriod
history.previousMonthAction
history.nextMonthAction
history.selectedPeriod
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
node --test apps/miniapp/test/i18n.test.js apps/miniapp/test/smokeAssets.test.js
```

Expected: FAIL for missing markup and translations.

- [ ] **Step 3: Replace the inline range markup**

Create:

- a `history-period-row`;
- scrollable `#historyQuickPeriods` with four quick chips;
- fixed `#openHistoryDatePicker`;
- backdrop and bottom sheet near the end of `body`;
- month navigation, weekdays, `#historyCalendarGrid`, reset/apply controls.

The sheet starts hidden and contains no native date inputs.

- [ ] **Step 4: Add Russian and English translations**

Add the exact calendar labels and accessible names to `i18n.js`, retaining existing keys that are still consumed elsewhere.

- [ ] **Step 5: Run tests and verify GREEN**

Run:

```powershell
node --test apps/miniapp/test/i18n.test.js apps/miniapp/test/smokeAssets.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit markup**

```powershell
git add -- apps/miniapp/src/index.html apps/miniapp/src/i18n.js apps/miniapp/test/i18n.test.js apps/miniapp/test/smokeAssets.test.js
git commit -m "Добавить разметку выбора дат"
```

### Task 3: Application state and interactions

**Files:**
- Modify: `apps/miniapp/src/app.js`
- Modify: `apps/miniapp/src/history.js`
- Modify: `apps/miniapp/test/history.test.js`
- Modify: `apps/miniapp/test/smokeAssets.test.js`

- [ ] **Step 1: Write failing behavior-contract tests**

Add source-contract assertions for:

- click binding on `#openHistoryDatePicker`;
- click binding for calendar dates through `data-calendar-date`;
- close handlers for close button, backdrop, and Escape;
- `resetHistoryPeriod()` applying month and closing;
- no reads from removed date inputs.

Add pure tests for a helper that converts an applied filter into draft state:

```js
createCalendarDraft(
  { period: "custom", fromDate: "2026-05-10", toDate: "2026-05-12" },
  "2026-06-18"
)
```

must preserve the range and open May 2026; a quick period must open the current month with no range.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --test apps/miniapp/test/history.test.js apps/miniapp/test/smokeAssets.test.js
```

Expected: FAIL for missing draft helper and event contracts.

- [ ] **Step 3: Implement draft state and rendering**

In `app.js`:

- create `historyCalendarDraft`;
- open the sheet from the fixed button;
- initialize the draft from `historyFilterState`;
- render month label and calendar cells from `buildCalendarMonth`;
- render selected-range text;
- update the draft on day clicks;
- allow Apply after the first day;
- normalize and apply custom dates;
- reset to month and close;
- return focus to the opening button;
- close without applying on close, backdrop, or Escape.

Use a fresh local `today` value when opening/rendering rather than a module-load timestamp.

- [ ] **Step 4: Update active state and labels**

Set `aria-pressed` on quick chips and the fixed date button. Keep the fixed button label as `Даты`/`Dates` at narrow widths; expose the full selected period in `#historyFilterCurrent` and the existing summary title.

- [ ] **Step 5: Run focused and full tests**

Run:

```powershell
node --test apps/miniapp/test/history.test.js apps/miniapp/test/smokeAssets.test.js
npm test
```

Expected: all tests PASS.

- [ ] **Step 6: Commit behavior**

```powershell
git add -- apps/miniapp/src/app.js apps/miniapp/src/history.js apps/miniapp/test/history.test.js apps/miniapp/test/smokeAssets.test.js
git commit -m "Подключить выбор диапазона дат"
```

### Task 4: Adaptive styling

**Files:**
- Modify: `apps/miniapp/src/styles.css`
- Modify: `apps/miniapp/test/smokeAssets.test.js`

- [ ] **Step 1: Write failing CSS contract tests**

Assert the stylesheet includes:

- `min-width: 0` on the period row and quick-period container;
- `overflow-x: auto` only on the quick-period container;
- `flex: 0 0 auto` on the fixed date action;
- fixed bottom-sheet positioning;
- `env(safe-area-inset-bottom)`;
- document/content bottom padding sufficient for the tab bar;
- no styles for `.history-custom-range`.

- [ ] **Step 2: Run test and verify RED**

Run: `node --test apps/miniapp/test/smokeAssets.test.js`

Expected: FAIL for missing adaptive contracts.

- [ ] **Step 3: Implement responsive styles**

Replace the old filter CSS with:

- a compact flex row;
- scrollbar-hidden quick chips;
- a fixed date chip with no shrinking;
- ellipsis for the period summary;
- backdrop and bottom sheet;
- seven-column calendar grid;
- selected start/end/range/today/disabled states;
- sticky or fixed sheet actions inside the sheet;
- safe-area padding and internal vertical scrolling for short viewports.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```powershell
node --test apps/miniapp/test/smokeAssets.test.js
npm test
```

Expected: all tests PASS.

- [ ] **Step 5: Commit styling**

```powershell
git add -- apps/miniapp/src/styles.css apps/miniapp/test/smokeAssets.test.js
git commit -m "Адаптировать выбор периода для WebView"
```

### Task 5: Browser verification and publication

**Files:**
- Modify if defects are found: relevant Mini App source/test files
- Modify: `docs/superpowers/plans/2026-06-18-history-period-picker.md`

- [ ] **Step 1: Start the Mini App sandbox**

Run the existing development server and open the seeded history page in the Codex in-app browser.

- [ ] **Step 2: Verify required widths**

At 320, 360, 375, 390, 393, 414, and 430 px verify:

- `document.documentElement.scrollWidth <= clientWidth`;
- the fixed date action is visible;
- only the quick-period strip scrolls horizontally;
- the filter card remains compact;
- the expense list clears the bottom tab bar.

- [ ] **Step 3: Verify interactions**

Verify:

- quick periods load immediately;
- the sheet opens with the previous custom range selected;
- first tap permits a single-day apply;
- second tap creates a normalized range;
- third tap starts a new range;
- future dates and future-month navigation are disabled;
- close/backdrop/Escape discard the draft;
- reset applies month and closes;
- applied range updates button state, label, summary, and list.

- [ ] **Step 4: Run final verification**

Run:

```powershell
npm test
git diff --check
git status --short
```

Expected: tests PASS, diff check is clean, and only intended files are modified.

- [ ] **Step 5: Commit final fixes and plan**

```powershell
git add -- docs/superpowers/plans/2026-06-18-history-period-picker.md apps/miniapp
git commit -m "Проверить выбор периода истории"
```

Skip the commit if there are no remaining changes.

- [ ] **Step 6: Push and open a draft PR**

Push the `codex/history-period-picker` branch and open a draft PR to the repository default branch with:

- the adaptive fixed `Даты` layout;
- the custom calendar bottom sheet;
- date-selection behavior and future-date restrictions;
- automated and browser validation results.
