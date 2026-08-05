# Money Flow Decision Log

## 2026-07-27 - Planned Payment Reminders Use Exact Durable Occurrence State

Telegram planned-payment reminders reuse the repository's canonical pay and disable transactions. Delivery state is durable and unique per planned expense plus occurrence date, with exact-occurrence snooze and a Telegram message reference for best-effort Mini App synchronization. The scheduler uses the user's IANA timezone and runs before the empty-day reminder so a successful planned reminder suppresses the latter for that local date.

A pay callback treats the planned-payment transaction as the commit boundary. Dashboard formatting, analytics, and Telegram edits are post-commit and best-effort. The successful card reuses the shared saved-expense summary but exposes only the Mini App button, because editing or ordinary deletion would misrepresent ownership of planned fields and exact-occurrence undo.

## 2026-07-22 - Planned Payment Undo Targets One Factual Link

Undo is a separate exact-occurrence transaction, not ordinary expense deletion or a plan mutation. It locks the owned plan, the payment link selected by `planned_expense_id` plus `occurrence_date`, and then its linked expense. Only a same-user linked expense may be removed. A missing link is an idempotent success, while an inconsistent link or closed reserve month rolls back without mutation. The transaction deliberately does not invalidate today's opening budget snapshot; analytics is post-commit and privacy-minimal.

This is a lightweight log for product and domain decisions that future agents should preserve unless the user explicitly asks to revisit them.

## 2026-07-22 - Planned Archive Is Read-only And Recreate Is Independent

Disabled planned payments are exposed through a separate lazy archive read endpoint. Archive rows remain immutable: ordinary PATCH and direct reactivation through `active = true` stay forbidden. `Create again` uses a separate endpoint and a repository transaction to insert a new active row with a new `id`; it does not copy payment or expense history, mutate the source or its `disabled_at`, or store `source_planned_expense_id`, `recreated`, an idempotency key, or another permanent link. One archived row may be recreated repeatedly when each attempt follows a new explicit user action.

The nullable `starts_on` date is a user-timezone calendar key. `NULL` preserves legacy scheduling; a value filters only scheduled occurrences before that key in dashboard, reserve, reports, Pay, and Mini App compatibility calculations. Valid linked payments remain factual even when their occurrence is earlier than `starts_on`. The opening-snapshot policy below remains unchanged: live monthly values update immediately, while an existing current-local-day snapshot stays fixed.

The recreate transaction rechecks the archived source under lock and validates reserve capacity on the same transaction client. A committed row is not rolled back by best-effort analytics failure. In the Mini App, HTTP `201` closes and resets the form before dashboard and archive refresh; refresh failures become a warning, never a retryable creation error.

## 2026-07-22 - Planned Changes Preserve Today's Opening Snapshot

Planned-payment create, update, and disable mutations recalculate live monthly obligations, free remainder, and forecast immediately. They do not delete or replace an opening `daily_budget_snapshot` that already exists for the user's current local day. When that snapshot does not yet exist, the first subsequent dashboard creates it from the then-current active plan set; a new local day likewise starts from the active plan state at that time. Budget, top-up, reserve, ordinary-expense, currency, and timezone invalidation policies are unchanged.

Disable is a dedicated transactional lifecycle action, not an ordinary PATCH field. The first active-to-inactive transition records `disabled_at`; repeated requests return the same lifecycle impact without another transition or event. Ordinary PATCH cannot mutate `active`. Legacy inactive rows are not backfilled, direct restore remains forbidden, and Undo payment remains outside this decision; archive/recreate behavior is governed by the decision above.

Disable removes only unpaid obligations. Valid `planned_expense_payments` rows and their same-user linked expenses remain historical facts. The server owns the current planned-month summary: paid uses the actual linked expense amounts for valid payments in the current local occurrence month, including disabled plans, while remaining uses only unpaid occurrences of active plans. The Mini App renders this paid/remaining/total response and may calculate locally only as compatibility fallback for an older server response.

## 2026-07-21 - Parser Audit And Benchmark Produce Evidence, Not Automatic Changes

Historical parser audit tooling may run only against an approved loopback-hosted production-data copy or a verified read replica, using a dedicated connection URL, a read-only transaction, a bounded statement timeout, a fixed SELECT, and unconditional rollback. Its output contains only privacy-safe aggregates. Raw source text, descriptions, transcripts, financial values, record identifiers, user identifiers, and Telegram identifiers never belong in stdout, files, CI artifacts, or PRs.

