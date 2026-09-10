# Issue 211 F07 Photo Import Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every billable expense-evidence image analysis through the durable per-user paid-provider allowance without double-counting Telegram replay.

**Architecture:** Keep `EXPENSE_EVIDENCE_IMPORT_ENABLED` as the feature entitlement and add `OPENAI_IMAGE_ANALYSIS_GLOBAL_ENABLED` plus `OPENAI_IMAGE_ANALYSIS_USER_LIMIT` as provider controls. Extend the existing PostgreSQL provider enum with `openai_image_analysis`, reserve one request immediately before each OpenAI Responses call, and dedupe reservations with internal `users.id` plus the existing durable Telegram chat/message identity.

**Tech Stack:** Node.js ESM, node:test, PostgreSQL migrations/repository, OpenAI Responses API, Telegram Bot API.

---

### Task 1: Prove the bypass and define the paid-call boundary

**Files:**
- Modify: `apps/api/test/expenseEvidenceAnalyzer.test.js`
- Modify: `apps/api/test/expenseEvidenceImportService.test.js`
- Modify: `apps/api/src/expenseEvidenceAnalyzer.js`
- Modify: `apps/api/src/expenseEvidenceImportService.js`

- [x] Add an analyzer test whose usage callback rejects and assert the OpenAI fetch is never invoked.
- [x] Add an analyzer test whose usage callback allows and assert reservation occurs immediately before one OpenAI fetch.
- [x] Add an import-service test asserting `usageUserId` is the internal `user.id` and `requestKey` is `telegram:<internal-user-id>:<chat-id>:<message-id>`.
- [x] Add replay, concurrent-claim, download-failure, and provider-failure assertions: replay/processing claims invoke neither gate nor analyzer; pre-analysis failures consume nothing; a post-reservation provider failure releases the import and creates no draft.
- [x] Run the focused tests and verify they fail because the analyzer has no usage callback and the import service does not pass durable accounting identity.
- [x] Inject `consumeAnalysisUsage` into the analyzer, call it directly before `requestStructuredAnalysis`, and pass internal identity plus the durable request key from `importImage`.
- [x] Re-run the focused tests and expect pass.

### Task 2: Add durable image-analysis provider policy

**Files:**
- Create: `apps/api/migrations/024_paid_provider_image_analysis.sql`
- Modify: `apps/api/src/config.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/test/config.test.js`
- Modify: `apps/api/test/expenseEvidenceMigration.test.js`

- [x] Add failing config and wiring tests for a 24-hour, 100-call default image allowance and an independent image-analysis kill switch.
- [x] Add a failing migration contract test requiring `openai_image_analysis` in both paid-provider tables.
- [x] Extend the two provider check constraints additively in migration 024.
- [x] Wire a `createPaidProviderUsageGate` with provider `openai_image_analysis`, the common usage window, image limit, and image kill switch into `createExpenseEvidenceAnalyzer`.
- [x] Run focused config, migration, analyzer, import-service, and paid-provider tests; expect pass.

### Task 3: Prove replay, concurrency, and failure semantics with PostgreSQL

**Files:**
- Modify: `apps/api/integration/postgres-smoke.js`

- [x] Add migration 024 to the exact migration ledger expectation.
- [x] Add a real repository/import/analyzer scenario where an allowed image uses the internal user row, concurrent/replayed delivery of the same Telegram message starts one analysis and stores one `openai_image_analysis` reservation.
- [x] Exhaust a user's image quota and assert the next image performs no OpenAI fetch, creates no draft/candidate, and leaves the import failed.
- [x] Assert one distinct photo message reserves once, while concurrent/replayed delivery remains idempotent under the locked usage window.
- [ ] Run the PostgreSQL smoke against a safe disposable database when available; otherwise require the GitHub PostgreSQL integration job.

### Task 4: Keep runtime configuration and operator documentation aligned

**Files:**
- Modify: `.env.example`
- Modify: `.env.production.example`
- Modify: `compose.prod.yml`
- Modify: `docs/deployment-runbook.md`
- Modify: `docs/TESTING_GUIDE.md`
- Modify: `test/deploymentWorkflow.test.js`

- [x] Add failing configuration-contract assertions for Compose, production env, and the runbook.
- [x] Document entitlement separately from image provider enablement, a default of 100 image calls per 24 hours, internal-user accounting, per-image billable semantics, and replay-safe reservation behavior.
- [x] State that image download/validation and CSV export do not consume the allowance and that a started provider request keeps its reservation on ambiguous failure.
- [x] Run focused deployment workflow tests and `git diff --check`.

### Task 5: Verify and publish the F07-only change

- [x] Run all focused tests covering analyzer, import service, Telegram routing, paid-provider usage, configuration, migrations, and deployment contracts.
- [x] Run `npm.cmd test`.
- [ ] Run `npm.cmd run test:integration:postgres` against a safe disposable database when available.
- [ ] Review the exact diff for F07-only scope, commit, push, and create a separate draft PR into `master`.
- [ ] Require Test, PostgreSQL integration smoke, and Docs Reminder to pass; do not deploy production or close issue #211.
