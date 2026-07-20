# Mixed-Currency Draft Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a safe, date-aware base-currency total for every mixed-currency Telegram draft, or explicit per-currency subtotals when the established resolver is unavailable.

**Architecture:** The repository prepares an explicit `converted | unavailable` preview outcome by reusing `buildMoneyAmounts()` item by item. A new dependency-light render module is imported by both the Telegram bot and the Mini App synchronization path; it calls the repository and then the pure formatter. `formatDraft()` remains safe even when a caller supplies no preview.

**Tech Stack:** Node.js ES modules, built-in `node:test`, strict assertions, existing exchange-rate provider and repository fakes.

---

### Task 1: Make the pure formatter safe for every mixed-currency input

**Files:**

- Modify: `apps/api/src/telegramFormat.js:3-27`
- Modify: `apps/api/test/telegramFormat.test.js:14-31`

- [x] **Step 1: Write failing formatter regressions**

Add tests immediately after the basic draft-format test:

```js
test("never adds original amounts from a mixed-currency draft", () => {
  const items = [
    { amount: 127000, currency: "IDR", description: "groceries", category_slug: "groceries", spent_at: "2026-07-10T10:00:00Z" },
    { amount: 25000, currency: "RUB", description: "coach", category_slug: "sport", spent_at: "2026-07-10T10:00:00Z" }
  ];

  const text = formatDraft(items, { language: "en", baseCurrency: "USD" });

  assert.doesNotMatch(text, /152,?000(?:\.00)? USD/);
  assert.match(text, /127,000 IDR \+ 25,000 RUB/);
  assert.match(text, /reliable total in USD is unavailable/i);
});

test("formats an explicit converted mixed-currency preview in RU and EN", () => {
  const items = [
    { amount: 100, currency: "USD", description: "a", category_slug: "other", spent_at: "2026-07-10T10:00:00Z" },
    { amount: 200, currency: "EUR", description: "b", category_slug: "other", spent_at: "2026-07-11T10:00:00Z" }
  ];
  const preview = { kind: "converted", baseCurrency: "GEL", total: 847.5 };

  assert.match(formatDraft(items, { language: "en", baseCurrency: "GEL", preview }), /847\.50 GEL/);
  assert.match(formatDraft(items, { language: "ru", baseCurrency: "GEL", preview }), /847,50 GEL/);
});
```

Import `SUPPORTED_CURRENCY_CODES` from `packages/shared/src/currencies.js` and add one table test for the global contract. For each `baseCurrency` and each distinct pair of supported currencies, call `formatDraft()` without a preview and assert that the text contains both original currencies and does not contain their raw numeric sum followed by the base-currency code. This test deliberately covers `RUB + USD`, `THB + EUR`, `IDR + BYN`, and every other supported pair without duplicating pair-specific fixtures.

- [x] **Step 2: Run the test and verify RED**

Run: `node --test apps/api/test/telegramFormat.test.js`

Expected: FAIL because the current formatter emits the raw `152000 USD` sum and ignores `preview`.

- [x] **Step 3: Implement the explicit formatter contract**

Replace the unconditional total calculation in `formatDraft()` with this helper. Keep existing escaping and `formatMoney()` unchanged.

```js
function formatDraftTotal(expenses, { language, baseCurrency, preview }) {
  const currencies = [...new Set(expenses.map((expense) => String(expense.currency ?? "THB").toUpperCase()))];
  if (currencies.length <= 1) {
    const currency = currencies[0] ?? baseCurrency;
    const total = expenses.reduce((sum, expense) => sum + Number(expense.amount ?? 0), 0);
    return { text: formatMoney(total, currency, language), warning: "" };
  }
  if (preview?.kind === "converted" && preview.baseCurrency === baseCurrency) {
    return { text: formatMoney(preview.total, baseCurrency, language), warning: "" };
  }
  const subtotals = currencies.map((currency) => {
    const total = expenses
      .filter((expense) => String(expense.currency ?? "THB").toUpperCase() === currency)
      .reduce((sum, expense) => sum + Number(expense.amount ?? 0), 0);
    return formatMoney(total, currency, language);
  }).join(" + ");
  const warning = language === "en"
    ? "\n\n⚠️ A reliable total in " + baseCurrency + " is unavailable. Amounts are shown by currency."
    : "\n\n⚠️ Не удалось надёжно посчитать итог в " + baseCurrency + ". Показаны суммы по валютам.";
  return { text: subtotals, warning };
}
```

Use `const totalLine = formatDraftTotal(...)` in the total row. Only `preview.kind === "converted"` may render a mixed aggregate; `unavailable`, missing, malformed, or wrong-base preview values take the safe subtotal branch.

- [x] **Step 4: Run formatter tests and verify GREEN**

Run: `node --test apps/api/test/telegramFormat.test.js`

Expected: PASS, including existing single-currency formatting and new RU/EN regressions.

- [x] **Step 5: Commit**

