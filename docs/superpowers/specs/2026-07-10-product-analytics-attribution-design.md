# Product Analytics, Attribution, and Admin Stats Design

## Context

Money Flow already records operational events in `app_events` and exposes a useful but long technical `/admin_stats` report. The next iteration must let an administrator understand the product in 10-15 seconds: the size and reachability of the user base, activation, retention, habits, report engagement, acquisition sources, and whether technical health has degraded.

The implementation must extend the existing event store and repository boundary. It must not introduce an external analytics platform, retain user financial content in event metadata, rewrite applied migrations, or create a web admin panel.

## Goals

- Make `/admin_stats` a compact product report.
- Move detailed parser and processing diagnostics to `/admin_stats_tech`.
- Support first-touch attribution from Telegram `/start` and Mini App `startapp`.
- Treat a valid Mini App launch as a complete first entry point, including user creation and onboarding.
- Track real bot blocked/unblocked transitions idempotently.
- Derive funnel, activation, retention, habit, reports, and source metrics from canonical events.
- Preserve existing user flows when analytics writes fail.

## Non-goals

- External analytics platforms, materialized views, charts, CSV analytics exports, or a web admin panel.
- Multi-touch attribution, UTM tooling, historical event cleanup, or a complete event taxonomy for every feature.
- Backfilling historical acquisition sources or reconstructing deleted-user attribution.
- API/webhook and scheduler error rows in `/admin_stats_tech` until safe aggregate events exist.
- Historical timezone snapshots on product events.

## Chosen Architecture

Keep `adminStatsService.js` as a backwards-compatible facade and split responsibilities behind it:

- `productStatsService.js` owns product aggregations and product report formatting.
- `technicalStatsService.js` owns the existing parser, error, and processing diagnostics and technical formatting.
- a small product analytics module owns event names, meaningful-activity names, source normalization, report marker validation, and safe metadata allowlists.

The facade preserves:

```js
getAdminStats()
```

and adds:

```js
getTechnicalStats()
```

The product and technical paths fail independently. Their safe responses are `Product stats unavailable` and `Technical stats unavailable`.

Rejected alternatives:

- Expanding the current service in place would keep fewer files but would mix cohort analytics with a large technical aggregation.
- Database views or projections would add schema and deployment complexity before the MVP volume requires them.

## Schema Migration

Create `apps/api/migrations/008_product_analytics.sql`. Do not edit `001_initial.sql`.

Add nullable columns to `users`:

```sql
acquisition_source TEXT
acquisition_first_seen_at TIMESTAMPTZ
bot_blocked_at TIMESTAMPTZ
bot_unblocked_at TIMESTAMPTZ
```

Keep the existing non-null `bot_blocked` flag.

Add a partial unique index with this semantic contract:

```sql
CREATE UNIQUE INDEX ...
ON app_events (user_id, event_name)
WHERE user_id IS NOT NULL
  AND event_name IN (
    'onboarding_started',
    'currency_selected',
    'budget_set',
    'onboarding_completed'
  );
```

The existing indexes on `created_at`, `(event_name, created_at)`, and `(user_id, created_at)` are sufficient for the MVP aggregation plan. Do not add duplicate indexes without an observed query-plan need.

There is no backfill. A legacy user's source remains `NULL` until their next valid `/start` or authenticated Mini App launch.

## Event Model

Continue using `app_events` and `repository.recordAppEvent()`. Analytics writes are best-effort: they log a safe failure and never change the result of the primary user operation.

### Repeatable events

```text
bot_started
miniapp_opened
expense_draft_created
expense_draft_confirmed
expense_draft_cancelled
expense_saved
dashboard_opened
currency_changed
budget_changed
planned_expense_created
planned_expense_updated
planned_expense_deleted
report_delivered
report_delivery_failed
report_app_clicked
feedback_sent
bot_blocked
bot_unblocked
account_deleted
```

### One-time onboarding events

```text
onboarding_started
currency_selected
budget_set
onboarding_completed
```

These events describe the initial onboarding only. Later settings changes use `currency_changed` and `budget_changed`. Repository insertion for one-time events uses `ON CONFLICT DO NOTHING`; the partial unique index is the concurrency guard.

Do not create parallel `first_*` or retention events. First occurrences are derived with `MIN(created_at)` grouped by user.

