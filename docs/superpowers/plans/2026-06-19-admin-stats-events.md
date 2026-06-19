# Admin Stats Event Instrumentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate `/admin_stats` from normal Telegram activity and historical expense/draft data without allowing observability failures to affect users.

**Architecture:** The repository owns a best-effort `recordAppEvent` insert. Telegram emits lifecycle events at successful or failed processing boundaries, while `adminStatsService` selects event counts first and per-metric table fallbacks only when event counts are zero.

**Tech Stack:** Node.js ES modules, PostgreSQL, built-in `node:test`.

---

### Task 1: Best-effort repository event writer

**Files:**
- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/test/repository.test.js`

- [x] **Step 1: Add failing repository tests**

Add one test asserting:

```js
await repo.recordAppEvent(7, "message_received", { inputType: "text" });
assert.match(queries[0].sql, /INSERT INTO app_events/);
assert.deepEqual(queries[0].params, [7, "message_received", JSON.stringify({ inputType: "text" })]);
```

Add another test whose pool throws and assert `recordAppEvent` resolves while a structured warning is written.

- [x] **Step 2: Verify RED**

Run:

```powershell
node --test apps/api/test/repository.test.js
```

Expected: fail because `recordAppEvent` does not exist.

- [x] **Step 3: Implement the repository method**

Insert into `app_events (user_id, event_name, metadata)` using JSON metadata. Catch failures inside the method and warn with event name, user ID, and error message only.

- [x] **Step 4: Verify GREEN**

Run the repository test file and confirm zero failures.

### Task 2: Telegram message and draft lifecycle events

**Files:**
- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/test/telegram.test.js`

- [x] **Step 1: Add failing message-flow tests**

Extend the fake repository with an `events` array and `recordAppEvent`.

Test a normal text message and assert:

```js
[
  ["message_received", { inputType: "text" }],
  ["expense_draft_created", { inputType: "text", draftType: "regular" }],
  ["message_processing_completed", { inputType: "text", processingTotalMs: assertNumber }]
]
```

Test `/admin_stats` and assert no `message_received` event is recorded.

- [x] **Step 2: Verify RED**

Run:

```powershell
node --test apps/api/test/telegram.test.js
```

Expected: event assertions fail because Telegram emits no app events.

- [x] **Step 3: Implement message processing events**

Derive `inputType`, emit `message_received` only after command handling, and wrap queued expense processing so `message_processing_completed` is emitted from `finally`.

Emit `expense_draft_created` after regular/planned draft creation.

- [x] **Step 4: Add failing confirm/cancel tests**

Assert regular confirmation emits one `expense_draft_confirmed` plus one `expense_saved` per returned expense. Assert regular and planned cancellation emit `expense_draft_cancelled`.

- [x] **Step 5: Implement callback lifecycle events**

Use the callback-resolved internal user ID. Emit events only after successful repository operations.

- [x] **Step 6: Add and implement failure-path tests**

Test empty parse, voice transcription error, and a throwing `recordAppEvent` implementation. Verify parse/transcription events are attempted and user-visible processing does not crash.

- [x] **Step 7: Verify focused Telegram tests**

Run the Telegram test file and confirm zero failures.

### Task 3: Historical fallback metrics

**Files:**
- Modify: `apps/api/src/adminStatsService.js`
- Modify: `apps/api/test/adminStatsService.test.js`

- [x] **Step 1: Add failing fallback tests**

Return zero event counts and non-zero table aggregate rows:

```js
{
  expenses_saved: 4,
  drafts_created: 7,
  drafts_confirmed: 5,
  drafts_cancelled: 2
}
```

Assert those values are used, including regular and planned drafts.

- [x] **Step 2: Verify RED**

Run:

```powershell
node --test apps/api/test/adminStatsService.test.js
```

Expected: fallback assertions fail.

- [x] **Step 3: Implement table aggregate query**

Query expenses by `created_at`, created drafts by `created_at`, confirmed drafts by `confirmed_at`, and cancelled drafts by `status` plus `created_at`. Sum regular and planned draft tables.

- [x] **Step 4: Apply per-metric event precedence**

Use fallback only when that event metric is zero. Keep messages, active users, errors, and averages event-only.

- [x] **Step 5: Verify admin stats tests**

Run the admin stats test file and confirm event averages, users-created-at behavior, and fallback metrics pass.

### Task 4: End-to-end regression and publication

**Files:**
- Modify: `docs/superpowers/plans/2026-06-19-admin-stats-events.md`

- [x] **Step 1: Run focused tests**

```powershell
node --test apps/api/test/repository.test.js apps/api/test/telegram.test.js apps/api/test/adminStatsService.test.js
```

- [x] **Step 2: Run full suite**

```powershell
npm.cmd test
```

Expected: zero failures.

- [x] **Step 3: Check diff**

```powershell
git diff --check
git status -sb
```

- [x] **Step 4: Commit and push**

Stage only the event instrumentation, fallback, tests, and plan. Commit with:

```text
fix: record admin stats events
```

- [x] **Step 5: Open a draft PR**

Target `master`, summarize event instrumentation and historical fallback, list verification evidence, and reference the admin stats issue context.
