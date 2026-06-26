# Expense Fast Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make simple RU/EN expense messages use a safe local parser path while preserving LLM behavior for ambiguous cases.

**Architecture:** The shared parser produces deterministic candidate expenses. The API parser evaluates whether the candidate is safe for the current rollout mode, then either returns local output, records shadow metadata, or calls OpenAI. Telegram carries parser metadata into perf events, and admin stats aggregate those fields.

**Tech Stack:** Node.js ESM, `node:test`, PostgreSQL JSON metadata aggregation.

---

### Task 1: Shared Parser And Category Safety

**Files:**
- Modify: `packages/shared/src/parser.js`
- Modify: `packages/shared/src/categories.js`
- Test: `packages/shared/test/parser.test.js`
- Test: `packages/shared/test/categories.test.js`

- [ ] Add failing tests for RU/EN amount-before and amount-after description, attached currency symbols, safe currency aliases, ambiguous numeric formats, small leading bare integer guard, clean multi-split, and whole-token category matching.
- [ ] Implement deterministic amount/currency parsing and conservative category dictionaries.
- [ ] Run `node --test packages/shared/test/parser.test.js packages/shared/test/categories.test.js`.

### Task 2: API Parser Fast Path Modes

**Files:**
- Modify: `apps/api/src/config.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/src/expenseParser.js`
- Test: `apps/api/test/expenseParser.test.js`

- [ ] Add failing tests for `off`, `shadow`, `enabled`, unknown category review, stop-pattern rejection, ambiguous multi-amount rejection, OpenAI failure local fallback, and shadow disagreement fields.
- [ ] Implement `EXPENSE_FAST_PATH_MODE`, local fast-path evaluation, stop-patterns, mode behavior, and parser metadata.
- [ ] Run `node --test apps/api/test/expenseParser.test.js`.

### Task 3: Telegram Metadata

**Files:**
- Modify: `apps/api/src/telegram.js`
- Test: `apps/api/test/telegram.test.js`

- [ ] Add failing text and voice tests proving parser metadata appears in `message_processing_completed`.
- [ ] Emit `message_processing_completed` when expense processing completes, including parser metadata and `transcriptChars` for voice when available.
- [ ] Run `node --test apps/api/test/telegram.test.js`.

### Task 4: Admin Stats

**Files:**
- Modify: `apps/api/src/adminStatsService.js`
- Test: `apps/api/test/adminStatsService.test.js`

- [ ] Add failing tests for parser engine counts, LLM skipped count, reject reasons, category review rate, shadow disagreement count/rate, and local/LLM average processing split.
- [ ] Extend SQL aggregation and compact Telegram formatting without removing existing lines.
- [ ] Run `node --test apps/api/test/adminStatsService.test.js`.

### Task 5: Verification

- [ ] Run all targeted tests.
- [ ] Run `npm test`.
- [ ] Review `git diff` for scope and accidental unrelated changes.