### Metadata safety

Event metadata may contain only allowlisted technical or aggregate attributes. It must not contain message or transcript text, expense descriptions or amounts, budget amounts, balances, feedback text, Telegram names, tokens, initData, full URLs, or arbitrary query parameters.

`account_deleted` keeps the existing strict contract:

```json
{ "source": "miniapp" }
```

or:

```json
{ "source": "telegram" }
```

It is inserted exactly once with `user_id = NULL` inside the existing deletion transaction. No acquisition, activation, age, personal, or financial snapshot is retained.

## First-touch Attribution

Normalize an incoming source by trimming, lowercasing, accepting only `[a-z0-9_-]`, and limiting it to 64 characters. Missing, empty, or invalid values become `direct`.

User creation/profile refresh and first-touch attribution use one SQL statement or transaction. The update contract is equivalent to:

```sql
acquisition_source = COALESCE(users.acquisition_source, incoming_source)
```

`acquisition_first_seen_at` is set with the first source and is not overwritten. A subsequent `/start`, `startapp`, report link, or other internal link cannot replace attribution.

Legacy users follow the same rule on their next valid entry. A valid source is stored; otherwise `direct` is stored. Existing legacy records that remain `NULL` are shown as `unknown` in source reporting rather than being misclassified as direct.

## Telegram `/start` Entry

For every valid `/start`:

1. Parse and normalize the optional payload.
2. Upsert the Telegram profile and first-touch source atomically.
3. If this is a new user, show onboarding and best-effort insert `onboarding_started` once.
4. Best-effort insert `bot_started` with the normalized launch source.
5. Continue the existing onboarding state; do not create a second user or reset a completed flow.

Repeated `/start` commands may create repeatable `bot_started` events but do not change first-touch attribution.

## Mini App and `startapp` Entry

Telegram initData verification must return the signed Telegram user profile and signed `start_param`, not only a Telegram user ID.

For an authenticated Mini App launch:

1. Verify initData before any user creation or event write.
2. Normalize the signed `start_param` as acquisition input.
3. Upsert the same user/profile boundary used by `/start`.
4. For a new user, set `onboarding_step = 'language'`, insert `onboarding_started` once, and return data that lets the Mini App begin onboarding instead of returning `404`.
5. Insert repeatable `miniapp_opened` after successful authorization.
6. Load dashboard/onboarding data and insert one `dashboard_opened` with the resolved source.

Unsigned query parameters, expired initData, invalid signatures, and a Telegram-ID query parameter alone cannot create a user, assign attribution, or create product events.

## Dashboard and Report Launches

An ordinary authenticated dashboard load creates one `dashboard_opened`. A report launch creates one `report_app_clicked` and one `dashboard_opened` with `source = report`; it must not also create `dashboard_opened.source = direct` for the same request.

Report markers are not acquisition sources. Validate them as follows:

- `reportType` is `weekly` or `monthly`.
- `reportKey` matches the bounded weekly or monthly key format and length.
- the authenticated user has a matching report delivery record.

Only after this validation may `report_app_clicked` be inserted.

## Onboarding and Product Mutation Events

- Insert `currency_selected` only after the initial onboarding currency save succeeds.
- Insert `budget_set` only after the initial onboarding budget save succeeds; metadata includes currency and `budgetType`, never the amount.
- Insert `onboarding_completed` only on the first transition to `completed`.
- Insert `currency_changed` and `budget_changed` after subsequent successful settings changes.
- Insert planned-expense create/update/delete events only after their corresponding mutations succeed.
- Insert `feedback_sent` only after feedback is stored, with source metadata and no feedback text.
- Existing expense draft and saved events remain canonical and are reused.

## Blocked and Unblocked State

Repository methods own idempotent state transitions.

On `false -> true`:

- set `bot_blocked = true` and `bot_blocked_at = now()` atomically;
- return that a real transition occurred;
- best-effort insert one `bot_blocked` event.

On `true -> false`:

- set `bot_blocked = false` and `bot_unblocked_at = now()` atomically;
- return that a real transition occurred;
- best-effort insert one `bot_unblocked` event.

Repeated identical states do not write events.

Handle `my_chat_member` only for private chats and confirmed transitions between available and unavailable `new_chat_member.status` values. Ignore groups, channels, unknown users, and redelivered identical state.

