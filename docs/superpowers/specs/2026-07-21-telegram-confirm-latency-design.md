# Telegram Confirm Callback Latency Design

## Goal

Make a Telegram expense confirmation feel immediate by acknowledging the callback before database work, while preserving the existing atomic and idempotent `saveDraftAsExpense()` operation. Add privacy-minimal confirm-flow latency diagnostics to `/admin_stats_tech`.

## Scope and Non-goals

This change applies only to the Telegram regular draft confirm flow. It does not alter the expense domain model, budget impact, currency conversion, dashboard calculations, Mini App confirmation, database schema, runtime configuration, or deployment topology. No queue and no runtime kill-switch will be added; rollback is a normal release rollback.

## Confirm Flow

1. After callback routing and user resolution, invoke one early `answerCallback()` with `Сохраняю…` for Russian and `Saving…` for English.
2. The early acknowledgement is an acknowledgement of operation start, not proof of persistence. It is attempted once only. Its failure is logged and does not stop confirmation.
3. Call `saveDraftAsExpense(draftId, telegramUserId)` unchanged. It remains the only operation that commits a draft as expenses and enforces ownership, cancellation, valid-category, atomicity, and duplicate-confirm protection.
4. After a successful commit, render and attempt to deliver the saved summary before any editor cleanup that could edit or deactivate the same Telegram message. The existing edit-in-place and send fallback behavior stays intact.
5. Only after the summary update attempt, execute independent analytics and editor-cleanup tasks through explicit safe wrappers. Independent cleanup operations may run concurrently. They are logged on failure and cannot change the already-visible user result or create an unhandled rejection.

`already_saved` is a successful idempotency outcome: no new expense and no repeated `expense_saved` event are created, while the summary may be displayed again.

## Error Semantics

The confirm diagnostic `outcome` describes the database save result, never Telegram delivery.

- `success`: `saveDraftAsExpense()` committed a new expense set.
- `already_saved`: an earlier confirmation already committed the expense set.
- `cancelled`: the draft cannot be saved because it was cancelled.
- `category_required`: the draft has no valid category.
- `failed`: only an unexpected persistence/technical save failure.

After early ACK, the handler must not issue a second callback answer. `cancelled` changes the original card into its cancelled state. `category_required` and a save `failed` result do not show a success summary and leave the original draft card usable for the safe next action; they send a clear localized explanation. A Telegram summary-update failure after a successful commit is separately logged and measured, retains `success` or `already_saved`, and must never tell the user that the saved expense failed.

## Diagnostics

Emit exactly one best-effort `draft_confirm_processing_completed` event for every confirm attempt after the summary update attempt and safe background work complete. It stores no financial values, descriptions, internal IDs, or Telegram IDs.

Required metadata:

- `outcome`
- `callbackAckMs` and `callbackAckSucceeded`
- `dbSaveMs`
- `summaryBuildMs`
- `telegramUpdateMs`
- `cleanupMs`
- `totalMs`
- `expenseCount`
- `source: "telegram"`

`callbackAckMs` records the duration of a completed or failed ACK attempt. Dashboard snapshot construction is already after the database transaction commit and remains part of `dbSaveMs`.

`/admin_stats_tech` adds a Confirm flow section for Today and Last 7 days only when confirm attempts exist. It shows attempts and separately counts `success`, `already_saved`, `cancelled`, `category_required`, and `failed`; their sum must equal attempts. It also shows avg/P95 callback ACK and total time, plus avg/P95 DB save and Telegram update when values exist. A missing metric is omitted rather than rendered as a zero P95.

## Verification

Focused Telegram tests prove early ACK ordering, a single ACK attempt, error handling after early ACK, idempotent `already_saved`, and that summary delivery is not blocked by analytics or cleanup. They also prove cleanup begins only after summary update has been attempted and that best-effort failures are contained.

Technical-stats tests prove each outcome aggregation, outcome reconciliation with attempts, optional-stage rendering, and no empty confirm section. Existing repository concurrency coverage remains the proof that two confirms create one expense set. The full `npm.cmd test` suite is required before publication.

## User Release Note

After pressing `Save`, Telegram immediately acknowledges the action and removes the spinner; the final save result follows.
