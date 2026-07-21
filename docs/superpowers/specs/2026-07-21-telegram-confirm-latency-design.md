# Telegram Confirm Callback Latency Design

## Goal

Make a Telegram expense confirmation feel immediate by acknowledging the callback before expense persistence, while preserving the existing atomic and idempotent `saveDraftAsExpense()` operation. Add privacy-minimal confirm-flow latency diagnostics to `/admin_stats_tech`.

## Scope and Non-goals

This change applies only to the Telegram regular draft confirm flow. It does not alter the expense domain model, budget impact, currency conversion, dashboard calculations, Mini App confirmation, database schema, runtime configuration, or deployment topology. Transactional persistence semantics remain unchanged. No queue and no runtime kill-switch will be added; rollback is a normal release rollback.

## Confirm Flow

1. After existing callback routing and user resolution, invoke one early `answerCallback()` with `Сохраняю…` for Russian and `Saving…` for English. It occurs before expense persistence, not before the existing user lookup that determines language.
2. The early acknowledgement is an acknowledgement of operation start, not proof of persistence. It is attempted once only. Its failure is logged and does not stop confirmation. `callbackAckMs` measures from entry to `handleConfirmDraft()` through completion of that ACK attempt, rather than only the HTTP-call duration.
3. Call `saveDraftAsExpense(draftId, telegramUserId)`. It remains the only operation that commits a draft as expenses and enforces ownership, cancellation, valid-category, atomicity, and duplicate-confirm protection. Its post-persistence dashboard snapshot attempt is isolated from the transactional result: after a successful commit, or after determining an already-confirmed draft, a snapshot error returns the successful result with `dashboardSnapshot: null` rather than throwing a persistence failure.
4. After a successful database outcome, render and attempt to deliver the saved summary before any editor cleanup that could edit or deactivate the same Telegram message. A full summary uses its snapshot; an unavailable snapshot uses a reduced localized success summary without dashboard fields. The existing edit-in-place and send fallback behavior stays intact.
5. Only after the terminal Telegram operation, execute independent analytics and outcome-appropriate editor cleanup through explicit safe wrappers. `success` and `already_saved` close the matching editor session and deactivate obsolete editor messages; `cancelled` closes the session and leaves cards in their cancelled terminal state. `category_required` and `failed` do not run destructive cleanup, so the draft card and editor session remain usable for retry. Independent eligible cleanup operations may run concurrently. They are logged on failure and cannot change the already-visible user result or create an unhandled rejection.

`already_saved` is a successful idempotency outcome: no new expense and no repeated `expense_saved` event are created, while the summary may be displayed again.

## Error Semantics

The confirm diagnostic `outcome` describes the database save result, never Telegram delivery.

- `success`: `saveDraftAsExpense()` committed a new expense set.
- `already_saved`: an earlier confirmation already committed the expense set.
- `cancelled`: the draft cannot be saved because it was cancelled.
- `category_required`: the draft has no valid category.
- `failed`: only an unexpected persistence/technical save failure.

After early ACK, the handler must not issue a second callback answer. The measured terminal Telegram operation for each outcome is:

- `success` and `already_saved`: edit the original card into a saved summary, with a fallback send;
- `cancelled`: edit the original card into its cancelled state, with a fallback send;
- `category_required` and `failed`: send a localized explanation while leaving the original draft card intact and usable for the safe next action.

A Telegram update failure is separately logged and measured, retains `success` or `already_saved` after a successful database outcome, and must never tell the user that the saved expense failed. The diagnostic event is attempted after the terminal Telegram operation and safe background work, including when no success summary was built.

## Diagnostics

Attempt to emit `draft_confirm_processing_completed` exactly once for every confirm attempt after the terminal Telegram operation and safe background work complete. The event is best-effort and never changes the user flow. It is stored with `user_id = null`; its metadata contains no financial values, descriptions, draft IDs, expense IDs, Telegram IDs, or other identifiers.

Required metadata:

- `outcome`
- `callbackAckMs` and `callbackAckSucceeded`
- `dbSaveMs`
- `summaryBuildMs: number | null`
- `telegramUpdateMs`
- `telegramUpdateSucceeded`
- `telegramUpdateMode: "edit" | "send" | "fallback_send" | "failed"`
- `cleanupMs`
- `totalMs`
- `expenseCount: number`
- `source: "telegram"`

`summaryBuildMs` is `null` and `expenseCount` is `0` for `cancelled`, `category_required`, and `failed`; SQL avg/P95 ignores null stages. `telegramUpdateMs` includes the edit attempt and fallback send when both are attempted. `cleanupMs` is the wall-clock duration from starting the eligible cleanup group until all its tasks settle, not the sum of parallel task durations. `totalMs` runs from entry to `handleConfirmDraft()` through the terminal Telegram operation and all safe background tasks, but excludes writing `draft_confirm_processing_completed` itself. Dashboard snapshot construction is after the database transaction commit and remains part of `dbSaveMs`; its failure cannot change a persistence outcome.

`/admin_stats_tech` adds a Confirm flow section for Today and Last 7 days only when confirm attempts exist. It shows attempts and separately counts `success`, `already_saved`, `cancelled`, `category_required`, and `failed`; their sum must equal attempts. It also shows avg/P95 callback ACK and total time, plus avg/P95 DB save and Telegram update when values exist. A missing metric is omitted rather than rendered as a zero P95.

## Verification

Focused Telegram tests prove early ACK ordering, a single ACK attempt, error handling after early ACK, idempotent `already_saved`, and that summary delivery is not blocked by analytics or cleanup. They also prove cleanup begins only after the terminal Telegram operation; `category_required` and database failure keep the draft card and editor session usable for a repeat callback; best-effort analytics, cleanup, and diagnostic-event failures are contained without unhandled rejections; and a post-commit Telegram update failure retains the successful database outcome.

Repository tests prove that a successful commit followed by a failing dashboard snapshot returns `success` with no snapshot. Technical-stats tests prove each outcome aggregation, outcome reconciliation with attempts, optional-stage rendering, and no empty confirm section. Existing repository concurrency coverage remains the proof that two confirms create one expense set. `already_saved` must never emit additional `expense_saved` or `expense_draft_confirmed` events. The full `npm.cmd test` suite is required before publication.

Operational targets are ACK P95 at or below 500 ms, user summary P95 at or below 2 seconds when database and Telegram API are available, and zero duplicate expenses or repeated success analytics caused by repeat callbacks.

## User Release Note

After pressing `Save`, Telegram immediately acknowledges the action and removes the spinner; the final save result follows.