For an ordinary incoming message, first upsert the user, then clear a stale blocked flag before routing `/start`, other commands, or the expense flow. An unknown user is created by the normal upsert, never by a blocked-state transition.

Only a Telegram error with confirmed blocked semantics may trigger the fallback transition. Timeout, rate limiting, Telegram 5xx, network, malformed HTML, and unconfirmed chat-not-found errors do not mark a user blocked.

## Report Delivery Events

The report delivery table remains the source of truth.

For success:

1. Telegram send succeeds.
2. The delivery row is saved as sent.
3. `report_delivered` is inserted best-effort.

Failure to record the event does not roll back delivery and cannot cause another user message.

For each failed attempt, save the delivery failure first and then insert one `report_delivery_failed` best-effort. Its `errorType` is one of:

```text
blocked
rate_limited
telegram_5xx
network
unknown
```

Retries may therefore create multiple failure events. A failure is never counted as delivered.

## Product Metric Definitions

### Periods

- `Today` uses the existing local-day boundary behavior.
- `Last 3 days`, `Last 7 days`, and `Last 30 days` are rolling intervals ending at the current time, preserving the current admin stats period model.

For each period calculate active users, new users, saved expenses, expenses per active user, draft counts and confirm rate, activity on distinct days, feedback, newly blocked, newly unblocked, and deleted accounts. Last 7 days includes users active on two or more days; Last 30 days includes users active on three or more days.

### Meaningful activity

A user is active when they have at least one of:

```text
expense_draft_created
expense_draft_confirmed
expense_saved
dashboard_opened
report_app_clicked
feedback_sent
currency_changed
budget_changed
planned_expense_created
planned_expense_updated
planned_expense_deleted
```

Automatic report delivery, reminders, release digests, health checks, background jobs, `bot_started` without a subsequent action, and `report_delivered` are not meaningful activity.

### User base

```text
reachable_now = current users where bot_blocked = false
blocked_now = current users where bot_blocked = true
deleted_all_time = anonymous account_deleted events
all_time_joined = reachable_now + blocked_now + deleted_all_time
```

Rejoined users after deletion may be counted as a new current user plus an earlier anonymous deletion. This is an accepted consequence of privacy-preserving deletion.

### Funnel and activation

The funnel cohort contains only current users whose `users.created_at` is within the last 30 days and who have a `bot_started` or `miniapp_opened` event after creation. This prevents an older user who presses `/start` after analytics ships from appearing newly joined.

```text
first_started_at = MIN(bot_started.created_at, miniapp_opened.created_at)
```

Count unique users at each step, with the event occurring after the user's first start:

```text
Started
Onboarding started
Onboarding completed
First draft created
First expense saved
Dashboard opened
```

Activation is canonically the first `expense_saved`, not draft confirmation. Each step percentage uses `Started` as the denominator. The median activation time is the median duration from `first_started_at` to the first subsequent `expense_saved`.

### Retention

D1 and D7 use the same users-created-within-last-30-days cohort and only meaningful activity.

- D1 return window: `[first_started_at + 24h, first_started_at + 48h)`. Include only users at least 48 hours old in the denominator.
- D7 return window: `[first_started_at + 6d, first_started_at + 8d)`. Include only users at least 8 days old in the denominator.

An empty eligible cohort renders as `—`, not `0%`.

### Habit

`Habit started in first 7d` means at least two `expense_saved` events on two distinct local dates during the first seven elapsed days after first start. Convert each event using the user's current `users.timezone`. Include only users whose cohort has matured for seven days.

Changing timezone may alter historical day grouping. Storing historical timezone per event is out of scope for the MVP.

### Reports

For the last 30 days show unique users with successful deliveries, unique users with validated report clicks, failed delivery attempts, and CTR:

```text
unique clicked users / unique delivered users
```

Repeated clicks do not inflate CTR. Automatic delivery does not make the user active; a validated click does.

### Sources

For users created in the last 30 days, show started users, activated users, and activation rate by first-touch source. Sort by started descending, activated descending, then source ascending. Show the top five and aggregate the rest as `other`.

Current legacy users with a `NULL` source render as `unknown`. Deleted-user sources cannot be reconstructed and are excluded.

### Health

