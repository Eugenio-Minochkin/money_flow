# Money Flow Domain Rules

This file records stable product and business rules. Read it before changing budget, planned payment, reserve, onboarding, dashboard, or currency behavior.

## Quick Capture

- A Mini App Quick Capture submission is durably identified by `user_id + clientRequestId`; a retry must return its original draft or saved expense and must never create a second financial operation.
- Parser-provided category provenance remains `parser` until the user explicitly chooses a category or explicitly accepts the current draft with `Confirm` / `Save as is`. Parser-provided `other` is never auto-confirmed, but an explicit human acceptance may promote that existing valid slug to user-confirmed `other`.
- `saveDraftAsExpense()` remains the final atomic/idempotent boundary for an individual draft.
- Smart Save may automatically confirm only one ordinary expense with a valid positive amount, supported currency, valid non-future `spent_at`, valid category that does not require user choice, and an open reserve month. Multi-item, ambiguous, invalid, planned, and closed-month drafts stay in review.
- Currency support is the shared active-fiat catalogue. A bare ambiguous currency family (for example, “rupee”, “dirham”, “peso”, “dinar”, “franc”, “krona”, or “shilling”) has no default: it remains a review draft until the user selects one of the offered ISO codes. It must not be sent to an LLM fallback or saved as the base currency.
- Exchange conversion may use provider or cached historical rates. The legacy manual fallback covers only THB, USD, RUB, IDR, EUR, BYN, and GEL; a missing rate for any other supported currency is unavailable, never fabricated.
- Explicit human confirmation is narrower than a validation bypass: it may accept current valid category slugs and clear `needs_review` inside the same locked save transaction, but invalid/missing categories, invalid financial data, future dates, non-expense operations, and closed months remain blocked.
- Telegram text and voice captures are durably identified by the owned `user_id + chat_id + message_id`; webhook retries reuse the original draft and cannot create a second expense.
- Recovery includes every unresolved `pending` and `inbox` draft. Preview is advisory: the mutation must re-read and reclassify each selected draft, preserve its original `spent_at`, and call `saveDraftAsExpense()` separately so retries and concurrent confirmation remain idempotent.
- Recovery preview exposes both draft counts and expense-item counts. Strict recovery-save remains Smart Save-only; the separate explicit acceptance batch re-reads each selected draft and returns per-draft partial outcomes so one blocked draft cannot roll back successfully saved drafts.

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
- The planned-payment archive is read-only history. An archived row cannot be patched or restored by setting `active = true`; `Create again` always inserts a new independent active row with a new `id`.
- Recreate never copies `planned_expense_payments` or their linked expenses, never changes the archived source or its `disabled_at`, and stores no permanent source-to-copy link. Repeating recreate after a new explicit confirmation is allowed.
- `starts_on = NULL` preserves legacy recurrence behavior. A non-null `starts_on` filters scheduled obligations before that user-local calendar key across dashboard, reserve, reports, Pay, and Mini App fallback helpers; it does not erase otherwise valid factual payment links from history.
- Recreate uses the user's IANA timezone to validate and store the `starts_on` calendar key. PostgreSQL `DATE` values remain calendar dates and must not shift through UTC conversion.
- Planned-payment create, update, and disable mutations immediately update live monthly obligations and forecast, but they must not replace an already-created current-local-day opening snapshot. If no snapshot exists for that local day, the first subsequent dashboard creates it from the then-current active plan set; the next local day also receives a new snapshot from that current state.
- Disabling a plan cancels only its unpaid obligations. Valid paid occurrences and their linked expenses remain historical facts and continue to contribute their actual linked expense amounts to factual paid totals.
- Disabling is transactional and idempotent. The first active-to-inactive transition records `disabled_at`; repeating disable preserves that lifecycle result without another transition. Legacy inactive rows are not assigned a synthetic disable time.
- The ordinary planned-payment PATCH cannot change `active`. Disabling uses the dedicated lifecycle action; restoring disabled plans is outside the current product scope.
- The dashboard's server-owned planned-month summary is the source of truth for paid, remaining, and total values. Paid includes valid current-occurrence-month payment links, including links from disabled plans, using actual linked expense amounts; remaining includes only unpaid occurrences of active plans. Rounded paid plus rounded remaining must reconcile with the rounded total in each reported currency.
- Weekly planned payments must not be counted more than once for the same target week.
- One-off planned payments must not repeat in the next month.
- The source of truth for whether a planned occurrence is paid is `planned_expense_payments` (matching the planned expense and occurrence), not the local date of the linked expense. A payment row counts as paid as long as its linked expense exists and belongs to the same user; `expenses.spent_at` is history placement and must not make an otherwise valid payment appear unpaid or allow a duplicate Pay.
- Undoing a planned payment is a dedicated exact-occurrence action. It deletes only the selected `planned_expense_payments` row and its linked same-user expense in one transaction; it never uses ordinary History deletion, changes the plan, or removes neighbouring payments.
- Undo treats a missing link on an owned plan as idempotent `already_unpaid`; a malformed calendar key, foreign/missing plan, inconsistent link, and closed expense month fail without deleting data. It may undo a valid payment on an archived plan, although the Mini App only offers controls for active current-month plans.
- Planned payment undo must not invalidate, replace, or recalculate an existing current-local-day opening snapshot or its `dayPlanLimit`. Actual totals and future opening snapshots use the resulting factual state.
- A committed recreate remains successful if best-effort analytics fail. In the Mini App, HTTP `201` is the mutation boundary: dashboard or archive refresh failures show a synchronization warning and must not reopen the form or retry the POST.

