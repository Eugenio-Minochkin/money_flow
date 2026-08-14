# Zero-Friction Shortcut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save Smart Save-eligible iPhone Shortcut expenses in the initial request while returning every uncertain capture as a normal unresolved draft.

**Architecture:** Add a small Shortcut orchestration service that reuses the durable `clientRequestId` draft claim, the shared `classifySmartSaveDraft()` decision, and canonical `saveDraftAsExpense()`. A completed claim replay is reclassified and idempotently re-saved, so a lost response returns the original expense without parsing or inserting again; review drafts remain in the shared `pending`/`inbox` backlog. Keep bearer authentication, token lifecycle, and legacy confirm/cancel routes unchanged.

**Tech Stack:** Node.js ESM, PostgreSQL repository transactions, Node test runner, Markdown contract docs.

---

### Task 1: Add the Shortcut Smart Save orchestration contract

**Files:**
- Create: `apps/api/src/shortcutCapture.js`
- Create: `apps/api/test/shortcutCapture.test.js`

- [x] **Step 1: Write failing service tests**

Cover a safe single item, `needs_review`, parser `other`, multiple items, completed replay, and same-process concurrency. The desired result shapes are:

```js
assert.deepEqual(result, {
  state: "saved",
  expense: savedExpense,
  summary: "✓ Coffee · 180 THB",
  replayed: false,
  alreadySaved: false
});
assert.deepEqual(review, {
  state: "review",
  draft,
  reason: "category_required",
  replayed: false
});
```

The replay test must assert one parser call, one financial fact, and the same expense ID.

- [x] **Step 2: Run RED**

Run: `npm.cmd test -- apps/api/test/shortcutCapture.test.js`

Expected: FAIL because `shortcutCapture.js` does not exist.

- [x] **Step 3: Implement the minimal service**

```js
export async function processShortcutCapture(input) {
  const created = await createShortcutExpenseDraft(input);
  const closedMonthKeys = await input.repository.listClosedReserveMonthsForTelegramUser(input.user.telegram_user_id);
  const classification = classifySmartSaveDraft(created.draft, {
    timeZone: input.user.timezone,
    closedMonthKeys
  });
  if (!classification.eligible) {
    return { state: "review", draft: created.draft, reason: classification.reason, replayed: created.replayed };
  }
  const saved = await input.repository.saveDraftAsExpense(created.draft.id, input.user.telegram_user_id);
  const expense = saved.expenses[0];
  return {
    state: "saved",
    expense,
    summary: formatShortcutSavedSummary(expense),
    replayed: created.replayed,
    alreadySaved: saved.alreadySaved
  };
}
```

Use a short plain-text formatter and no separate classifier or persistence path.

- [x] **Step 4: Run GREEN**

Run: `npm.cmd test -- apps/api/test/shortcutCapture.test.js apps/api/test/expenseDraftService.test.js apps/api/test/smartSave.test.js`

Expected: PASS.

### Task 2: Expose the explicit API and Shortcut workflow

**Files:**
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/test/security.test.js`
- Modify: `docs/ios-shortcut.md`
- Modify: `docs/TESTING_GUIDE.md`

- [x] **Step 1: Write failing route and docs contract tests**

Assert `/api/shortcut/expenses` still resolves the bearer token, calls `processShortcutCapture()`, returns the explicit state result, records submitted/confirmed events only on first/new save, and maps in-progress claims to 409. Assert docs branch on `state=saved` / `state=review`, retain the UUID for retry, and no longer require preview/Confirm for safe items.

- [x] **Step 2: Run RED**

Run: `npm.cmd test -- apps/api/test/security.test.js`

Expected: FAIL because the route still returns `{ draft, replayed }` and the docs still require Confirm/Cancel.

- [x] **Step 3: Route through the service and update docs**

```js
const result = await processShortcutCapture({
  user,
  tokenId: user.token_id,
  clientRequestId: body.clientRequestId,
  text: body.text,
  expenseParser,
  repository
});
if (!result.replayed) await repository.recordAppEvent?.(user.id, "quick_entry_submitted", { source: "ios_shortcut" });
if (result.state === "saved" && !result.alreadySaved) {
  await repository.recordAppEvent?.(user.id, "quick_entry_confirmed", { source: "ios_shortcut" });
}
return sendJson(res, result.replayed ? 200 : 201, result);
```

Keep the bearer token model and existing confirm/cancel endpoints unchanged for review/backward compatibility.

- [x] **Step 4: Run GREEN**

Run: `npm.cmd test -- apps/api/test/security.test.js apps/api/test/shortcutCapture.test.js`

Expected: PASS.

### Task 3: Prove durable PostgreSQL replay and finish verification

**Files:**
- Modify: `apps/api/integration/postgres-smoke.js`
- Modify: `docs/superpowers/plans/2026-08-14-zero-friction-shortcut.md`

- [x] **Step 1: Extend the disposable PostgreSQL smoke**

Run two concurrent `processShortcutCapture()` calls with the same token and `clientRequestId`, then replay it after completion. Assert the parser ran once, all responses contain the same expense ID, and PostgreSQL contains one draft plus one expense for that request.

- [x] **Step 2: Run focused and full verification**

Run:

```powershell
npm.cmd test -- apps/api/test/shortcutCapture.test.js apps/api/test/expenseDraftService.test.js apps/api/test/smartSave.test.js apps/api/test/security.test.js
npm.cmd run test:integration:postgres
npm.cmd test
git diff --check
```

Expected: all available checks pass; if local PostgreSQL is unavailable, report that exact limitation and rely on the included disposable CI smoke without claiming it ran locally.

Local evidence: focused Shortcut/API checks passed 60/60; full `npm.cmd test` passed 1503 with 6 expected skips and 0 failures; `node --check` and `git diff --check` passed. The PostgreSQL runner did not start because `DATABASE_URL` was absent and the local Docker daemon was unavailable, so the added disposable smoke remains a CI gate.

- [ ] **Step 3: Publish a narrow draft PR**

Commit and push `codex/issue-176-zero-friction-shortcut`, open a draft PR with `Closes #176` and `## User Release Notes`, then verify its exact head and required checks. Do not merge or deploy.
