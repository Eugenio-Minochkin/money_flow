# Mixed-Currency Telegram Draft Preview Design

## Goal

Prevent Telegram draft confirmations from presenting a fabricated aggregate when a draft contains expenses in more than one currency. A mixed-currency preview must show the same base-currency total that confirmation will persist in `expenses.amount_base`, or safely show per-currency subtotals when the established conversion chain is unavailable.

## Scope

- Apply the rule to every supported currency combination and every user base currency.
- Preserve each draft item's original amount and currency in the confirmation card.
- Keep the existing single-currency total in that currency without a conversion lookup.
- Recalculate a mixed-currency preview after draft creation and after edits to amount, currency, or date from Telegram or the Mini App.
- Preserve the current exchange-rate date selection, database cache, provider, manual fallback, and rounding behavior used while saving expenses.
- Cover Russian and English output.

## Non-goals

- Do not change saved expense history, existing `amount_base` values, exchange-rate tables, or migration state.
- Do not add a static preview-rate table or a second conversion formula.
- Do not display a partial or raw-number aggregate if conversion cannot be completed.

## Design

### Repository-owned preview conversion

`repository` will expose a focused draft-preview preparation operation. For a mixed-currency item list, it will call the existing `buildMoneyAmounts(exchangeRates, amount, currency, spentAt, user)` once per item. Each call uses the item's own `spent_at` and the user's `base_currency`.

The preview total is the sum of those already-rounded base-currency amounts. This exactly matches the per-item `amount_base` values that `saveDraftAsExpense()` will generate when the same draft is confirmed. The repository operation returns a prepared base-currency total on success. If, and only if, the normal resolver ultimately raises `exchange_rate_unavailable`, it returns an unavailable-preview outcome.

The standard exchange-rate fallback chain remains valid for preview conversion because it is already valid for saving the expense:

```text
exact database cache -> provider -> safe database fallback -> manual fallback -> exchange_rate_unavailable
```

### Pure formatter contract

`formatDraft()` stays a pure presentation function. It receives an optional prepared preview result; it must not fetch rates or derive conversion rates itself.

- A same-currency draft formats the existing total in that shared currency.
- A mixed-currency draft with a prepared total formats that total in the user's base currency.
- A mixed-currency draft without a prepared total, including the unavailable outcome, formats grouped per-currency subtotals such as `127 000 IDR + 25 000 RUB` and a localized warning that a reliable base-currency total is unavailable.

The formatter must never add original numeric values from different currencies. This safe no-preview behavior is intentionally covered by formatter unit tests, so an incomplete caller cannot reintroduce the raw-sum bug.

### Telegram rendering boundary

An asynchronous draft-render helper in the Telegram layer will obtain the prepared preview from the repository for mixed-currency drafts and then call the pure formatter. All draft-card rendering paths will use this helper:

- initial text or voice parsing;
- callback-driven draft updates;
- return from the Telegram draft editor;
- redraw paths after editor changes;
- Mini App draft PATCH synchronization back to the stored Telegram message.

The Telegram text editor can keep showing its editor card immediately after a successful edit. When the user returns to the draft card, the helper re-reads the updated items and recalculates the total. Mini App updates recalculate before the linked Telegram card is edited.

## Error handling and localization

Only a resolver result of `exchange_rate_unavailable` suppresses the aggregate. Other failures continue to follow the existing runtime error handling rather than being silently converted into a financial total.

For the unavailable outcome, Russian and English cards retain all original lines, show grouped subtotals, and contain a concise warning that a reliable total in the base currency cannot be calculated. The warning contains no provider details, rates, raw error messages, or sensitive data. Existing HTML escaping remains unchanged.

## Acceptance scenarios

1. With a USD base currency and deterministic rates, `127000 IDR + 25000 RUB` renders the converted USD total, never `152000 USD`.
2. The same rule holds for all supported mixed pairs, including where either item already uses the base currency.
3. A two-item same-currency draft retains the ordinary total in that currency and performs no unnecessary conversion.
4. On confirmation, the preview total equals the sum of the saved `amount_base` values under the established rounding rule.
5. Edits to amount, currency, or date refresh the total using the changed item data and its changed rate date where relevant.
6. If the resolver exhausts cache, provider, database fallback, and manual fallback, the card displays per-currency subtotals plus the localized warning and no base-currency aggregate.

## Test strategy

- `apps/api/test/telegramFormat.test.js`: direct formatter regression tests for a safe mixed-currency no-preview outcome, a supplied converted total, same-currency behavior, and RU/EN warning text.
- `apps/api/test/repository.test.js` or a focused service test: inject deterministic exchange rates, assert item dates are passed through the shared conversion path, and assert the preview total matches the amount-base calculation used by confirmation.
- `apps/api/test/telegram.test.js`: assert initial mixed-draft delivery and Telegram/Mini App redraw paths pass refreshed prepared totals after amount, currency, and date edits.
- Run focused tests first, then `npm.cmd test` and `git diff --check`.

## Data, production, and release impact

There is no migration, backfill, or persistent-data rewrite. The change only corrects an unsaved draft display and uses the existing resolver and provider behavior. This is user-visible financial-display correctness work; the eventual pull request will include concise user release notes.