```powershell
git add apps/api/src/telegramFormat.js apps/api/test/telegramFormat.test.js
git commit -m "fix: prevent raw mixed-currency draft totals"
```

### Task 2: Add a repository preview outcome that shares conversion logic with saving

**Files:**

- Modify: `apps/api/src/repository.js:39-43,2289-2354,3703-3734`
- Modify: `apps/api/test/repository.test.js`

- [x] **Step 1: Write failing deterministic-rate tests**

Add a test that injects this rate provider, records every rate date, and calls the new repository method:

```js
const requestedDates = [];
const exchangeRates = {
  async ratesFor(date) {
    requestedDates.push(new Date(date).toISOString().slice(0, 10));
    return { source: "test-rates", THB: { THB: 1 }, USD: { THB: 36 }, EUR: { THB: 39 } };
  }
};
const repo = createRepository(fakePool(() => ({ rows: [] })), { exchangeRates });
const items = [
  { amount: 36, currency: "USD", spent_at: "2026-07-10T12:00:00Z" },
  { amount: 78, currency: "EUR", spent_at: "2026-07-11T12:00:00Z" }
];
const preview = await repo.prepareDraftPreview(items, { base_currency: "THB" });

assert.deepEqual(requestedDates, ["2026-07-10", "2026-07-11"]);
assert.deepEqual(preview, { kind: "converted", baseCurrency: "THB", total: 4338 });
```

Add a second test where `ratesFor()` throws an error whose `code` is `exchange_rate_unavailable`; expect exactly `{ kind: "unavailable", baseCurrency: "EUR" }`. Add a third confirmation test with the same rate fake: capture the inserted `amount_base` parameters from `saveDraftAsExpense()` and compare the sum with `preview.total` after normalizing both values to the base currency precision. Import `normalizeMoneyForCurrency` from `repository.js` and use `assert.equal(normalizeMoneyForCurrency(preview.total, "THB"), normalizeMoneyForCurrency(savedTotal, "THB"))`; do not use raw JavaScript-number equality. Repeat the deterministic preview assertion for every supported base currency using an all-supported-currencies rate map.

- [x] **Step 2: Run the test and verify RED**

Run: `node --test apps/api/test/repository.test.js`

Expected: FAIL because `prepareDraftPreview` and the precision-normalization helper do not exist.

- [x] **Step 3: Implement preview preparation beside `saveDraftAsExpense()`**

Add this repository method before `saveDraftAsExpense()`. It deliberately calls the existing `buildMoneyAmounts()` in the same sequential item order and does not invent rates.

```js
async prepareDraftPreview(items, user = {}) {
  const baseCurrency = normalizeCurrency(user.base_currency, "THB");
  try {
    let total = 0;
    for (const item of items ?? []) {
      const moneyAmounts = await buildMoneyAmounts(
        exchangeRates,
        item.amount,
        item.currency,
        new Date(item.spent_at),
        { ...user, base_currency: baseCurrency }
      );
      total += Number(moneyAmounts.amountBase);
    }
    return { kind: "converted", baseCurrency, total: roundMoney(total) };
  } catch (error) {
    if (error?.code === "exchange_rate_unavailable") {
      return { kind: "unavailable", baseCurrency };
    }
    throw error;
  }
},
```

Export `normalizeMoneyForCurrency(value, currency)` near `roundMoney()`: THB/RUB/IDR/BYN normalize to zero decimals; USD/EUR/GEL normalize to two. Use it only for equality/acceptance assertions and presentation-boundary comparison; keep `amount_base` and `buildMoneyAmounts()` at their current two-decimal storage precision.

- [x] **Step 4: Run repository tests and verify GREEN**

Run: `node --test apps/api/test/repository.test.js`

Expected: PASS. The test proves per-item date use, explicit unavailable behavior, and equality with saved base amounts at currency precision.

- [x] **Step 5: Commit**

```powershell
git add apps/api/src/repository.js apps/api/test/repository.test.js
git commit -m "feat: prepare draft preview totals through repository"
```

### Task 3: Share one async renderer across Telegram and Mini App synchronization

**Files:**

- Create: `apps/api/src/draftPreview.js`
- Create: `apps/api/test/draftPreview.test.js`
- Modify: `apps/api/src/telegram.js:1-35,620,1551-1556,1762-1787,1940-1947,2282-2304`
- Modify: `apps/api/src/server.js:21-35,623-638`
- Modify: `apps/api/test/telegram.test.js:3732-3865,4972-5020`

- [x] **Step 1: Write failing render-helper and redraw tests**

Create `apps/api/test/draftPreview.test.js` with these core tests:

