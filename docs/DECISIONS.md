# Money Flow Decision Log

This is a lightweight log for product and domain decisions that future agents should preserve unless the user explicitly asks to revisit them.

## 2026-06-29 - Agents Must Start From Fresh Master

Codex and other agents must fetch and fast-forward local `master` from `origin/master` before changing files or creating a task branch. Task branches start from fresh `master` / `origin/master`, not stale local history. Agents must verify that repository instruction files such as `AGENTS.md` and required docs such as `docs/superpowers/` exist locally before editing. If sync fails, the branch has diverged, required instruction/docs files are missing, or the working tree is unexpectedly dirty, agents stop and ask the user. They must not create missing instruction files from scratch or use destructive recovery such as `git reset --hard`, `git stash`, branch deletion, or overwriting local files without explicit approval for that exact action.

## 2026-06-29 - Agents Work Through Pull Requests

Codex and other agents must treat `master` and production as protected. They work on short-lived branches, open GitHub PRs into `master`, send the PR link for review, and stop unless the user explicitly asks to merge or deploy. Agents must not change production data or run database write operations without explicit approval for the exact operation. Agent work should use `grill-with-docs` / "grill with docs" and `superpowers`, ask clarifying questions for ambiguous domain/data/security/product changes, and document assumptions in the PR.

## 2026-06 - Keep Settings Compact

Settings already contain budget, currencies, planned payments, reserve, language, theme, and backup. Keep the surface compact so it does not start feeling like an admin panel.

## 2026-06-30 - Budget Top-ups Are Monthly Budget Adjustments

Budget top-ups are modeled as one-off additions to a specific month budget, not as income accounting, salary recurrence, transfers, or cashflow analytics. They live in their own draft and confirmed tables, are added on top of the regular monthly budget or month override, and are soft-deleted on undo so confirmation is idempotent and audit-friendly.

On month boundaries, Telegram MVP confirmation refuses previous-month top-ups instead of showing a dashboard snapshot for the wrong current month. Remaining budget and top-ups never roll over automatically; carry-over, moving leftovers to reserve, and adding leftovers to the next month are future explicit actions.

## 2026-06 - Do Not Expand Reserve Before MVP Without Explicit Request

Reserve is already useful and complex enough for the MVP. Avoid multiple reserves, savings goals, and advanced reserve planning unless the user asks for that direction.

## 2026-06 - Save Overdue Planned Payments By Occurrence Date

Analytics should reflect the financial period a planned payment belongs to, not the date when the user clicked the payment button.

## 2026-06-26 - Planned Payment Paid Status Source Of Truth

A planned occurrence is paid when `planned_expense_payments` holds a row for that planned expense and occurrence whose linked expense exists and belongs to the same user. The local date of the linked expense (`expenses.spent_at`) is history/statistics placement only and must not decide paid status or allow a duplicate Pay. This rule shipped in PR #34, was accidentally reverted in PR #61 (daily reminders), and was restored on 2026-06-26. See ADR 0001.

## 2026-06 - Keep Dashboard Compact

The dashboard should clearly show the state of money and budget, not turn into a dense analytics screen.

## 2026-06 - Use User Timezone For Local Dates

Local days, weeks, months, daily budget snapshots, history filters, planned payments, and daily reminders use `users.timezone`. Timestamps remain stored in UTC and historical transactions are not rewritten when timezone changes. The default and fallback timezone is `Asia/Bangkok`.

## 2026-06 - Daily Empty-Day Reminder Is A Safe MVP

The daily empty-day reminder uses a kill switch, rollout percentage, 48-hour frequency cap, idempotent delivery rows, no-spending marks, and Telegram blocked/forbidden logging. It is not a full experimentation or holdout platform.

## Draft confirm flow (2026-06-25)
- One draft maps to N expenses (unchanged). Confirm is an atomic in-transaction CAS (`pending|inbox → confirmed`) with in-transaction category validation; a losing concurrent confirm returns the already-created expenses (`alreadySaved: true`) instead of throwing.
- Cancel is a CAS guarded to open states; it is a no-op on a `confirmed` draft and never deletes an expense.
- Every draft mutation bumps `version` for Mini App↔Telegram optimistic locking (PATCH honors `expectedVersion`, returns 409 on conflict).
- `category_source` (`parser`|`user`) lives per-item in `items` JSONB (set by both parser paths); parser-fallback `other` blocks confirm, user-chosen `other` is valid.
- Telegram quick keyboard dropped Planned; type uses `🔘/⚪`, category uses `✅/⬜`; new `d:<id>:<action>` callback scheme (legacy callbacks remain supported). All callback_data ≤ 64 bytes.
- Both inline and Mini App confirm/cancel edit the original Telegram message in place using stored `tg_chat_id`/`tg_message_id`, with a send-new fallback. "message is not modified" is swallowed.
