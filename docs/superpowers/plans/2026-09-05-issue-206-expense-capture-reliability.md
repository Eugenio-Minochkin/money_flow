# Expense Capture Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Telegram text and voice expense capture safe under burst input, parse compact and spoken amounts correctly, and keep confirmation independent of avoidable rate work.

**Architecture:** Extend the existing `telegram_expense_captures` claim into a small PostgreSQL-backed inbox. The process-local queue remains only a fair bounded scheduler and does not imply durable acceptance. Keep voice normalization pure and conservative; prefetch cross-currency rates before the confirmation transaction and revalidate under the lock.

**Tech Stack:** Node.js ESM, `node:test`, PostgreSQL, Telegram Bot API.

---

### Task 1: Protect compact numeric parsing

**Files:**
- Modify: `packages/shared/src/parser.js`
- Modify: `packages/shared/test/parser.test.js`

- [ ] Add failing parser cases for `150 кофе`, `400 кино`, `65 кофе`, `150 kebab`, `14к такси`, and `14k taxi`; assert the first four retain their original amount and full description while the latter two multiply by 1000.
- [ ] Run `node --test packages/shared/test/parser.test.js` and confirm the description-initial `к` case fails.
- [ ] Change `findAmountMatches()` so optional `k/к` is a multiplier only when followed by end, whitespace, punctuation, or a currency symbol; a following Unicode letter/digit must leave it as description text.
- [ ] Re-run the parser test and commit the focused parser change.

### Task 2: Add conservative voice-money normalization

**Files:**
- Create: `apps/api/src/voiceMoneyNormalization.js`
- Create: `apps/api/test/voiceMoneyNormalization.test.js`
- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/test/telegram.test.js`

- [ ] Write failing tests asserting `Такси 8-50 лари`, `8:50 лари`, `8 50 лари`, and `Такси восемь пятьдесят лари` normalize to `Такси 8.50 лари`, while `встреча в 8:50`, ranges, dates, and multiple currency amounts are unchanged.
- [ ] Run `node --test apps/api/test/voiceMoneyNormalization.test.js apps/api/test/telegram.test.js` and confirm the new module is absent.
- [ ] Implement `normalizeVoiceMoneyTranscript(text)`: require exactly one recognized unambiguous currency context adjacent to exactly one eligible amount, translate only two-decimal separators and narrow Russian `<unit> <tens>` forms, otherwise return source unchanged.
- [ ] Call it after successful transcription and before parsing. For every safe voice parse failure, render the sanitized parsed transcript through the existing `amountNotFoundWithTranscript` formatter.
- [ ] Re-run the focused voice and Telegram tests and commit.

### Task 3: Make accepted captures restart-resumable

**Files:**
- Create: `apps/api/migrations/022_telegram_capture_inbox.sql`
- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/src/telegramJobQueue.js`
- Modify: `apps/api/src/config.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/test/repository.test.js`
- Modify: `apps/api/test/config.test.js`
- Modify: `apps/api/test/telegram.test.js`
- Modify: `apps/api/integration/postgres-smoke.js`

- [ ] Write failing repository/Telegram tests proving that ten messages for one user are accepted in message order, a duplicate message ID produces one draft, an accepted capture is listable after a simulated restart, and timeout/failure yields exactly one user-visible terminal retry state.
- [ ] Run `node --test apps/api/test/repository.test.js apps/api/test/config.test.js apps/api/test/telegram.test.js` and confirm the durable inbox APIs do not exist.
- [ ] Add the migration columns `payload JSONB`, `last_error_code TEXT`, `attempt_count INTEGER NOT NULL DEFAULT 0`, and `finished_at TIMESTAMPTZ` to `telegram_expense_captures`; preserve the unique identity and completed-draft replay contract.
- [ ] Persist minimal restart-resumable message fields before enqueueing regular text/voice work. List runnable owned captures at startup and after each job finish; re-run them via the existing per-user fair scheduler. Do not place payload text/IDs in logs or analytics; clear payload at terminal completion/failure.
- [ ] Raise the ordinary default user pending capacity to 16, keep a bounded global capacity, and only send an overload response before a durable claim was created. Persist a safe terminal error code before cleaning the loader and sending its localized retry result.
- [ ] Add a disposable PostgreSQL smoke for replay, lease reclaim, and ten capture identities; run focused checks and `npm.cmd run test:integration:postgres`, then commit.

### Task 4: Avoid rate-provider work inside confirmation locks

**Files:**
- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/test/repository.test.js`
- Modify: `apps/api/test/draftConfirmation.test.js`
- Modify: `apps/api/integration/postgres-smoke.js`

- [ ] Write failing tests where `THB -> THB` and `GEL -> GEL` confirmations make zero `ratesFor()` calls, and cross-currency rate retrieval happens before `BEGIN` / financial-month locking. Include concurrent confirm returning one expense set.
- [ ] Run `node --test apps/api/test/repository.test.js apps/api/test/draftConfirmation.test.js` and confirm current behavior makes an identity rate call.
- [ ] Make `buildMoneyAmounts()` return a base-only identity conversion without `ratesFor()` when original equals base. For cross currency, read a draft snapshot and precompute rates before `BEGIN`, then lock/re-read and compare draft version/items/base currency; retry precompute once if a concurrent edit changed the snapshot.
- [ ] Preserve `saveDraftAsExpense()` as the sole atomic/idempotent persistence boundary, closed-month checks, category acceptance, callback ACK, and post-persistence success semantics.
- [ ] Run focused tests plus the disposable PostgreSQL smoke and commit.

### Task 5: Document, verify, and publish

**Files:**
- Modify: `docs/DOMAIN_RULES.md`
- Modify: `docs/TESTING_GUIDE.md`

- [ ] Document ownership-before-acceptance, durable terminal outcomes, safe diagnostics, and the affected disposable PostgreSQL smoke.
- [ ] Run `npm.cmd test -- packages/shared/test/parser.test.js apps/api/test/voiceMoneyNormalization.test.js apps/api/test/expenseDraftService.test.js apps/api/test/telegram.test.js apps/api/test/repository.test.js apps/api/test/draftConfirmation.test.js`.
- [ ] Run `npm.cmd run test:integration:postgres`, `npm.cmd test`, and `git diff --check`; record actual results.
- [ ] Commit only #206 files, push `codex/issue-206-expense-capture`, and open a draft PR with `Closes #206`, DB forward-fix notes, sanitized alert evidence, and `## User Release Notes`. Do not merge or deploy.
