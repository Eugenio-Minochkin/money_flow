# Telegram Expense Editor Design

## Goal

Let a user correct an expense directly in Telegram before and after saving, while preserving Money Flow's existing budget, reserve, timezone, and Mini App semantics. The editor is one shared UX for a draft, a saved expense, and `/last`; it is not a replacement for the Mini App editor.

## UX

### Draft

The parsed single-expense card shows the current budget treatment and a short explanation:

- `✅ Сохранить` / `✅ Save` stays the primary action.
- `regular` renders `◉ Учесть сегодня` / `◉ Count today` and `○ Распределить до конца месяца` / `○ Spread across remaining days`.
- `large_oneoff` renders `○ Учесть сегодня` / `○ Count today` and `◉ Распределить до конца месяца` / `◉ Spread across remaining days`.
- The card explains that the first option reduces today's limit, while the second keeps the whole expense in the month without subtracting it in full today.
- `✏️ Исправить` opens the Telegram editor; it never opens Mini App.
- `🗑 Отменить`, review-later, and Mini App remain separate actions.

The selected treatment persists in `draft.items[itemIndex].budget_impact`. Selecting the already selected treatment answers a callback toast without attempting a Telegram message edit.

For a multi-item draft, Edit first shows an item selector. The shared draft card has no budget-treatment radio buttons; they appear only after an item is selected. No action silently changes item zero.

### Editor

The editor displays amount/currency, description, category, date/time, tags, and budget treatment. It has shared pure renderers and keyboard builders, while target adapters apply the change to either a draft item or a saved expense.

- Amount accepts a positive finite amount with an optional currency and reuses existing normalization and rounding.
- Description changes `description`, never `source_text`.
- Category uses existing localized labels, compact quick choices, then a paginated full list.
- Date/time is parsed in the user's timezone. A date without a year resolves to the nearest prior local calendar occurrence. A time later today and every explicitly future ordinary expense are validation errors that retain the editor session.
- Tags reuse existing normalization and length limits; `-` clears all tags.
- `🗑 Отменить` while a text field is pending cancels only that input and returns to the editor. Cancelling a draft remains a distinct card action.

Every successful field change renders the editor again by editing the same Telegram message. `✅ Готово` returns to the current draft or saved-expense card.

### Saved Expenses, `/last`, and Delete

The post-save card keeps the current familiar `✅ Записал` summary, including Today and Month blocks. Its keyboard adds `✏️ Исправить`, `🗑 Удалить`, and a final `📱 Открыть Mini App` row.

`/last` returns the most recently created, still-existing user expense with `created_at DESC, id DESC`. It excludes planned expenses and uses neither `spent_at` nor `updated_at`. A backdated expense is therefore available immediately. If no eligible expense exists, the bot returns the approved localized empty state.

Delete is two-step. A stale, repeated, foreign, or already deleted callback produces a safe alert, never a 500 or data disclosure.

## Input Sessions And Callbacks

Add `telegram_input_sessions` as repository-backed routing state, not as a business-rule store. It has an internal `user_id` FK; target type/id; nullable draft `item_index`; expected field; chat/message references; language; expiry; status; and timestamps. A partial unique index permits only one busy (`active` or `processing`) session per user.

An active session lasts 15 minutes. Creating a new edit intent atomically finishes the previous active session, but never replaces a `processing` session: it waits for the current transaction or returns `input_in_progress`. A text consumer locks the row, temporarily marks it `processing`, parses the input, invokes the target adapter, performs any required snapshot invalidation, and marks the session `completed` using the same DB client and one transaction. `processing` is never committed as a durable intermediate state. Validation and system errors roll the transaction back, retaining the active session and unchanged target. A concurrent second consumer receives a non-mutating `already_consumed` or `session_not_claimable` outcome and its message never reaches the parser or LLM. Completed rows remain only for cleanup/debug and never route a new message. An expired-unconsumed session intercepts at most one later text message, marks itself consumed (for example with `late_input_consumed_at`), and returns the expiry message instead of reaching the expense parser or LLM; later cleanup may remove it. Voice and photo during a pending text session prompt for text and retain the session.

Callback payloads remain below Telegram's 64-byte limit. They carry compact target/action data only and are never authorization. Every callback and input application re-checks ownership, target state, and closed-month rules at the repository boundary. Missing, deleted, stale, and non-owned targets return the same generic localized alert without revealing whether an expense exists; for example, `Расход больше недоступен. Открой последний расход через /last.`

## Financial Integrity

All saved-expense update/delete paths are repository transactions. They lock the owned expense with `FOR UPDATE`, derive source and target local months in `users.timezone`, acquire compatible per-user/per-month reserve locks in deterministic sorted `month_key` order, enforce both months' state, apply the change, conditionally invalidate the daily snapshot, and commit together. Currency-rate resolution should occur before this transaction where possible, with ownership and closed-state checks repeated before writing. Repository failures are stable domain codes (for example `expense_source_month_closed`, `expense_target_month_closed`, `expense_future_date`, `expense_not_found`, and `expense_delete_blocked`); Telegram and Mini App map codes to localized text.

A month with a closed reserve is financially closed:

- Allowed: description, category, and tags only.
- Blocked: amount, currency, `spent_at`, budget treatment, deleting, moving within the month, moving out of it, and moving another expense into it.
- The repository returns stable domain error codes. Telegram and Mini App map them to the approved RU/EN validation messages and keep the edit session active when the error is recoverable.

Closed reserve snapshots and close events remain immutable. Reopening or recalculating a closed month is explicitly out of scope.

Daily budget snapshots are opening baselines. Conditional invalidation is part of the same transaction but is not automatic:

- Do invalidate when old or new current-month financial state changes today's opening baseline: prior-day `regular` changes/moves, current-month `large_oneoff` changes/deletes, or a `regular`/`large_oneoff` transition.
- Do not invalidate for metadata-only changes, a same-day `regular` amount change, or changes confined to prior months that do not affect the current opening baseline.

History, totals, categories, analytics, and heatmaps read live expense rows and need no separate historical snapshots.

## Architecture

Keep the common UX small and reusable:

- Telegram renderer and keyboard modules build draft/saved cards, edit menus, treatment controls, selectors, deletion confirmation, and localized copy.
- A callback protocol router dispatches compact editor actions.
- An input parser/validator handles each text field before target mutation.
- Draft and expense target adapters isolate `updateDraftItem` from saved-expense transactional updates.
- Repository methods own sessions, locking, closed-month checks, latest-expense lookup, mutation, and snapshot invalidation.
- Analytics emits best-effort safe event names and enum-only metadata; analytics failure never blocks the flow.

## Tests And Manual Verification

Use red-first focused tests for keyboard labels/payload sizes, renderer copy, callback handling, draft and expense adapters, invalid input retry, session TTL/concurrency, voice/photo interception, `/last`, delete idempotency, ownership, multi-item selection, and RU/EN coverage.

Add Postgres integration coverage for migration constraints, partial-active-session uniqueness, session consumption, atomic rollback, source/target closed-month locking, conditional snapshot invalidation, and `/last` ordering with backdated and planned rows. Then run `npm.cmd test`, `npm.cmd run test:integration:postgres`, and `git diff --check`.

Before the PR, validate the listed flows with `/dev` and the development Telegram client in RU and EN, including visual `◉ / ○` states and screenshots. The PR includes the required release notes, database impact and forward-fix notes, screenshots, and the manual-check record.
