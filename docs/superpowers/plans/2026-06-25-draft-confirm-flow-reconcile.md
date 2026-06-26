# Draft Confirm Flow — Reconciliation against origin/master (a39d29d)

The implementation plan (`2026-06-25-draft-confirm-flow.md`, on branch `master`) was
written against an older checkout. The worktree `kilo/draft-confirm-flow` is based on
`origin/master` at commit **a39d29d** ("add daily empty-day reminders (#61)"), which is a
clean, green baseline (**481 tests, 0 fail**). This file records the deltas implementers
must apply to the plan.

## Baseline
- Branch: `kilo/draft-confirm-flow`, based on `origin/master` @ `a39d29d`.
- Tests: `npm test` → 481 pass / 0 fail.
- Repo is a busy multi-agent workspace; this worktree is isolated on its own branch.

## Plan assumptions: status
- **P1–P5, P7–P12 HOLD** (the plan's described baseline matches a39d29d).
- **P6 BROKEN**: the confirm handler **already edits the original message in place**
  (with a `sendMessage` fallback on failure). The plan's "switch inline confirm to
  edit-in-place" is therefore **already done** — do not duplicate; preserve it.

## Locate methods BY NAME (line numbers shifted; the plan's `:NNN` refs are stale)
Current line numbers in this worktree:
- repository.js: `createDraft` ~919, `updateDraftItems` ~1015, `confirmDraft` ~1045,
  `cancelDraft` ~1107, `moveDraftToInbox` ~1116, `normalizeDraftItem` ~1850.
- telegram.js: `handleCallback` ~748–928, confirm branch ~858–892, cancel branch ~894–912,
  `editMessageText` ~1103–1129, `botText` ~1439–1518.
- telegramKeyboards.js: `draftKeyboard` 1–37.
- telegramFormat.js: `formatSavedSummary` 33–76, `formatSavedExpenseLines` 78–93.
- server.js: draft routes ~394–429.
- miniapp/app.js: `renderDraftEditor` ~1152, `saveDraftItems` ~1364, `confirmDraft` ~1372,
  `closeDraftEditor` ~1204, `collectItem` ~1411, `bindInboxActions` ~853.

## Task-specific adjustments

### Task A7 (saved summary) — SIMPLIFIED
`formatSavedSummary(total, snapshot, { language, expenses })` **already exists** and already
renders saved-expense lines via `formatSavedExpenseLines` (single item → `category · title · amount`).
Do **not** create a separate `renderSavedMessage`. Instead:
- Keep `formatSavedSummary(total, snapshot, { language, expenses })` as the single shared
  saved-summary entry used by BOTH the Telegram confirm handler and the server `POST /confirm`.
- Verify `formatSavedExpenseLines` (telegramFormat.js:78–93) renders a **list + total** for
  `expenses.length > 1` (multi-item). If it only joins lines without a total, add a total line
  for the multi-item case. Single-item behavior stays as-is.
- `setDraftMessageRef` (new repo method) is still required (Phase C).

### Confirm handler (Phase B/C) — PRESERVE existing behavior
The current confirm branch (telegram.js:858–892) already: computes dashboard, calls
`safeRecordAppEvent(repository, user?.id, "expense_draft_confirmed", …)` and per-expense
`"expense_saved"`, edits the message in place to the saved summary with `appKeyboard`, and
falls back to `sendMessage` on edit failure. The new `handleConfirmDraft` must:
- Call the shared `saveDraftAsExpense(draftId, telegramUserId)` and use its returned
  `{ expenses, dashboardSnapshot, alreadySaved }` (stop calling `repository.dashboard(...)`
  separately — the snapshot is computed inside `saveDraftAsExpense`).
- Render via `formatSavedSummary(total, dashboardSnapshot, { language, expenses })`.
- **Preserve** the `safeRecordAppEvent(...)` calls and the edit-in-place + fallback logic.
- Add: on `DraftCanceledError` → alert `draftCanceledAlert`; on `CategoryRequiredError` →
  alert `chooseCategoryAlert`; on `alreadySaved` → `alreadySavedCallback` toast (still edit
  the message to the saved summary).

### botText keys
Existing: `cancelDraftMessage` ("❌ Entry cancelled" / "❌ Запись отменена"), `draftCancelled`
(currently unused), `savedCallback`, `cancelledCallback`, `movedToInbox`, `movedCallback`,
`plannedCancelMessage` (note: not `plannedCancelled`). Add new keys (Phase B4):
`draftCanceledMessage`, `chooseCategoryAlert`, `draftCanceledAlert`, `alreadySavedCallback`.

### server.js `POST /api/drafts/:id/confirm` (Phase C)
Currently returns only `{ expenses }` and lets "Draft is already closed"/"not found" throw → 500.
New version: call `saveDraftAsExpense`, return `{ expenses, dashboardSnapshot, alreadySaved }`,
map `DraftCanceledError` → 409 `{ error: "draft_canceled" }`, `CategoryRequiredError` → 422
`{ error: "category_required" }`.

### miniapp note (existing inconsistency)
The inbox-row confirm path (app.js ~863–870) confirms **without** calling `saveDraftItems`
first, while the in-editor `confirmDraft` saves items first. Leave this as-is unless a task
explicitly touches it.

## Execution model
Subagent-driven: fresh implementer per task (task text provided in the dispatch prompt — do
not rely on reading the plan file), then spec-compliance review, then code-quality review.
All work happens in this worktree. Tests gate every task (`npm test`).