The product report's Health block uses Last-7-days parse failure rate, transcription failures, and text/voice P95 processing. Do not invent API/webhook or scheduler metrics from logs; omit those lines for this iteration.

## Query Plan

Product analytics uses a small number of grouped queries, not one query per output line:

- user base;
- four-period aggregates;
- funnel/median/retention/habit CTEs;
- report and source aggregates;
- Last-7-days health.

Technical stats reuse the current aggregate approach for Today and Last 7 days. No materialized views are introduced. Index additions beyond the onboarding uniqueness index require a demonstrated query-plan need.

## Telegram Commands and Formatting

Both commands require membership in `ADMIN_TELEGRAM_IDS`. Everyone else receives exactly `Access denied`.

`/admin_stats` contains:

```text
User base
Today
Last 3 days
Last 7 days
Last 30 days
Activation
Retention
Reports
Sources
Health
```

`/admin_stats_tech` contains the existing useful technical sections for Today and Last 7 days:

```text
Traffic
Errors
Processing
Processing stages
Parser routing and averages
Review
Shadow
Rejects
Shadow fields
```

Use Telegram HTML with only `<b>` and `<code>`. Escape every dynamic source, reject reason, shadow field, and other dynamic value. Do not mix Markdown into HTML mode.

Formatters produce logical sections. Split messages only between whole sections and keep every part at or below 3900 characters. Never split a source, reject, or shadow-fields row. Each part has balanced HTML and an independent plain-text fallback.

Missing values render as `—`. Product and technical formatter failures remain isolated.

## Error Handling and Privacy

- Product event failures never fail user creation, onboarding, mutations, dashboard loads, report delivery, feedback, or blocking transitions.
- Event failure logs contain only safe identifiers already permitted by current observability and never event payloads with user content.
- Invalid source and report parameters are normalized or rejected before event storage.
- No financial or user-authored content is added to analytics metadata.
- The existing account deletion transaction and minimal audit event remain intact.

## Test Strategy

Every behavioral slice follows red-green-refactor. Required focused coverage includes:

- migration columns and partial unique-index behavior: identical onboarding duplicates conflict or become no-ops, different onboarding events coexist, and repeatable events remain repeatable;
- source normalization and concurrent first-touch upsert;
- `/start` user creation, repeat launches, profile refresh, and immutable attribution;
- valid `startapp` user creation at `language`, invalid/expired initData rejection, repeat launch deduplication, and unsigned parameter rejection;
- one-time onboarding events and later settings events;
- safe metadata for budget, feedback, reports, and account deletion;
- report success/failure ordering, allowlisted error types, delivery-backed clicks, and unique-user CTR;
- idempotent blocked/unblocked transitions, private `my_chat_member`, incoming-message recovery, and blocked-error fallback;
- period boundaries, user base, unique-user funnel steps, users-created cohort filtering, median activation, mature D1/D7 cohorts, timezone habit days, sources, and absent-data rendering;
- HTML escaping, balanced chunks no longer than 3900 characters, complete rows, and independent plain-text fallback;
- both admin commands, access denial, dependency absence, and isolated unavailable responses;
- existing admin stats, Telegram, repository, auth, reports, migrations, and full-suite regression.

Verification order:

1. Focused test file after each TDD slice.
2. Related API/Telegram/report suites.
3. `npm.cmd test`.
4. `git diff --check`.

## Documentation and Release

Update the domain glossary and decision log for first-touch attribution, activation, meaningful activity, retention, reachability, derived first-event metrics, and minimal deletion audit. Keep product, domain, and testing documentation synchronized with user-visible behavior.

The draft PR includes redacted real output examples for both commands, DB/prod impact, tests run, limitations, and `## User Release Notes`. User release notes mention only user-visible changes; they do not describe internal services, SQL, indexes, or event taxonomy.

No production migration, deployment, merge, rollback, or database write is authorized by this task.

## Accepted Limitations

- No source backfill; legacy `NULL` appears as `unknown` until a valid new entry fills first-touch attribution.
- Deleted-user funnel and source history cannot be recovered.
- A deleted user who rejoins can contribute both an anonymous historical deletion and a new current user.
- Habit uses the user's current timezone for historical grouping.
- Product Health omits API/webhook and scheduler error rows until safe aggregate events exist.
- Analytics event loss is possible when a best-effort event insert fails; primary product behavior remains correct.
