# Planned Expense Archive And Safe Recreate Design

**Status:** Proposed for user review

## Context

PR #122 made planned-expense disable transactional and idempotent, added `disabled_at`, prevented ordinary PATCH from changing `active`, moved the planned-month summary to the server, and established the opening-snapshot policy. Disabled plans now preserve factual payments and expenses, but the Mini App has no way to show them or safely use one as the starting point for a new plan.

This change adds a read-only archive and an explicit `recreate` action. Recreate is not restoration: it creates a new independent `planned_expenses` row and leaves the archived source and its history unchanged.

## Goals

1. Show only the current user's disabled plans in a compact, lazily loaded archive.
2. Show the recorded disable time and an honest all-time summary of valid linked payments.
3. Create a new active plan from an archived plan without copying payments or expenses.
4. Prevent the new plan from producing obligations before a user-local start date.
5. Apply the same start-date semantics to dashboard, reserve, reports, Pay, and Mini App compatibility calculations.
6. Preserve PR #122's current-local-day opening snapshot.

## Non-goals

This change does not add restoration through `active = true`, archive deletion or bulk editing, Undo payment, payment-link deletion, expense deletion, Telegram archive commands, reminder changes, new recurrence types, a general mutation-policy layer, source-plan linkage, idempotency keys, production backfill or SQL, dependency upgrades, or a dashboard redesign.

## Considered Approaches

### 1. Separate archive and recreate actions — selected

Add a read-only archive endpoint, a dedicated recreate endpoint, a repository transaction that inserts a new row, one canonical server occurrence-date generator with start filtering, and lazy Mini App archive state. This follows the repository-centered lifecycle introduced by PR #122 and keeps existing contracts explicit.

### 2. Mode flags on existing GET, create, and PATCH contracts — rejected

This would reduce the number of routes but would mix active and archived reads, make it easier to pass an archived `id` into PATCH, and obscure the prohibition on reactivation.

### 3. Persist source linkage or idempotency metadata — rejected

A `source_planned_expense_id`, recreated flag, template model, or idempotency key could restrict or audit repeated copies, but it would add a domain relationship that is not needed. One archived plan may intentionally be recreated more than once.

## Domain Invariants

- The archive is read-only history. Archived plans never enter active totals or forecast.
- Recreate always inserts a new active plan with a new `id`.
- The source remains `active = false`; its `disabled_at`, payment links, and linked expenses do not change.
- The new plan inherits editable form values only. It does not inherit `planned_expense_payments`, paid state, or expenses.
- A single archived source may be intentionally recreated multiple times. Each separately confirmed request may create another independent plan.
- There is no persistent relationship between the source and any new plan.
- Ordinary PATCH cannot mutate `active` or `starts_on`, and cannot edit an archived plan.
- `starts_on = NULL` preserves legacy occurrence behavior.
- A non-null `starts_on` excludes every earlier occurrence from obligations, forecast, reserve, reports, and Pay.
- Paid history remains factual even when the owning plan is archived.

## Persistence

Add the next additive migration, expected to be `012_planned_expense_starts_on.sql`:

```sql
ALTER TABLE planned_expenses
ADD COLUMN IF NOT EXISTS starts_on DATE;
```

`starts_on` is a user-local calendar date, not a timestamp. Existing rows remain `NULL`; there is no backfill. Ordinary Mini App and Telegram plan creation continue to omit the column and therefore store `NULL`. Recreate is the only flow that sets it. Ordinary edit leaves it unchanged.

No standalone index is added. `001_initial.sql` remains unchanged. The migration is forward-fix only: it is additive and does not rewrite or delete data.

## Archive Read Model

Add:

```text
GET /api/planned-expenses/archive
```

Authorization uses the same `resolveTelegramUserId` path as the existing planned-expense endpoints. The response is:

```json
{
  "archivedPlannedExpenses": [
    {
      "id": "41",
      "amount": 1000,
      "currency": "THB",
      "amount_base": 1000,
      "description": "Example plan",
      "category_slug": "education",
      "tags": ["example"],
      "recurrence": "weekly",
      "due_day": null,
      "due_days": [],
      "weekday": 3,
      "due_date": null,
      "starts_on": null,
      "active": false,
      "disabled_at": "2026-07-20T08:00:00.000Z",
      "paid_count": 2,
      "paid_amount_base": 2000,
      "display": {
        "currency": "USD",
        "amount": 30.63,
        "paid_amount": 61.26
      }
    }
  ]
}
```

The repository method `listArchivedPlannedExpensesForTelegramUser(telegramUserId)` selects only owned rows with `active = false` and orders them by:

