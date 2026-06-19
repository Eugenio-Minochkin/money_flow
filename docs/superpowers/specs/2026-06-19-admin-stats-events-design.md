# Admin Stats Event Instrumentation Design

## Goal

Populate `/admin_stats` from real Telegram activity while preserving historical
counts from existing expense and draft tables where event history is absent.

## Root Cause

`adminStatsService.js` reads message, draft, expense, error, active-user, and
processing metrics from `app_events`. The migration creates that table, but the
normal Telegram bot flow never inserts events. New-user counts can still work
because they are queried from `users.created_at`; most other metrics remain
zero.

## Event Recording Boundary

Add `recordAppEvent(userId, eventName, metadata = {})` to the repository.

The method inserts:

- `user_id`
- `event_name`
- JSON metadata

Event recording is best-effort observability. The method catches database
errors, writes a structured warning that contains the event name and user ID,
and resolves without throwing. A logging outage must never reject a Telegram
message, draft operation, or callback.

## Telegram Instrumentation

Only normal expense inputs are counted as messages. Recognized bot commands,
including admin commands, are handled before instrumentation and are excluded.

The input type is derived as:

- `photo` when the message contains a photo
- `voice` when it contains voice or audio
- `text` when it contains text

The flow records:

- `message_received` once when a normal expense input is accepted for
  processing, with `metadata.inputType`.
- `expense_draft_created` after either a regular or planned draft is created.
- `expense_draft_confirmed` after either a regular or planned draft is
  confirmed.
- `expense_saved` once for every expense inserted by regular draft
  confirmation. Confirming a planned draft does not create an expense and does
  not emit `expense_saved`.
- `expense_draft_cancelled` after either a regular or planned draft is
  cancelled.
- `expense_parse_failed` when parsing completes without expenses or processing
  fails in a parsing path.
- `voice_transcription_failed` when voice transcription throws.
- `message_processing_completed` when processing ends, with `inputType` and
  `processingTotalMs`.

Processing completion is emitted from a `finally` boundary around queued
expense processing so success and handled failure paths both produce duration
data. Duration is measured with an injected or standard monotonic-compatible
clock local to the operation; it is not derived from trace log text.

Photo messages are counted as received photo inputs. Since the current bot has
no photo parsing implementation, they follow the existing unsupported/failed
path and produce a parse-failed event without being treated as text.

## User Identity

`app_events.user_id` references the internal `users.id`, not the Telegram user
ID. Message processing already has the internal user after
`upsertTelegramUser`. Callback processing fetches the user by Telegram ID and
uses its internal ID for confirm/cancel events.

If a callback cannot resolve an internal user, the user operation follows its
existing behavior and event recording is skipped rather than inserting an
ambiguous ID.

## Historical Fallback

For each period, `adminStatsService` queries event aggregates and historical
table aggregates. Events take precedence per metric; fallback is used only
when the relevant event count is zero.

Fallback sources:

- `expensesSaved`: count `expenses.created_at` within the period.
- `draftsCreated`: count `drafts.created_at` plus
  `planned_drafts.created_at`.
- `draftsConfirmed`: count non-null `confirmed_at` within the period from both
  draft tables.
- `draftsCancelled`: count rows with `status = 'cancelled'` and
  `created_at` within the period from both draft tables.

The schema has no `cancelled_at`, so cancellation fallback is explicitly an
approximation by creation period. New event data gives accurate cancellation
timing going forward.

Message counts, active users, parse/transcription failures, and processing
averages cannot be reconstructed reliably from domain tables and remain
event-based.

Fallback values are not added to non-zero event values. This avoids double
counting after instrumentation is deployed.

## Rates and Formatting

The existing output format remains unchanged.

- Confirm rate uses the selected created and confirmed draft values after
  fallback.
- Parse-failed rate remains event-based.
- Processing averages continue to read numeric
  `message_processing_completed.metadata.processingTotalMs` values and convert
  milliseconds to seconds.

## Testing

Repository tests verify that:

- valid event data is inserted with JSON metadata;
- insert failure is swallowed and safely warned.

Telegram tests verify:

- normal text input emits received, draft-created, and processing-completed
  events;
- confirm emits draft-confirmed and one expense-saved event per inserted
  expense;
- cancel emits draft-cancelled;
- empty parse and transcription errors emit failure events;
- event-recording failures do not break user-visible processing;
- `/admin_stats` and other recognized commands are not counted as normal
  messages;
- admin authorization behavior remains unchanged.

Admin stats tests verify:

- event metrics and processing averages are used when present;
- expenses and regular/planned draft counts fall back to historical tables
  when event counts are zero;
- new users still come from `users.created_at`;
- the formatted message shows non-zero values and processing averages.

## Acceptance Criteria

After deployment, one normal expense message followed by confirmation causes:

- active users to increase;
- total and input-specific messages to increase;
- drafts created to increase;
- drafts confirmed to increase after confirmation;
- expenses saved to increase once per inserted expense;
- average processing to be populated from completion events.

Admin commands remain excluded from message metrics, admin access remains
unchanged, and event logging failures do not affect the user flow.
