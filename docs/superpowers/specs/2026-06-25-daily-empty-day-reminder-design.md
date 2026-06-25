# Daily Empty-Day Reminder Design

## Goal

Add a lean MVP evening reminder that gently nudges a user when their local day has no confirmed financial activity, while keeping Telegram delivery safe through a kill switch, rollout percentage, frequency cap, idempotency, and blocked/forbidden logging.

## Scope

This feature includes:

- `users.timezone` as an IANA timezone field.
- Timezone-aware local-date calculations for reminders, today/yesterday history, month/week ranges, daily budget snapshots, and planned payments.
- A lightweight Mini App timezone setting.
- A daily empty-day reminder service and scheduled job.
- No full experimentation platform, no persistent holdout, and no historical transaction rewrite.

## Timezone Rules

- Store all timestamps in UTC as before.
- Add `users.timezone TEXT NOT NULL DEFAULT 'Asia/Bangkok'`.
- Use `Asia/Bangkok` as the fallback timezone for missing or invalid values.
- Log `timezone_missing` when a timezone value is absent.
- Log `timezone_invalid` when a timezone value is present but not a valid IANA timezone.
- Apply timezone changes only to future local-date calculations and current display/filter logic.
- Do not rewrite historical transaction timestamps.

## Reminder Eligibility

A daily empty-day reminder is eligible when all conditions are true:

- Global setting `daily_reminder_global_enabled` is true.
- User setting `daily_entry_reminder_enabled` is true.
- User is in the stable rollout cohort for `daily_reminder_rollout_percent`.
- User was created more than 24 hours ago.
- User local time is at or after 22:00.
- The user's current local date has no confirmed financial activity.
- The user's current local date has no no-spending mark.
- The user has not received a daily empty-day reminder in the previous 48 hours.
- No delivery row exists for `user_id + local_date + reminder_type`.

Confirmed financial activity for this MVP means confirmed expenses and paid planned payments that create confirmed expenses. Confirmed income is not included unless income support already exists in the codebase.

## Reminder Delivery

Create `daily_reminder_deliveries` with:

- `id`
- `user_id`
- `local_date`
- `timezone_used`
- `reminder_type = daily_empty_day`
- `sent_at`
- `status: sent / failed / blocked`
- `error_code`
- `error_message`
- `created_at`

The unique key is `user_id + local_date + reminder_type`. Any existing row for that key prevents another send attempt for that day.

Create `no_spending_marks` with:

- `user_id`
- `local_date`
- `timezone_used`
- `created_at`

The unique key is `user_id + local_date`.

## Telegram Behavior

The reminder sends localized RU/EN copy with three inline buttons:

- Add expense: replies with the existing short add-expense hint.
- No spending today: creates a no-spending mark and edits the reminder message.
- Don't remind me: sets `users.daily_entry_reminder_enabled = false` and edits the reminder message.

Blocked or forbidden Telegram errors are recorded as blocked deliveries/events and mark `users.bot_blocked = true`.

## Settings UI

Add a compact timezone setting to the Mini App Settings screen:

- Show the current timezone.
- Allow browser/Mini App auto-detect via `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- Allow manual selection from a short list of common IANA timezones.
- Do not build a full timezone picker.

## Events And Guardrails

Use `app_events` for:

- `daily_reminder_eligible`
- `daily_reminder_sent`
- `daily_reminder_clicked_add`
- `daily_reminder_clicked_no_spending`
- `daily_reminder_disabled`
- `daily_reminder_send_failed`
- `daily_reminder_blocked_or_forbidden`
- `daily_reminder_ignored`
- `timezone_missing`
- `timezone_invalid`

Guardrail metrics are derived from these raw events and delivery rows.

## Documentation

Update domain and product docs so future changes preserve:

- UTC timestamp storage.
- IANA timezone interpretation for local dates.
- No historical transaction rewrite.
- Reminder MVP safety constraints.
