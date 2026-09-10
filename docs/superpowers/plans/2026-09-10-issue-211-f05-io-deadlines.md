# Issue 211 F05 I/O Deadlines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound Telegram, FX, image, and PostgreSQL waits while preserving queue worker ownership and financial transaction atomicity.

**Architecture:** Compose each external request's finite timeout with the Telegram job signal. Configure finite PostgreSQL connection and server/client query timeouts. For financial paths, compute FX from a non-locking snapshot before `BEGIN`, then retain the existing transaction and reject a changed locked snapshot before writing.

**Tech Stack:** Node.js 24, native `fetch`/`AbortSignal`, node-postgres, `node:test`.

---

### Task 1: External request deadlines

**Files:**
- Create: `apps/api/src/deadlineSignal.js`
- Create: `apps/api/test/deadlineSignal.test.js`
- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/src/exchangeRates.js`
- Modify: `apps/api/src/expenseEvidenceImage.js`
- Modify: `apps/api/src/expenseEvidenceImportService.js`
- Modify: `apps/api/src/server.js`
- Test: `apps/api/test/telegram.test.js`
- Test: `apps/api/test/exchangeRates.test.js`
- Test: `apps/api/test/expenseEvidenceImage.test.js`
- Test: `apps/api/test/expenseEvidenceImportService.test.js`

- [x] Add failing tests proving the queue abort reaches Telegram send, FX fetch, Telegram image metadata/file body, and the image analyzer.
- [x] Run `node --test apps/api/test/deadlineSignal.test.js apps/api/test/telegram.test.js apps/api/test/exchangeRates.test.js apps/api/test/expenseEvidenceImage.test.js apps/api/test/expenseEvidenceImportService.test.js`; expect the new signal assertions to fail.
- [x] Implement `deadlineSignal(signal, timeoutMs)` with `AbortSignal.timeout(timeoutMs)` and `AbortSignal.any([signal, timeout])`, pass it to real fetch calls, and thread the queue signal through loader/result and image-import calls.
- [x] Re-run the focused tests and expect all to pass.

### Task 2: PostgreSQL deadlines

**Files:**
- Modify: `apps/api/src/config.js`
- Modify: `apps/api/src/db.js`
- Modify: `.env.example`
- Modify: `.env.production.example`
- Modify: `compose.prod.yml`
- Test: `apps/api/test/config.test.js`
- Test: `apps/api/test/db.test.js`
- Test: `test/deploymentWorkflow.test.js`

- [x] Add failing tests for `DB_CONNECTION_TIMEOUT_MS=10000`, `DB_STATEMENT_TIMEOUT_MS=60000`, and `DB_QUERY_TIMEOUT_MS=65000`, including production Compose/example propagation.
- [x] Run the three focused test files and verify the new assertions fail.
- [x] Build the pool with `connectionTimeoutMillis`, `statement_timeout`, and `query_timeout` from validated config values; document only those runtime settings.
- [x] Re-run the focused tests and expect all to pass.

### Task 3: Keep FX outside financial locks

**Files:**
- Modify: `apps/api/src/repository.js`
- Test: `apps/api/test/repository.test.js`

- [x] Add failing cross-currency tests showing FX completes before `BEGIN` for photo candidate save, planned-draft confirmation, and planned payment; add changed-snapshot/no-insert assertions.
- [x] Run `node --test apps/api/test/repository.test.js` and verify failures identify FX under an active transaction.
- [x] For each path, read and compute before `BEGIN`, keep existing locks and unique constraints, and compare locked `version/base/items` or full planned-payment signature and occurrence before using the prefetched amounts.
- [x] Re-run repository tests and expect all to pass.

### Task 4: Verification and delivery

**Files:**
- Modify this plan's checkboxes only as evidence is collected.

- [ ] Run focused tests, then `npm.cmd test`, `npm.cmd run test:integration:postgres`, and `git diff --check`.
- [ ] Review the exact diff for unrelated changes and verify required GitHub checks on the pushed head.
- [ ] Commit, push `codex/issue-211-f05-io-deadlines`, and open a separate draft PR into `master`; do not deploy or close issue #211.
