# Admin Access Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Telegram admin authorization tolerant, consistent, suffix-aware, and safely diagnosable.

**Architecture:** Add a focused `adminAccess.js` module that owns parsing, authorization, and command normalization. Route all Telegram admin commands through these helpers and keep statistics/release services independent of access policy.

**Tech Stack:** Node.js ES modules, built-in `node:test`, strict assertions.

---

### Task 1: Shared admin access helpers

**Files:**
- Create: `apps/api/src/adminAccess.js`
- Create: `apps/api/test/adminAccess.test.js`
- Modify: `apps/api/test/adminStatsService.test.js`
- Modify: `apps/api/test/releaseNotesService.test.js`
- Modify: `apps/api/src/adminStatsService.js`
- Modify: `apps/api/src/releaseNotesService.js`

- [x] **Step 1: Write failing helper tests**

Test all accepted separators and wrappers, rejected unsafe values, number/string caller IDs, and bot-command suffix normalization.

- [x] **Step 2: Run helper tests and verify failure**

Run: `node --test apps/api/test/adminAccess.test.js`

Expected: fail because `adminAccess.js` does not exist.

- [x] **Step 3: Implement minimal shared helpers**

Implement token-based parsing without digit extraction, fail-closed authorization, and suffix removal for valid command text.

- [x] **Step 4: Move existing helper imports**

Remove duplicate parser/auth exports from service modules and import helpers from `adminAccess.js` in affected tests.

- [x] **Step 5: Run focused service/helper tests**

Run: `node --test apps/api/test/adminAccess.test.js apps/api/test/adminStatsService.test.js apps/api/test/releaseNotesService.test.js`

Expected: all tests pass.

### Task 2: Telegram command authorization and diagnostics

**Files:**
- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/test/telegram.test.js`
- Modify: `apps/api/src/server.js`

- [x] **Step 1: Write failing Telegram tests**

Add tests for string IDs, `/admin_stats@BotUsername`, release-command suffixes, denied-service isolation, and safe structured warning metadata.

- [x] **Step 2: Run focused Telegram tests and verify failure**

Run: `node --test apps/api/test/telegram.test.js`

Expected: new suffix and warning assertions fail.

- [x] **Step 3: Implement unified command flow**

Normalize command text once, use `isAdminTelegramId` for every admin command, and log the specified warning before denying `/admin_stats`.

- [x] **Step 4: Update server parser import**

Import `parseAdminTelegramIds` from `adminAccess.js`.

- [x] **Step 5: Run focused tests**

Run: `node --test apps/api/test/adminAccess.test.js apps/api/test/adminStatsService.test.js apps/api/test/releaseNotesService.test.js apps/api/test/telegram.test.js`

Expected: all tests pass.

### Task 3: Verification and publication

**Files:**
- Modify: `docs/superpowers/plans/2026-06-18-admin-access.md`

- [x] **Step 1: Run the full test suite**

Run: `npm test`

Expected: zero failures.

- [x] **Step 2: Run repository checks**

Run: `git diff --check`

Expected: no output and exit code 0.

- [x] **Step 3: Review the final diff**

Confirm issue #35 requirements are covered and no raw environment value reaches logs.

- [ ] **Step 4: Commit implementation**

Stage only issue #35 files and create a concise implementation commit.

- [ ] **Step 5: Push and create draft PR**

Push `codex/issue-35-admin-access` and create a draft PR targeting `master`, with `Closes #35` in the body.