```js
function item(currency, amount) {
  return { amount, currency, description: currency, category_slug: "other", spent_at: "2026-07-10T12:00:00Z" };
}

test("uses repository converted preview for a mixed draft", async () => {
  const calls = [];
  const text = await renderDraftPreview({
    repository: { async prepareDraftPreview(items, user) {
      calls.push({ items, user });
      return { kind: "converted", baseCurrency: "USD", total: 12.34 };
    } },
    user: { base_currency: "USD" },
    language: "en",
    items: [item("IDR", 10000), item("RUB", 100)]
  });

  assert.equal(calls.length, 1);
  assert.match(text, /12\.34 USD/);
});

test("does not request conversion for a same-currency draft", async () => {
  const text = await renderDraftPreview({
    repository: { async prepareDraftPreview() { throw new Error("must not convert"); } },
    user: { base_currency: "USD" },
    language: "en",
    items: [item("EUR", 10), item("EUR", 20)]
  });

  assert.match(text, /30\.00 EUR/);
});
```

Extend `telegram.test.js` with a mixed parser result and fake `prepareDraftPreview()`, asserting initial delivery uses its base total. Extend the Mini App draft-message synchronization tests to change amount, currency, and date over three updates; make the fake return a new total each time and assert the Telegram-card edit contains the latest amount.

- [x] **Step 2: Run focused tests and verify RED**

Run: `node --test apps/api/test/draftPreview.test.js apps/api/test/telegram.test.js`

Expected: FAIL because the helper does not exist and callers still call `formatDraft()` directly.

- [x] **Step 3: Create the dependency-light renderer**

Create `apps/api/src/draftPreview.js` exactly as follows. It imports the formatter only, never `telegram.js`, `server.js`, or Mini App code.

```js
import { formatDraft } from "./telegramFormat.js";

export function hasMixedDraftCurrencies(items = []) {
  return new Set(items.map((item) => String(item.currency ?? "THB").toUpperCase())).size > 1;
}

export async function renderDraftPreview({ repository, user, items = [], language }) {
  const baseCurrency = String(user?.base_currency ?? "THB").toUpperCase();
  const preview = hasMixedDraftCurrencies(items)
    ? await repository.prepareDraftPreview(items, user)
    : undefined;
  return formatDraft(items, { language, baseCurrency, preview });
}
```

- [x] **Step 4: Route every draft card through the renderer**

In `telegram.js`, import `renderDraftPreview` and replace every draft-card `formatDraft(...)` use with `await renderDraftPreview({ repository, user, items, language })`. Preserve keyboards, Telegram API calls, and saved-expense formatting. Change `redrawDraft()` to accept `user` rather than only `baseCurrency`.

In `updateDraftMessageToDraftState()`, accept `repository` and `user`, then call the helper before editing Telegram. In `server.js`, pass its already-fetched repository/user to that function after Mini App PATCH. Do not add imports from `server.js` or Mini App modules into `telegram.js` or `draftPreview.js`.

- [x] **Step 5: Run focused tests and verify GREEN**

Run: `node --test apps/api/test/draftPreview.test.js apps/api/test/telegram.test.js apps/api/test/telegramFormat.test.js apps/api/test/repository.test.js`

Expected: PASS. Tests demonstrate initial delivery, callback redraw, editor return, and Mini App synchronization refresh the prepared total; resolver unavailability displays subtotals and warning.

- [x] **Step 6: Commit**

```powershell
git add apps/api/src/draftPreview.js apps/api/test/draftPreview.test.js apps/api/src/telegram.js apps/api/src/server.js apps/api/test/telegram.test.js
git commit -m "fix: refresh mixed-currency draft previews"
```

### Task 4: Record the domain rule and verify the completed change

**Files:**

- Modify: `docs/DOMAIN_RULES.md:Drafts`
- Modify: `docs/superpowers/plans/2026-07-20-mixed-currency-draft-preview.md`

- [x] **Step 1: Add the durable rule**

Append this bullet to the `## Drafts` section:

```markdown
- A mixed-currency draft confirmation never adds original amounts across currencies. It shows a total only after each item is converted to the user's base currency through the same date-aware conversion and fallback chain used at confirmation; otherwise it shows per-currency subtotals and no aggregate.
```

- [x] **Step 2: Run focused tests**

Run: `node --test apps/api/test/telegramFormat.test.js apps/api/test/repository.test.js apps/api/test/draftPreview.test.js apps/api/test/telegram.test.js`

Expected: PASS with no live provider request.

- [x] **Step 3: Run full verification**

Run: `npm.cmd test`

Expected: all tests pass.

Run: `git diff --check`

Expected: no output and exit code 0.

- [x] **Step 4: Review scope and PR body**

Confirm the diff contains no migration, backfill, provider-specific rate table, raw mixed-currency sum, or unrelated refactor. The eventual draft PR body must include `Closes #111`, test evidence, no-DB-impact statement, and:

```markdown
## User Release Notes

Fixed Telegram draft totals for expenses in different currencies.
```

- [ ] **Step 5: Commit and publish**

```powershell
git add docs/DOMAIN_RULES.md docs/superpowers/plans/2026-07-20-mixed-currency-draft-preview.md
git commit -m "docs: record mixed-currency draft preview rule"
git push
```

Open a draft PR to `master`. Do not merge or deploy.
