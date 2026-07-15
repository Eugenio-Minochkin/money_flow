# Money Flow Domain Rules

This file records stable product and business rules. Read it before changing budget, planned payment, reserve, onboarding, dashboard, or currency behavior.

## Monthly Budget

- The monthly budget is the user's main recurring budget.
- Budget top-ups are one-off additions to the effective budget of a specific month. They do not mutate the user's regular monthly budget and are added on top of any current-month override.
- Budget top-ups are not expenses and are not income accounting. They must not increase spending totals, top categories, or heatmap values.
- A temporary current-month budget is only for users going through mid-month onboarding.
- A temporary current-month budget must disappear in the next month.
- Existing users must not get a temporary current-month budget unless they are in the dedicated mid-month onboarding state.
- Partial-month budget top-ups are not prorated. Add the full active top-up total to the partial-month base budget.

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

## Budget Top-ups

- A budget top-up increases the effective budget for its `month_key`: `base month budget + active top-ups`.
- Active top-ups are rows in `budget_topups` with `deleted_at IS NULL`.
- Confirming or undoing a top-up invalidates only the current local daily budget snapshot.
- MVP Telegram confirmation accepts only current-month top-ups. A top-up whose parsed `month_key` is not the user's current month must not be saved from the button flow.
- Month-end rollover is explicit, never automatic. Remaining budget and top-ups from June do not carry into July; July starts from the regular monthly budget or July override.
- Backdated top-ups may change historical month budget data only through a future explicit flow. Historical daily budget snapshots must not be recalculated or deleted implicitly.
- Refund wording may create a top-up with `kind = refund` in the MVP. A future refund flow may reduce the original expense category if it links to the original expense.
- Voice top-up parsing in the MVP depends on transcription producing digits or parser-supported numeric notation. Amount words such as "five thousand" are a future parser/LLM fallback improvement.

## Reserve

- Reserve is part of the MVP, but it should remain simple.
- Do not add multiple reserves, savings goals, free-text or voice reserve intents, or complex reserve charts unless explicitly requested.

## Out-Of-Budget And Large Purchases

- Out-of-budget expenses must not reduce the ordinary monthly budget.
- Large one-off purchases must not distort analytics for regular spending pace.
- Daily budget snapshot recalculation uses the current local day's opening baseline: exclude today's `regular` expenses from the snapshot's month total, but keep `planned` and `large_oneoff` in their non-daily monthly buckets.
- Reports preserve the same semantics: `large_oneoff` is included in the reported total spent, but explicit large one-off spending is not extrapolated as daily pace.
- Notable one-off expenses in reports are a display view inside the total, not a third accounting partition. They include explicit `large_oneoff` rows and non-planned individual expenses above the report threshold, while paid planned payments are excluded from the automatic notable list.
- The visual report partition remains paid planned expenses plus derived other expenses.
- Reports must not invent a new outside-budget model. If no separate existing outside-budget amount exists, the outside-budget block stays hidden.

## Reports

- Telegram weekly and monthly report messages are snapshots generated at send time.
- The Mini App remains the live recalculation surface for historical weeks and months.
- Report core accounting uses one report currency for all formula lines. In this PR the report currency is the user's base currency/current budget currency.
- Display currency may appear only as a secondary equivalent line, not inside accounting partitions or category/payment item totals.
- Report visual partitions must reconcile after currency rounding: rounded total spent equals rounded paid planned plus derived rounded other expenses.
- Report pace highlights everyday spending first (`regularTotal / days`). The total average including paid planned payments may appear as a secondary line when paid planned payments exist.
- Weekly reports use the previous completed local week. Monthly reports use the previous completed local calendar month.
- Report delivery idempotency is tracked by user, report type, and period key. Sending may only happen after a delivery row is successfully claimed as `pending`; failed rows may be retried, and force sends explicitly reclaim existing rows.
- Report backfills may only send closed months. Current and future months are rejected.
- Empty report snapshots with no spending, planned payments, budget top-ups, reserve, baseline, or category activity are marked `no_activity` and skipped instead of being sent.
- Weekly reports that cross a month boundary include planned payment occurrences from every local month touched by the report period, not just the send-date month.

## Currencies And Rounding

- `THB`, `RUB`, `IDR`, and `BYN` should be displayed as whole units.
- `USD`, `EUR`, and `GEL` should preserve cents.
- A user may have both a local currency and display currencies.

## Drafts
- A draft is confirmed exactly once. Repeated or concurrent confirms never create duplicate expenses.
- Cancel never deletes an already-saved expense.
- A draft without a valid category cannot be confirmed (parser-fallback `other` is not valid; a user-chosen category, including `other`, is valid).

## Telegram Expense Editor

- The Telegram editor shares presentation and input parsing for drafts and saved expenses, but applies changes through separate repository targets.
- A text-input session belongs to one internal user, expires after 15 minutes, and is only a routing record; ownership, value validation, closed-month rules, and financial integrity are rechecked by the repository.
- Claiming a session, changing its target, conditionally invalidating a snapshot, and completing the session are one database transaction. `processing` is never a durable intermediate state.
- A failed validation or domain check leaves the active session and target unchanged. A late expired-session input is consumed once and never falls through to the normal expense parser.
- Voice and photo messages do not complete a text-input session.
- A date without a year is resolved as the closest past local calendar occurrence in `users.timezone`. A later time today is rejected, rather than silently moving to the previous year. Explicit future dates are rejected.
- `/last` selects the latest non-planned, non-deleted expense by `created_at DESC, id DESC`; `spent_at` and `updated_at` never change this order.
- Moving a saved expense to any past local month is allowed when both months are open. The source and target month locks are acquired in sorted order within one transaction.
- A month with a closed reserve allows only description, category, and tags corrections. Amount, currency, date, budget impact, deletion, and moves into or out of that month are rejected.
- `created_at` and a linked draft's `source_text` are immutable during expense editing; successful edits change `updated_at`.
- The daily snapshot is an opening-baseline record. Metadata-only changes and a same-day regular amount correction do not recreate it. Corrections that alter the current-month opening baseline, including a prior-day correction, a day move, or `regular`/`large_oneoff` change, invalidate it transactionally.

## Product Analytics Cohorts

- Acquisition and funnel cohorts include only users whose `users.created_at` is within the reporting window and whose first `bot_started` or `miniapp_opened` event occurred at or after account creation.
- Activation is the first `expense_saved` after first start. Draft confirmation alone is not activation.
- D1 return activity uses `[24h, 48h)` after first start; D7 uses `[6d, 8d)`. Users enter each denominator only after that window has matured.
- Habit requires `expense_saved` activity on at least two local dates in the first seven days. Historical local dates use the current `users.timezone`; changing timezone may therefore change the MVP aggregate.
- Automatic report delivery is not meaningful activity. A validated report click is meaningful activity.