```sql
ORDER BY disabled_at DESC NULLS LAST, id DESC
```

The archive payment aggregate covers all time, not only the current month. A payment is valid only when its `planned_expense_payments` row has a linked `expenses` row owned by the same user as the plan. The aggregate de-duplicates a repeated payment identity (`paid_key`) before count and sum. `paid_amount_base` sums the factual linked `expenses.amount_base`, never the plan's current amount. Display paid amount is derived from that factual base total through the existing user display-currency helper.

Orphan payment rows and links to another user's expense contribute neither count nor amount. Legacy `disabled_at = NULL` is returned unchanged. The archive is never embedded in the dashboard response.

## Recreate API Contract

Add:

```text
POST /api/planned-expenses/:id/recreate
```

Request:

```json
{
  "telegramUserId": 123,
  "startsOn": "2026-07-22",
  "plannedExpense": {
    "amount": 1000,
    "currency": "THB",
    "description": "Example plan",
    "category_slug": "education",
    "tags": ["example"],
    "recurrence": "weekly",
    "weekday": 3,
    "due_day": null,
    "due_days": [],
    "due_date": null
  }
}
```

Success is HTTP `201`:

```json
{
  "plannedExpense": {
    "id": "42",
    "active": true,
    "starts_on": "2026-07-22"
  }
}
```

The route resolves identity through `resolveTelegramUserId`; the body identifier is not trusted independently. Missing, foreign, or active source rows all return the same HTTP `404` response:

```json
{ "error": "planned_expense_not_found" }
```

Date failures return HTTP `400`:

- malformed or nonexistent `startsOn`: `invalid_planned_start_date`;
- `startsOn` before the user's current local date: `planned_start_date_in_past`;
- missing or malformed `due_date` for a recreated one-off plan: `invalid_planned_due_date`;
- one-off `due_date` before `startsOn`: `planned_due_date_before_start`.

A reserve-capacity conflict preserves HTTP `409` and `reserve_conflicts_with_planned_change`.

Existing `GET /api/planned-expenses`, `POST /api/planned-expenses`, and `PATCH /api/planned-expenses/:id` contracts are not overloaded with mode flags.

## Recreate Transaction

`recreatePlannedExpense(telegramUserId, archivedPlannedExpenseId, input, startsOn, now)` performs the following repository flow:

1. Resolve and normalize the user and form input, and resolve money amounts through the existing dated currency path.
2. Begin a database transaction.
3. Lock the owned source plan with `FOR UPDATE` and require `active = false`.
4. Validate `startsOn` against `localDayKey(now, users.timezone)`.
5. For one-off recurrence, require a valid `due_date >= startsOn`.
6. Run the existing reserve-capacity policy inside the transaction, with the candidate plan carrying `starts_on`.
7. Insert one new row with `active = true` and the validated `starts_on`.
8. Do not insert or copy any payment or expense rows.
9. Commit and return the new plan.
10. Record the existing privacy-safe `planned_expense_created` event after commit with metadata limited to `{ source: "miniapp", mode: "recreate" }`.

The event contains no plan name, amount, currency, tags, dates, source plan ID, new plan ID, user-facing text, or other financial data.

Concurrent or later separately confirmed recreate requests are allowed to create separate plans. Server-side source-use uniqueness and idempotency are intentionally absent. The Mini App prevents accidental same-form double submission.

The transaction never updates the source row, deletes a daily snapshot, or touches existing payment and expense rows.

## `starts_on` Timezone Semantics

`startsOn` and persisted `starts_on` are strict `YYYY-MM-DD` local calendar keys in `users.timezone`. Validation compares calendar keys rather than browser dates or UTC timestamps.

- Today and future dates are valid; past local dates are rejected.
- Weekly schedules first generate the month's matching weekdays, then remove keys earlier than `starts_on`.
- Monthly schedules first generate the clamped due day, then apply the same filter.
- Twice-monthly schedules generate both unique clamped due days, then apply the same filter.
- One-off schedules require a valid due date on or after `starts_on`.
- If `starts_on` is after every due date in the current month, the current month has no occurrence.
- A later month gets its normal full recurrence schedule because all its keys are on or after `starts_on`.
- `starts_on = NULL` yields byte-for-byte equivalent date-key results to legacy behavior.

The Mini App obtains the initial and minimum `startsOn` from the authenticated dashboard user's timezone. The current `localTodayYmd()` uses the browser calendar and therefore is not suitable for this flow; add a focused, pure, testable formatter based on `Intl.DateTimeFormat` with `dashboardState.user.timezone`. Browser timezone must not determine this value.