Confirmed expenses joined through `draft_id` are the final category truth; unconfirmed drafts are review-only evidence. RU and EN evidence remains separate. Occurrence, distinct-user, and category-dominance floors suppress rare candidates. Passing those floors never approves a merchant-specific, personal, or context-dependent phrase and never edits the alias dictionary automatically.

Model/prompt benchmarks use a fixed invented corpus and report correctness separately from latency. Real API calls require a separate explicit command and are excluded from ordinary CI. Benchmark tooling does not change the configured model or prompt; every alias, prompt, or model decision requires evidence and a separate reviewed follow-up PR.

## 2026-07-21 - Local Parser Quality Routes By Acceptance Enum

`local_safe` is the only local-primary result inside the already configured `enabled` rollout cohort. `local_reviewable` must use the LLM to resolve its category; on LLM timeout or error it returns the already parsed local draft with `other` and `needs_review=true`, so the user can choose a category manually. `shadow`, `off`, and rollout-excluded users keep their previous LLM-primary behavior. `local_rejected` always uses LLM fallback when available and otherwise returns the existing controlled parser error.

Local parse failures use privacy-safe diagnostic enums: `no_amount_token`, `multiple_amounts_ambiguous`, `small_bare_integer`, `unsupported_amount_shape`, `amount_over_limit`, `unsafe_split_or_mapping`, `unsupported_number_words`, and `local_exception`. These reasons contain no source text or financial values.

The deterministic parser may accept multiple expenses only when every explicitly separated segment has one unambiguous amount, its own meaningful description after amount/currency/filler cleanup, and safe currency/date/budget semantics. The single-expense amount-only fallback remains unchanged, but a generated placeholder is never sufficient for one segment of a multi-expense parse. A parser-provided `other` remains review-only and cannot be confirmed until the user explicitly chooses a category; an explicit user choice of `other` is valid.

## 2026-07-21 - Local Parser Acceptance Is Classified Before Routing Expansion

The regular expense parser distinguishes `local_safe`, `local_reviewable`, and `local_rejected` results. Critical financial fields are expense count, amount, currency, the user's timezone-aware local calendar day, and budget impact. Category and `needs_review` are reviewable fields only after every critical field is unambiguous.

Acceptance metadata is emitted only after local evaluation completes; LLM-only messages do not count as local candidates, accepted parses, or rejected parses. A parser-provided `other` category cannot be confirmed until the user explicitly selects a category. LLM timeout or error may use a local fallback only when the result is `local_safe` or `local_reviewable`; the latter remains an explicit category-selection draft.

## 2026-07-27 - Historical Critical Shadow Cases Are Not Time-Correlated

The existing safe shadow telemetry intentionally records disagreement flags and
safe routing metadata, not a draft relation or parser result payload. Therefore
historical critical disagreements are reported as `unadjudicable`, with no
attempt to infer a confirmation by account or timestamp. This is preferable to
a false local/LLM attribution.

A future correlation, if separately approved, must be draft-owned and store
only keyed fingerprints plus safe lifecycle/result enums. Each fingerprint must
HMAC the domain-separated UTF-8 payload
`money-flow:shadow-adjudication:v1:<canonical-payload>`, never an unprefixed
tuple. The canonical payload uses RFC 8785 JSON Canonicalization Scheme, a
fixed critical-field order, and expenses sorted by complete canonical entry so
neither JSON property order nor input array order changes the fingerprint. The
record must include its fingerprint schema version; different versions are
never compared and remain `unadjudicable`. It may aggregate `local_match`,
`llm_match`, `neither_match`, and `unadjudicable`, but must never export
fingerprints, financial values, source text, descriptions, transcripts, or
identifiers to analytics events, logs, stdout, fixtures, reports, or PR text.
This decision changes neither parser routing nor rollout.

## 2026-07-10 - Product Analytics Uses First-touch And Derived Milestones

Money Flow stores one normalized acquisition source on the user at the first valid `/start` or authenticated Mini App launch and never overwrites it. Internal report navigation is product activity, not acquisition. Legacy users are not backfilled; unresolved legacy source is reported as `unknown` until a valid new entry assigns source or `direct`.

Activation is the first successfully saved expense. Funnel milestones, median activation time, D1/D7 retention, and early habit are derived from canonical events rather than stored as parallel `first_*` or returned-user events. New-user cohorts are anchored by `users.created_at` so a legacy user pressing `/start` after analytics ships cannot appear newly joined.

Product event writes are best-effort and never fail the primary user flow. One-time onboarding milestones are protected by a partial unique event index; subsequent settings changes use distinct repeatable events. Account deletion remains privacy-minimal: it deletes user-owned events and retains exactly one anonymous `account_deleted` event whose metadata is only `{ source }`.

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
