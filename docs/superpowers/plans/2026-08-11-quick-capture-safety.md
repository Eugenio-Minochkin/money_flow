# Quick Capture Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Mini App Quick Capture retry-safe and make Shortcut key replacement safe when copy or network operations fail.

**Architecture:** A new durable, user-scoped Quick Capture request ledger claims `clientRequestId`, then the parser runs outside a database transaction and the resulting draft is linked atomically to the claim. Replays return that same draft and keep `saveDraftAsExpense()` as the final idempotent expense boundary. Shortcut keys use an inactive prepared-token row: copy happens before a small activation transaction that revokes the previous active key only when the prepared key can be activated.

**Tech Stack:** Node.js HTTP API, PostgreSQL migrations and repository transactions, vanilla Mini App JavaScript, Node test runner.

---

### Task 1: Add durable Mini App Quick Capture claims

**Files:**
- Create: `apps/api/migrations/015_quick_capture_safety.sql`
- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/src/expenseDraftService.js`
- Test: `apps/api/test/expenseDraftService.test.js`
- Test: `apps/api/test/repository.test.js`

- [x] **Step 1: Write failing behavioral tests**

```js
const first = createMiniAppQuickCaptureDraft(input);
const second = createMiniAppQuickCaptureDraft(input);
const [a, b] = await Promise.all([first, second]);
assert.equal(a.draft.id, b.draft.id);
assert.equal(parserCalls, 1);
```

Also assert a completed claim replays without invoking the parser and repository SQL scopes the unique claim by `user_id, client_request_id`.

- [x] **Step 2: Run the focused tests and verify RED**

Run: `npm.cmd test -- apps/api/test/expenseDraftService.test.js apps/api/test/repository.test.js`

Expected: FAIL because Mini App claims do not exist.

- [x] **Step 3: Add the smallest durable request ledger and service**

```sql
CREATE TABLE IF NOT EXISTS quick_capture_requests (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_request_id TEXT NOT NULL,
  draft_id BIGINT REFERENCES drafts(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed')),
  claim_version BIGINT NOT NULL DEFAULT 0,
  lease_expires_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE(user_id, client_request_id)
);
```

Implement `claimMiniAppQuickCaptureRequest`, `waitForMiniAppQuickCaptureRequest`, `releaseMiniAppQuickCaptureRequest`, and `completeMiniAppQuickCaptureRequest`; parse only after claim and before the transaction that inserts the draft and completes the claim.

- [x] **Step 4: Re-run the focused tests and verify GREEN**

Run: `npm.cmd test -- apps/api/test/expenseDraftService.test.js apps/api/test/repository.test.js`

Expected: PASS; a same-process and replayed request use one draft.

### Task 2: Route Quick Entry through the durable claim

**Files:**
- Modify: `apps/api/src/quickCapture.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/miniapp/src/app.js`
- Test: `apps/api/test/quickCapture.test.js`
- Test: `apps/miniapp/test/smokeAssets.test.js`

- [x] **Step 1: Write failing Quick Capture replay tests**

```js
const first = await processMiniAppQuickCapture(input);
const replay = await processMiniAppQuickCapture(input);
assert.deepEqual(replay.saved.expenses, first.saved.expenses);
assert.equal(expenses.size, 1);
```

Cover safe autosave replay, review replay, and preservation of `category_source: "parser"` for an untouched confident item.

- [x] **Step 2: Run the focused tests and verify RED**

Run: `npm.cmd test -- apps/api/test/quickCapture.test.js apps/miniapp/test/smokeAssets.test.js`

Expected: FAIL because Quick Entry has no reusable client request id or replay service.

- [x] **Step 3: Implement the minimal request/replay flow**

```js
const clientRequestId = quickEntryRequestId ??= crypto.randomUUID();
const result = await processMiniAppQuickCapture({ user, clientRequestId, text, expenseParser, repository });
if (result.saved) return sendJson(res, result.replayed ? 200 : 201, { saved: result.saved });
return sendJson(res, result.replayed ? 200 : 201, { draft: result.draft });
```

Clear `quickEntryRequestId` only after a response is rendered or when the typed text changes. In review, set `category_source: "user"` only when a category select was actually rendered for that item.

- [x] **Step 4: Re-run the focused tests and verify GREEN**

Run: `npm.cmd test -- apps/api/test/quickCapture.test.js apps/miniapp/test/smokeAssets.test.js`

Expected: PASS; retry reuses its prior outcome without duplicate draft or expense.

### Task 3: Prepare then activate Shortcut keys

**Files:**
- Modify: `apps/api/migrations/015_quick_capture_safety.sql`
- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/miniapp/src/app.js`
- Modify: `apps/miniapp/src/i18n.js`
- Test: `apps/api/test/repository.test.js`
- Test: `apps/miniapp/test/smokeAssets.test.js`

- [x] **Step 1: Write failing token-lifecycle tests**

```js
const prepared = await repository.prepareQuickAccessToken(user.id, hash);
assert.equal(activeTokenRevoked, false);
await repository.activatePreparedQuickAccessToken(user.id, prepared.id);
assert.equal(activeTokenRevoked, true);
```

Also assert a UI copy failure cannot call activation and that reload language says a key is prepared rather than claiming Shortcut installation.

- [x] **Step 2: Run the focused tests and verify RED**

Run: `npm.cmd test -- apps/api/test/repository.test.js apps/miniapp/test/smokeAssets.test.js`

Expected: FAIL because token creation revokes the active key before copying.

- [x] **Step 3: Implement prepare/activate endpoints and UI retry state**

```js
const prepared = await api("/api/quick-access-token-preparations", { method: "POST", body: { telegramUserId } });
await navigator.clipboard.writeText(prepared.token);
quickAccessPreparationId = prepared.preparationId;
await api(`/api/quick-access-token-preparations/${quickAccessPreparationId}/activate`, { method: "POST", body: { telegramUserId } });
```

Prepared hashes remain inactive and expire; activation is idempotent for the same preparation and transactionally revokes only the prior active keys. Never issue a standalone revoke from reconfigure. Keep only token hashes in PostgreSQL and never render the raw token.

- [x] **Step 4: Re-run the focused tests and verify GREEN**

Run: `npm.cmd test -- apps/api/test/repository.test.js apps/miniapp/test/smokeAssets.test.js`

Expected: PASS; failed copy/network cannot invalidate a working old key.

### Task 4: Verify and update the draft PR

**Files:**
- Modify: `docs/TESTING_GUIDE.md`
- Modify: `docs/superpowers/plans/2026-08-11-quick-capture-safety.md`

- [x] **Step 1: Add durable Quick Capture coverage to the test guide**

Document request-claim replay, auto-save/review outcomes, token prepare/activate safety, and category-source provenance.

- [x] **Step 2: Run full local verification**

Run: `npm.cmd test`

Expected: 0 failures.

- [ ] **Step 3: Check the diff, commit, push, and verify the draft PR head**

Run: `git diff --check`, push `codex/quick-capture-ux`, then verify `gh pr view 152 --json isDraft,headRefOid,url`.

Expected: no whitespace errors, PR #152 remains draft, and no merge or deploy occurs.