## Canonical Server Occurrence Generation

Introduce or adapt one narrow pure server helper that returns unique sorted local `YYYY-MM-DD` occurrence keys for a requested month. Conceptually:

```text
plannedOccurrenceDateKeysForPeriod(plan, "2026-07")
```

It performs recurrence generation first and applies the optional `starts_on` lower bound second. Consumers may map keys to user-timezone instants where existing APIs require `Date` values, but they must not reproduce recurrence or start filtering.

The following server paths must inherit the canonical result:

- `plannedDueDatesThisMonth`;
- `unpaidPlannedDueDatesThisMonth`;
- `calculatePlannedRemaining`;
- `calculatePlannedTotal`, used by current reserve creation/update validation;
- `calculatePlannedThisWeek`;
- `nextUnpaidOccurrenceDate` and nearest-obligation selection;
- `resolveOccurrenceDate`, including explicit Pay validation;
- disable impact calculation for a recreated plan that is later disabled;
- server-owned `plannedMonthSummary`, forecast, free remaining, and reserved-ahead values;
- `reportUnpaidPlannedPayments`, including cross-month weekly reports;
- `plannedOccurrenceCountForPeriod`, used by planned-mutation reserve capacity and reserve closure;
- `plannedObligationsForPeriod` for active and archived factual reserve calculations.

`occurrencesThisMonth` is a second server generator even though it currently has no callers. It must either delegate to the canonical helper and return its length or be removed as a narrow dead helper. It must not receive an independent `starts_on` condition. Low-level recurrence helpers such as weekly and due-day generation may remain, but the canonical period helper owns deduplication, clamping, ordering, and the start-date lower bound.

## Paid History And Active Obligations

Start filtering changes only whether an occurrence exists for a plan. It does not reinterpret historical payment links.

- Active remaining values use unpaid canonical occurrences on or after `starts_on`.
- Pay rejects a requested date that is not a canonical occurrence, including a pre-start date, as `invalid_occurrence`.
- Pay without an explicit date selects the first eligible unpaid occurrence according to existing overdue/today/future ordering.
- Archived plans contribute only valid factual paid links where existing PR #122 calculations include history.
- Reports continue to include factual linked expenses and exclude unpaid pre-start dates.
- The next month uses the plan's full normal schedule when its dates are after `starts_on`.

## Snapshot Policy

Recreate behaves like the other planned mutations established by PR #122:

- live `plannedRemaining`, `plannedThisWeek`, `freeRemaining`, forecast, nearest obligation, and server-owned planned-month summary update immediately;
- an existing current-local-day `daily_budget_snapshot` is not deleted or replaced, so its saved `dayPlanLimit` remains fixed;
- if today's snapshot does not exist, the next dashboard creates it from the then-current active plan set;
- the next local day creates a new opening snapshot from current state.

The recreate flow must not call `invalidateDailyBudgetSnapshot`.

## Mini App Archive

Add a compact collapsible section after the active planned-expense list:

- RU title: `Отключённые`;
- EN title: `Disabled plans`;
- collapsed by default;
- no archive request during ordinary `loadDashboard`;
- the first expansion performs exactly one request;
- concurrent expansion clicks share the in-flight state and do not start another request;
- a successful result is cached for later collapse/expand cycles;
- an error remains visible without discarding active-plan state, and a later explicit reopen/retry may request again;
- a successful recreate refreshes both dashboard and archive data.

Each archived row shows description, amount/currency, recurrence, disable date, valid saved-payment count, and one `Создать снова` / `Create again` action. A null disable time is rendered exactly as `Дата отключения не сохранена` / `Disable date unavailable`; no inferred date is substituted.

Archived rows do not show Pay, Edit, Disable, unpaid progress, or nearest occurrence. Their layout must remain compact with long names and large amounts at iPhone 11 and iPhone 14 Pro widths.

## Mini App Recreate Mode

Make form intent explicit:

```js
renderPlannedForm(item, {
  mode: "create" | "edit" | "recreate",
  sourcePlannedExpenseId: null
});
```

- `create` sends ordinary POST.
- `edit` sends ordinary PATCH.
- `recreate` sends only `POST /api/planned-expenses/:sourceId/recreate`.
- The presence of `item.id` does not choose edit mode.
- The archived source ID never becomes `plannedId` and is never sent to PATCH.
- Closing, cancelling, and resetting clear recreate state without a request.

