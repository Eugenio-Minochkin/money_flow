# Money Flow Decision Log

This is a lightweight log for product and domain decisions that future agents should preserve unless the user explicitly asks to revisit them.

## 2026-06 - Keep Settings Compact

Settings already contain budget, currencies, planned payments, reserve, language, theme, and backup. Keep the surface compact so it does not start feeling like an admin panel.

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
