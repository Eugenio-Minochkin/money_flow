# Review Backlog Explicit Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every explicit human confirmation save valid review drafts without weakening Smart Save, and replace History's permanent card pile with a batch-plus-sequential review flow.

**Architecture:** Keep `saveDraftAsExpense()` as the only transactional financial boundary. Add a narrowly named explicit-accept option that runs after the draft row is locked, validates current categories and financial inputs, marks accepted categories as user-owned in the locked draft, then continues through the existing month locks, inserts, and idempotent status transition. Extend recovery preview with draft/item acceptability counts, add a separate partial-success review acceptance mutation, and have Mini App/Telegram/legacy Shortcut explicit actions use the same repository method.

**Tech Stack:** Node.js ESM, PostgreSQL transactions, `node:test`, vanilla Mini App JavaScript/CSS, Telegram Bot API.

---

### Task 1: Transactional explicit human acceptance

**Files:**
- Modify: `apps/api/src/repository.js`
- Test: `apps/api/test/repository.test.js`
- Test: `apps/api/integration/postgres-smoke.js`

- [x] Add failing repository tests for `confirmDraftWithExplicitAcceptance()` covering parser `needs_review`, parser `other`, multi-item historical dates, invalid/missing category, invalid amount/currency/date/future date, closed month, already-saved retry, and concurrent confirmation.
- [x] Run `npm.cmd test -- apps/api/test/repository.test.js` and confirm the new method/expectations fail for the intended reason.
- [x] Add `confirmDraftWithExplicitAcceptance(draftId, telegramUserId, options)` as a wrapper around the canonical save boundary. Inside the existing `FOR UPDATE` transaction, accept only known category slugs, positive finite amounts, supported currencies, valid non-future dates, and ordinary expense items; rewrite accepted item category provenance to `category_source: "user"` and `needs_review: false` before inserting.
- [x] Keep `saveDraftAsExpense(draftId, telegramUserId)` strict when the explicit option is absent, including parser `other` and `needs_review` rejection.
- [x] Add PostgreSQL smoke coverage proving one financial fact under concurrent explicit confirmation and preserved `spent_at`.
- [x] Re-run the focused repository test and the local PostgreSQL smoke command from `docs/TESTING_GUIDE.md`.

### Task 2: Explicit-confirm services and HTTP contracts

**Files:**
- Modify: `apps/api/src/draftConfirmation.js`
- Modify: `apps/api/src/smartSaveRecovery.js`
- Modify: `apps/api/src/server.js`
- Test: `apps/api/test/draftConfirmation.test.js`
- Test: `apps/api/test/smartSaveRecovery.test.js`
- Test: `apps/api/test/security.test.js`

- [x] Add failing service tests proving API confirm calls the explicit method and recovery preview distinguishes `draftCount` from `itemCount`, accept-now drafts from input-required drafts, and strict-safe drafts from human-acceptable review drafts.
- [x] Add failing batch tests for mixed saved/review/error outcomes, parser `other`, multi-item counts, concurrent already-saved members, retry safety, and partial closed-month failure.
- [x] Run the three focused test files and confirm failures identify the missing contract.
- [x] Make `confirmDraftForApi()` call `confirmDraftWithExplicitAcceptance()` and map explicit-validation errors to stable error codes.
- [x] Extend preview without changing strict `safeDraftIds` semantics; add `acceptDraftIds`, `acceptDraftCount`, `acceptItemCount`, `requiresInputDraftCount`, and `requiresInputItemCount`.
- [x] Add `acceptReviewRecovery()` and `POST /api/drafts/recovery-accept`; re-read every selected draft through the repository method, return one outcome per draft, and never fail the whole batch for one draft.
- [x] Route legacy Shortcut confirm through the same explicit method while leaving automatic Shortcut capture strict.
- [x] Re-run the focused service/security tests.

### Task 3: Telegram legacy callback behavior

**Files:**
- Modify: `apps/api/src/telegram.js`
- Test: `apps/api/test/telegram.test.js`

- [x] Add failing Telegram callback tests for parser review, parser `other`, multi-item, repeated callback, and closed-month actionable RU/EN messages.
- [x] Run the focused Telegram cases and confirm they fail because the handler still calls strict save or emits generic failure.
- [x] Change only `handleConfirmDraft()` to call explicit acceptance, preserve early callback ACK/idempotent cleanup, and map closed month plus invalid financial data to user-facing messages without changing automatic Telegram Smart Save.
- [x] Re-run `npm.cmd test -- apps/api/test/telegram.test.js`.

### Task 4: Compact History batch and sequential queue

**Files:**
- Modify: `apps/miniapp/src/inbox.js`
- Modify: `apps/miniapp/src/app.js`
- Modify: `apps/miniapp/src/styles.css`
- Test: `apps/miniapp/test/inbox.test.js`
- Test: `apps/miniapp/test/smokeAssets.test.js`

- [x] Add failing pure/view contract tests for item-count wording, accept/input summary, batch confirmation copy, one-card queue rendering hooks, pending/reenable state, and error-code-to-RU/EN-message mapping.
- [x] Run the focused Mini App tests and confirm the new expectations fail.
- [x] Render one History disclosure block using `acceptItemCount`/`requiresInputItemCount`; do not render the full backlog by default.
- [x] Add one `window.confirm` batch dialog with the specified explanation, call `/api/drafts/recovery-accept`, refresh History/Dashboard recovery state, and show `saved · requires correction` outcome feedback.
- [x] Add a sequential queue state that reveals one draft at a time, reuses the existing editor for multi-item drafts, and advances after confirm/cancel.
- [x] Wrap every async inbox action in pending/disable plus `try/catch/finally`; map category, closed-month, invalid amount/currency/date, network, and unexpected failures to actionable localized toasts with no unhandled rejection.
- [x] Add narrow responsive styles for 375/390/430 CSS px and light/dark-compatible surfaces.
- [x] Re-run the focused Mini App tests.

### Task 5: Domain docs, full verification, screenshot, and draft PR

**Files:**
- Modify: `docs/DOMAIN_RULES.md`
- Modify: `docs/TESTING_GUIDE.md`

- [x] Document that explicit human acceptance may accept current valid categories while Smart Save remains strict, and record the recovery batch/item-count contract.
- [x] Run `npm.cmd test`, the PostgreSQL integration smoke, and `git diff --check`; inspect `git diff` for unrelated changes.
- [x] Start the local app using the repository command, capture a narrow History screenshot showing the compact backlog and the post-save/remaining state, and record any Telegram-auth limitation honestly.
- [ ] Commit only the scoped files, push `codex/issue-180-review-backlog`, and open a draft PR into `master` with issue link, DB/prod impact, exact tests, screenshots, assumptions, and the required `## User Release Notes` block.
- [ ] Verify the published PR is draft, its head SHA matches the pushed commit, and required checks are reported without merging or deploying.