Recreate prefills editable amount, currency, description, category, tags, recurrence, weekday, due day(s), and a still-valid one-off date. It adds `Начать учитывать с` / `Start counting from`, initialized and constrained to the current user-local date. A one-off date that is today or earlier in the source is cleared so the user must deliberately choose a date that is not before `startsOn`.

The heading and submit label are `Создать снова` / `Create again`. While submitting, the button is disabled and a second submission returns without another POST. On failure the form remains open and populated and the button becomes active again.

After a successful `201`, the Mini App closes/resets the submitted form so it cannot be submitted again accidentally, then waits for both the dashboard refresh and archive refresh before showing a localized success toast. The new plan appears in active plans; the source remains in the archive. Reopening the source and confirming again is an allowed new action.

## Mini App Compatibility Occurrences

`apps/miniapp/src/planned.js` remains a compatibility fallback, not financial authority. `buildPlannedOccurrences` continues to return an empty list for `active = false`, preserves existing output for `starts_on = null`, and filters generated `YYYY-MM-DD` keys before constructing occurrence objects when `starts_on` is present.

The server's `plannedMonthSummary` remains authoritative. Client date generation must not use browser timezone to replace server-owned financial values. Pure tests keep the client recurrence/start filter aligned with canonical server examples.

## Error And Consistency Boundaries

- Archive failure does not block the active plan list or dashboard.
- Recreate validation or reserve failure leaves source, payments, expenses, snapshots, and form data unchanged.
- A transaction error rolls back the new row.
- Missing, foreign, and active sources are indistinguishable to callers.
- Ordinary create, edit, disable, and Pay contracts retain their current behavior.
- No production or persistent user database is used by tests.

## Verification Design

Tests are added red-first.

### Repository and API

- archive ownership, inactive-only selection, required ordering, and legacy null disable time;
- all-time valid payment count and factual base amount;
- orphan, foreign-owner, and duplicate-payment-key exclusion;
- missing, foreign, and active recreate sources returning the same 404 contract;
- new independent active ID, unchanged source and `disabled_at`, no copied payments, and no inserted expenses;
- two sequential confirmed recreates from one source creating two different IDs, both without inherited payments;
- strict local start-date validation and one-off due-date validation;
- reserve conflict and privacy-safe event metadata;
- route authentication and exact response shapes.

### Occurrence and financial regressions

- weekly, monthly, twice-monthly, and one-off start boundaries;
- a start between twice-monthly due dates and after all current-month due dates;
- future start, month boundary, and `starts_on = NULL` legacy equivalence;
- Asia/Bangkok and a negative UTC-offset timezone at a UTC/local-day boundary;
- current-month remaining versus next-month full schedule;
- this-week, nearest obligation, explicit and implicit Pay, reserve capacity, reserve closure, and report unpaid items;
- factual paid history from an archived source;
- unchanged current-day snapshot, immediate live monthly values, and next-local-day snapshot.

### Mini App

- collapsed-by-default archive and no eager request;
- one first-expansion request, pending-click suppression, loaded cache, loading/empty/error states, and RU/EN copy;
- null disable date, payment-count pluralization, and absence of Pay/Edit/Disable controls;
- explicit recreate mode, source-ID isolation from PATCH, user-timezone `startsOn`, and past one-off clearing;
- cancellation without a request, double-click producing one POST, populated form after error, and dashboard/archive refresh before success;
- two separate form sessions may each recreate the same source;
- ordinary create/edit behavior and server-summary precedence remain unchanged.

### Integration and visual evidence

The disposable Postgres smoke applies migrations through the actual next ledger entry, creates and pays a weekly plan, disables it, reads its archive aggregate, recreates it mid-month, verifies no copied links, checks canonical remaining/reserve values, preserves today's snapshot, and checks the next local day.

Capture RU and EN screenshots for expanded archive and recreate form at iPhone 11 and iPhone 14 Pro widths. Include a long name, large amount, null disable date, and multiple saved payments. Verify no horizontal scrolling or overflowing buttons.

Focused suites run first, followed by `npm.cmd test` and `npm.cmd run test:integration:postgres`.

## Documentation And Release Boundary

Implementation updates `CONTEXT.md`, `docs/DOMAIN_RULES.md`, `docs/DECISIONS.md`, `docs/TESTING_GUIDE.md`, and `docs/UI_PRINCIPLES.md` where the compact archive behavior belongs. The draft PR documents the additive nullable column, no-backfill and forward-fix policy, tests, screenshots, and `## User Release Notes`.

The work stops at a draft PR. It does not merge, deploy, access production, or modify real user data.
