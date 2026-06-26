# Money Flow Domain Rules

This file records stable product and business rules. Read it before changing budget, planned payment, reserve, onboarding, dashboard, or currency behavior.

## Monthly Budget

- The monthly budget is the user's main recurring budget.
- A temporary current-month budget is only for users going through mid-month onboarding.
- A temporary current-month budget must disappear in the next month.
- Existing users must not get a temporary current-month budget unless they are in the dedicated mid-month onboarding state.

## Planned Payments

- Supported recurrence types are `monthly`, `weekly`, `twice_monthly`, and `one_off`.
- Each planned payment occurrence has its own occurrence date.
- When the user pays an overdue planned payment, the created transaction must use the occurrence date, not today's date.
- Planned payment local dates are interpreted in the user's IANA timezone.
- Disabled planned payments must not be included in active monthly totals.
- Weekly planned payments must not be counted more than once for the same target week.
- One-off planned payments must not repeat in the next month.
- The source of truth for whether a planned occurrence is paid is `planned_expense_payments` (matching the planned expense and occurrence), not the local date of the linked expense. A payment row counts as paid as long as its linked expense exists and belongs to the same user; `expenses.spent_at` is history placement and must not make an otherwise valid payment appear unpaid or allow a duplicate Pay.

## Timezone

- Store timestamps in UTC.
- Interpret local days, weeks, months, daily budget snapshots, history filters, planned payments, and reminders through `users.timezone`.
- `users.timezone` is an IANA timezone. Default and fallback is `Asia/Bangkok`.
- Missing or invalid timezone values must fall back to `Asia/Bangkok` and log `timezone_missing` or `timezone_invalid`.
- Changing timezone must not rewrite historical transaction timestamps.

## Daily Empty-Day Reminder

- The daily empty-day reminder is an MVP safety feature, not an A/B experimentation platform.
- The global kill switch defaults off.
- Rollout is controlled by a stable deterministic user cohort percentage.
- A user can disable evening reminders with `daily_entry_reminder_enabled = false`.
- A reminder can send only after 22:00 in the user's local timezone.
- Do not send when the local day already has confirmed financial activity or a no-spending mark.
- Enforce both one delivery per `user_id + local_date + reminder_type` and a 48-hour frequency cap.
- Telegram blocked/forbidden errors must be logged and should mark the user as bot-blocked.

## Reserve

- Reserve is part of the MVP, but it should remain simple.
- Do not add multiple reserves, savings goals, free-text or voice reserve intents, or complex reserve charts unless explicitly requested.

## Out-Of-Budget And Large Purchases

- Out-of-budget expenses must not reduce the ordinary monthly budget.
- Large one-off purchases must not distort analytics for regular spending pace.

## Currencies And Rounding

- `THB`, `RUB`, `IDR`, and `BYN` should be displayed as whole units.
- `USD`, `EUR`, and `GEL` should preserve cents.
- A user may have both a local currency and display currencies.

## Drafts
- A draft is confirmed exactly once. Repeated or concurrent confirms never create duplicate expenses.
- Cancel never deletes an already-saved expense.
- A draft without a valid category cannot be confirmed (parser-fallback `other` is not valid; a user-chosen category, including `other`, is valid).
