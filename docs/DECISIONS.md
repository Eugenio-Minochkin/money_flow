# Money Flow Decision Log

This is a lightweight log for product and domain decisions that future agents should preserve unless the user explicitly asks to revisit them.

## 2026-06 - Keep Settings Compact

Settings already contain budget, currencies, planned payments, reserve, language, theme, and backup. Keep the surface compact so it does not start feeling like an admin panel.

## 2026-06 - Do Not Expand Reserve Before MVP Without Explicit Request

Reserve is already useful and complex enough for the MVP. Avoid multiple reserves, savings goals, and advanced reserve planning unless the user asks for that direction.

## 2026-06 - Save Overdue Planned Payments By Occurrence Date

Analytics should reflect the financial period a planned payment belongs to, not the date when the user clicked the payment button.

## 2026-06 - Keep Dashboard Compact

The dashboard should clearly show the state of money and budget, not turn into a dense analytics screen.

## 2026-06 - Use User Timezone For Local Dates

Local days, weeks, months, daily budget snapshots, history filters, planned payments, and daily reminders use `users.timezone`. Timestamps remain stored in UTC and historical transactions are not rewritten when timezone changes. The default and fallback timezone is `Asia/Bangkok`.

## 2026-06 - Daily Empty-Day Reminder Is A Safe MVP

The daily empty-day reminder uses a kill switch, rollout percentage, 48-hour frequency cap, idempotent delivery rows, no-spending marks, and Telegram blocked/forbidden logging. It is not a full experimentation or holdout platform.