## Timezone

- Store timestamps in UTC.
- Interpret local days, weeks, months, daily budget snapshots, history filters, planned payments, and reminders through `users.timezone`.
- `users.timezone` is any runtime-valid IANA timezone. Default and fallback is `Asia/Bangkok`; the Mini App offers common entries and the complete runtime list.
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

## Planned Payment Telegram Reminder

- At or after the configured local hour, one actionable Telegram card may be sent for an exact unpaid occurrence due on the user's local date.
- Delivery, snooze, and Telegram message references are durable per planned expense plus occurrence date. An ignored occurrence is not repeated automatically; snooze changes only the next notification date.
- Pay and disable callbacks recheck ownership and current DB state and reuse the canonical planned-payment lifecycle methods. Paying creates the same linked planned expense used by Mini App.
- A successful planned reminder suppresses the empty-day reminder for that user and local date.
- Paying or disabling in Mini App clears an outstanding Telegram card best-effort after commit. Telegram failures never roll back the financial mutation.
- Reminder analytics contains only safe enums, dates, recurrence, source, and outcome; it never contains descriptions, amounts, Telegram IDs, or callback payloads.

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
- Reports must never expose internal category keys or enum names. Category display names resolve through the shared localized label (`categoryLabel(slug, language)`), falling back to a de-slugged human-readable string only when no translation exists.
- The weekly report week-over-week comparison appears only when the previous week was fully observable and had spending. "Fully observable" means the user's account (`users.created_at`) existed at or before the start of the previous week; a partial first/prior week, any gap, or a period with missing data hides the comparison, the "what changed" block, and any derived takeaway. The dedicated first-week message shows only when the user's account was created during the reported week.
- The weekly "what changed" block shows only category changes computed over the full category sets of both weeks (not a top-N subset), so a category that left the top list is not misread as new and a category that dropped to zero is still reported. Each shown change must clear both an absolute and a relative threshold; the overall total change is not repeated there (it is already shown next to the spent total). When no change qualifies, the block is hidden entirely.
- The weekly takeaway must be data-grounded (a dominant single expense, the leading category delta, or a needs-attention pointer). It never invents a cause it cannot support from the data, and it is hidden entirely when no defensible takeaway exists.
- Unpaid planned payments in the weekly report surface only as actionable "needs attention" items (with the specific due date). A payment that remains unmarked into the following week gets stronger wording; redundant "paid/not marked" totals are not repeated.

## Currencies And Rounding

- `THB`, `RUB`, `IDR`, and `BYN` should be displayed as whole units.
- `USD`, `EUR`, and `GEL` should preserve cents.
- A user may have both a local currency and display currencies.

## Drafts
- A draft is confirmed exactly once. Repeated or concurrent confirms never create duplicate expenses.
- Cancel never deletes an already-saved expense.
- A draft without a valid category cannot be confirmed (parser-fallback `other` is not valid; a user-chosen category, including `other`, is valid).
- A mixed-currency draft confirmation never adds original amounts across currencies. It shows a total only after each item is converted to the user's base currency through the same date-aware conversion and fallback chain used at confirmation; otherwise it shows per-currency subtotals and no aggregate.

## Telegram Expense Editor

- The Telegram editor shares presentation and input parsing for drafts and saved expenses, but applies changes through separate repository targets.
- A text-input session belongs to one internal user, expires after 15 minutes, and is only a routing record; ownership, value validation, closed-month rules, and financial integrity are rechecked by the repository.
- Claiming a session, changing its target, conditionally invalidating a snapshot, and completing the session are one database transaction. `processing` is never a durable intermediate state.
- A failed validation or domain check leaves the active session and target unchanged. A late expired-session input is consumed once and never falls through to the normal expense parser.
- Voice and photo messages do not complete a text-input session.
- Text prompts are scoped to their editor session. On successful text input or an inline Cancel, the prompt and stale editor are removed or deactivated best-effort, then exactly one fresh card is sent at the bottom of the chat.
- Save/exit, draft confirm/cancel, expense delete, and target-not-found close only the matching input session. Save changes no financial data; it only exits to the current saved-expense or draft card.
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
