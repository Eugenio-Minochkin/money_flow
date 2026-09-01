# MVP Launch Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add transparent bilingual data handling disclosure and durable configurable per-user guardrails before paid OpenAI and Deepgram calls.

**Architecture:** Keep the Settings disclosure static and localised, with no sensitive data embedded in the DOM. Add a small repository-backed usage-window boundary that atomically reserves a provider allowance before a paid request; parser and transcriber consume it only on their paid routes. Existing durable request claims remain ahead of parser work, and Telegram voice capture is claimed before transcription so an idempotent replay cannot reserve usage twice.

**Tech Stack:** Node.js ESM, PostgreSQL migrations/repository, Telegram Bot API, Mini App vanilla JS/CSS, node:test.

---

### Task 1: Durable paid-provider allowance

**Files:**
- Create: `apps/api/migrations/019_paid_provider_usage.sql`
- Create: `apps/api/src/paidProviderUsage.js`
- Modify: `apps/api/src/repository.js`
- Test: `apps/api/test/paidProviderUsage.test.js`

- [ ] **Step 1: Write failing usage-window tests**

Cover first reservation, exact request boundary, rolling reset after 24 hours, audio-second boundary, and an already-reserved idempotency key.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test apps/api/test/paidProviderUsage.test.js`

Expected: FAIL because the provider usage boundary does not exist.

- [ ] **Step 3: Implement the minimal atomic reservation boundary**

Add `paid_provider_usage_windows` and a repository method that locks one `(user_id, provider)` row, resets it after the configured window, refuses exhausted request/audio budgets, and persists only provider, counters, timestamps, and a non-sensitive request identity.

- [ ] **Step 4: Re-run the focused test**

Run: `node --test apps/api/test/paidProviderUsage.test.js`

Expected: PASS.

### Task 2: OpenAI and Deepgram enforcement

**Files:**
- Modify: `apps/api/src/config.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/src/expenseParser.js`
- Modify: `apps/api/src/voiceTranscriber.js`
- Modify: `apps/api/src/expenseDraftService.js`
- Modify: `apps/api/src/telegram.js`
- Test: `apps/api/test/expenseParser.test.js`
- Test: `apps/api/test/voiceTranscriber.test.js`
- Test: `apps/api/test/telegram.test.js`

- [ ] **Step 1: Write failing paid-route tests**

Assert local-safe parsing skips allowance, LLM reservation happens immediately before the OpenAI call, disabled/exhausted LLM produces a controlled error, voice rejects a duration over 60 seconds before network work, and a 15-minute audio budget prevents Deepgram submission.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test apps/api/test/expenseParser.test.js apps/api/test/voiceTranscriber.test.js apps/api/test/telegram.test.js`

Expected: FAIL because no paid-provider allowance is consulted.

- [ ] **Step 3: Implement the narrow provider adapters**

Pass the repository-backed reservation callbacks from `server.js`; set defaults to 24 hours, 100 LLM requests, 50 transcriptions, 60 seconds per voice message, and 900 audio seconds per voice window. Add independent `OPENAI_PARSER_GLOBAL_ENABLED` and `DEEPGRAM_TRANSCRIPTION_GLOBAL_ENABLED` switches. Map disabled/exhausted provider errors to existing controlled Telegram and API outcomes; never include source text, audio, headers, tokens, or profile data in metadata.

- [ ] **Step 4: Claim Telegram voice before transcription**

Use the existing Telegram capture identity before invoking the voice provider, return its completed draft on replay, and release a failed claim so retrying a failed operation remains possible without silently duplicating a paid call.

- [ ] **Step 5: Re-run focused tests**

Run: `node --test apps/api/test/expenseParser.test.js apps/api/test/voiceTranscriber.test.js apps/api/test/telegram.test.js`

Expected: PASS.

### Task 3: Data disclosure and operational documentation

**Files:**
- Modify: `apps/miniapp/src/index.html`
- Modify: `apps/miniapp/src/i18n.js`
- Modify: `apps/miniapp/src/styles.css`
- Modify: `apps/miniapp/test/i18n.test.js`
- Modify: `apps/miniapp/test/settingsStartupSmoke.test.js`
- Modify: `.env.production.example`
- Modify: `docs/deployment-runbook.md`

- [ ] **Step 1: Write failing UI/document contract tests**

Assert Settings contains one compact disclosure entry with RU/EN copy and no secret-like or raw-financial static content.

- [ ] **Step 2: Run focused UI tests and verify failure**

Run: `node --test apps/miniapp/test/i18n.test.js apps/miniapp/test/settingsStartupSmoke.test.js`

Expected: FAIL because the disclosure entry is absent.

- [ ] **Step 3: Implement minimal Settings disclosure and env docs**

Place one expandable data/privacy entry next to existing export/delete controls. State only the established processing boundaries, metadata-only analytics, export/delete flows, and no PostgreSQL storage of raw secrets or Quick Access tokens. Document all defaults and kill switches without secrets.

- [ ] **Step 4: Re-run focused UI tests**

Run: `node --test apps/miniapp/test/i18n.test.js apps/miniapp/test/settingsStartupSmoke.test.js`

Expected: PASS.

### Task 4: Integration verification and draft PR

**Files:**
- Verify: `apps/api/integration/postgres-smoke.js`
- Verify: repository diff and PR metadata

- [ ] **Step 1: Run relevant suite**

Run: `npm.cmd test`

Expected: all tests pass.

- [ ] **Step 2: Check changes**

Run: `git diff --check; git diff --stat`

Expected: no whitespace errors and no unrelated changes.

- [ ] **Step 3: Commit and open a draft PR**

Use a narrow conventional commit and draft PR into `master`, including release notes, test evidence, migration impact, no production action, and no sensitive values.
