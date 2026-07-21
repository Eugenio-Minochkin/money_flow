# Expense Parser Observability And Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add compatible parser acceptance classification, internal timings, safe LLM timeout handling, shadow severity, privacy-safe telemetry, technical stats, and rollout documentation without changing the production rollout or enabling a new `local_reviewable` primary route.

**Architecture:** Keep the shared parser contract and current route decisions intact. Extend the API parser with an explicit classification and timing envelope, carry only allowlisted metadata through Telegram events, aggregate it in the existing technical-stats query, and wire one strictly validated timeout through existing config patterns.

**Tech Stack:** Node.js ESM, `node:test`, PostgreSQL JSONB aggregation, OpenAI Responses API, Docker Compose.

---

### Task 1: Record The Approved Domain And Design Contract

**Files:**
- Create: `docs/superpowers/specs/2026-07-21-expense-parser-observability-safety-design.md`
- Modify: `CONTEXT.md`
- Modify: `docs/DECISIONS.md`

- [x] **Step 1: Add glossary definitions**

Add implementation-free definitions for Local Safe Parse, Local Reviewable Parse, and Local Rejected Parse to `CONTEXT.md`, preserving the financial-field boundary approved in the design.

- [x] **Step 2: Record the reversible routing decision**

Add a dated decision to `docs/DECISIONS.md`: PR A classifies and measures `local_reviewable` but does not route it locally; PR B owns the user-visible routing change.

- [x] **Step 3: Check documentation consistency**

Run: `rg -n "local_safe|local_reviewable|local_rejected|PR A|PR B" CONTEXT.md docs/DECISIONS.md docs/superpowers/specs/2026-07-21-expense-parser-observability-safety-design.md`

Expected: all three acceptance levels are defined consistently and PR A explicitly preserves routing.

### Task 2: Add Acceptance Classification And Safe Shadow Comparison

**Files:**
- Modify: `apps/api/src/expenseParser.js`
- Test: `apps/api/test/expenseParser.test.js`

- [x] **Step 1: Write failing classification tests**

Add focused tests that expect `localAcceptanceLevel` to be `local_safe` for a confident local category, `local_reviewable` for `other + needs_review`, and `local_rejected` for a protected intent. Assert that PR A preserves the current local-primary decision rather than adding a new route.

- [x] **Step 2: Run the classification tests and verify RED**

Run: `node --test --test-name-pattern="local acceptance" apps/api/test/expenseParser.test.js`

Expected: FAIL because `localAcceptanceLevel` is absent.

- [x] **Step 3: Implement the minimal classification**

Replace the boolean-only evaluation result with a compatible object that retains `accepted`, `rejectReason`, and `categoryResolution` and adds exactly one enum:

```js
localAcceptanceLevel: "local_safe" | "local_reviewable" | "local_rejected"
```

Do not alter the route condition that determines whether an accepted candidate becomes local primary.

- [x] **Step 4: Write failing shadow severity tests**

Add tests proving comparison includes `budget_impact` and `needs_review`, converts both timestamps through `localDateKey(value, timeZone)`, marks amount/currency/count/date/budget differences critical, and marks category/needs-review-only differences reviewable.

- [x] **Step 5: Run shadow tests and verify RED**

Run: `node --test --test-name-pattern="shadow" apps/api/test/expenseParser.test.js`

Expected: FAIL on missing fields, severity booleans, or timezone-aware date behavior.

- [x] **Step 6: Implement the minimal comparison changes**

Pass `timeZone` into comparison, import the existing `localDateKey`, normalize missing `budget_impact` to `regular`, compare normalized booleans for `needs_review`, and emit:

```js
criticalShadowDisagreement
categoryOnlyShadowDisagreement
shadowDisagreementFields
```

- [x] **Step 7: Run focused parser tests and verify GREEN**

Run: `node --test apps/api/test/expenseParser.test.js`

Expected: all expense parser tests pass.

### Task 3: Split Internal Parser Timings

**Files:**
- Modify: `apps/api/src/expenseParser.js`
- Test: `apps/api/test/expenseParser.test.js`

- [x] **Step 1: Write failing timing tests**

Inject a monotonic `performanceNow` function into `createExpenseParser()` and assert route-appropriate metadata: local-only exposes local timings and parser total, LLM exposes HTTP and decode/normalize timings, and every duration is finite and non-negative.

- [x] **Step 2: Run timing tests and verify RED**

Run: `node --test --test-name-pattern="internal parser timing" apps/api/test/expenseParser.test.js`

Expected: FAIL because the five internal timing fields are absent.

- [x] **Step 3: Implement timing helpers**

Measure local parse and evaluation separately. Make `parseWithOpenAI()` return `llmHttpMs` and `llmDecodeNormalizeMs`. Emit `parserTotalMs` from every successful and error trace branch without recording financial values.

- [x] **Step 4: Run focused parser tests and verify GREEN**

Run: `node --test apps/api/test/expenseParser.test.js`

Expected: all expense parser tests pass.

### Task 4: Add Strict LLM Timeout And Safe Fallback

**Files:**
- Modify: `apps/api/src/config.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/src/expenseParser.js`
- Test: `apps/api/test/config.test.js`
- Test: `apps/api/test/expenseParser.test.js`

- [x] **Step 1: Write failing config tests**

Assert missing configuration defaults to `20000`; positive integers are accepted; zero, negative, fractional, non-numeric, and infinite values fall back to `20000`.

- [x] **Step 2: Run config tests and verify RED**

Run: `node --test --test-name-pattern="expense parser LLM timeout" apps/api/test/config.test.js`

Expected: FAIL because the config field does not exist.

- [x] **Step 3: Implement strict config validation and server wiring**

Add `DEFAULT_EXPENSE_PARSER_LLM_TIMEOUT_MS = 20_000`, parse only positive integers, expose `expenseParserLlmTimeoutMs`, and pass it to `createExpenseParser()`.

- [x] **Step 4: Write failing AbortController tests**

Use a fetch implementation that waits for `signal.abort`. Assert the signal is actually aborted, the thrown error has `code === "expense_parser_llm_timeout"`, no second fetch occurs, `local_safe` may fall back, and `local_reviewable` may not fall back.

- [x] **Step 5: Run timeout tests and verify RED**

Run: `node --test --test-name-pattern="LLM timeout|AbortController|local_safe fallback|local_reviewable fallback" apps/api/test/expenseParser.test.js`

Expected: FAIL because no signal, timeout code, or safe-only fallback exists.

- [x] **Step 6: Implement the timeout**

Create one controller per request, schedule `abort()` at the configured deadline, pass `signal` to fetch, clear the timer in `finally`, map timeout to a fixed coded error, do not retry, and permit the error fallback only when `localAcceptanceLevel === "local_safe"`.

- [x] **Step 7: Run focused config and parser tests and verify GREEN**

Run: `node --test apps/api/test/config.test.js apps/api/test/expenseParser.test.js`

Expected: all tests pass.

### Task 5: Carry Privacy-Safe Metadata Through Telegram

**Files:**
- Modify: `apps/api/src/telegram.js`
- Test: `apps/api/test/telegram.test.js`

- [x] **Step 1: Write failing metadata tests**

Assert `message_processing_completed` carries the new acceptance, timing, and shadow-severity fields for text and voice. Capture perf logger output and assert it does not contain `userId=` or a known Telegram ID. Assert local exception messages are absent.

- [x] **Step 2: Run Telegram metadata tests and verify RED**

Run: `node --test --test-name-pattern="parser metadata|performance log privacy" apps/api/test/telegram.test.js`

Expected: FAIL because new metadata is dropped and raw Telegram IDs are logged.

- [x] **Step 3: Implement allowlisted propagation and privacy cleanup**

Extend `pickLlmMetadata()` and the completion event with only the approved fields. Remove the Telegram ID from performance payloads and remove arbitrary local exception messages from parser metadata.

- [x] **Step 4: Run focused Telegram tests and verify GREEN**

Run: `node --test apps/api/test/telegram.test.js`

Expected: all Telegram tests pass and captured logs contain no raw Telegram ID.

### Task 6: Extend Technical Stats

**Files:**
- Modify: `apps/api/src/technicalStatsService.js`
- Test: `apps/api/test/technicalStatsService.test.js`
- Test: `apps/api/test/adminStatsService.test.js`

- [x] **Step 1: Write failing aggregation tests**

Extend fake SQL rows and assertions for candidate/accepted/primary counts, three acceptance levels, LLM fallback, avg/P95 local parse and LLM HTTP, critical/category-only samples and rates, amount/currency rates, and legacy rows with missing metadata.

- [x] **Step 2: Run aggregation tests and verify RED**

Run: `node --test apps/api/test/technicalStatsService.test.js apps/api/test/adminStatsService.test.js`

Expected: FAIL because the service does not map or format the new fields.

- [x] **Step 3: Implement JSONB aggregation**

Add numeric-only AVG/P95 expressions, enum-specific `COUNT(*) FILTER` expressions, safe denominators for rates, and zero/null fallbacks. Count a local candidate only when local parsing produced an evaluable candidate; count accepted as `local_safe + local_reviewable`; keep local primary based on the existing route.

- [x] **Step 4: Implement compact formatting**

Show the approved counts, timings, rates, samples, and reject maps. Print `insufficient sample` whenever the relevant shadow comparison sample is below 100.

- [x] **Step 5: Run focused stats tests and verify GREEN**

Run: `node --test apps/api/test/technicalStatsService.test.js apps/api/test/adminStatsService.test.js`

Expected: all technical stats tests pass.

### Task 7: Add Environment Contract And Rollout Runbook

**Files:**
- Modify: `.env.example`
- Modify: `.env.production.example`
- Modify: `compose.prod.yml`
- Modify: `docs/deployment-runbook.md`
- Modify: `test/productionEnvContract.test.js`
- Modify: `test/deploymentWorkflow.test.js`

- [x] **Step 1: Write failing environment and runbook tests**

Assert both examples contain `EXPENSE_PARSER_LLM_TIMEOUT_MS=20000`, compose passes it with default `20000`, and the runbook contains every rollout stage, the 100-comparison quality gate, stop conditions, the exact shadow rollback values, service restart requirement, full-off mode, and the prohibition on automatic production changes.

- [x] **Step 2: Run contract tests and verify RED**

Run: `node --test test/productionEnvContract.test.js test/deploymentWorkflow.test.js`

Expected: FAIL because the timeout key and rollout procedure are absent.

- [x] **Step 3: Update examples, compose, and runbook**

Add the key once to each example and compose. Document shadow, allowlist, 10%, 25%, 50%, and 100% stages with minimum sample sizes, metrics, stop conditions, and environment rollback followed by service restart. Do not change `.env.production` or run deployment commands.

- [x] **Step 4: Run contract tests and verify GREEN**

Run: `node --test test/productionEnvContract.test.js test/deploymentWorkflow.test.js`

Expected: all production contract tests pass.

### Task 8: Final Verification And Draft PR

**Files:**
- Review all modified PR A files.

- [x] **Step 1: Run all focused tests**

Run: `node --test apps/api/test/config.test.js apps/api/test/expenseParser.test.js apps/api/test/telegram.test.js apps/api/test/technicalStatsService.test.js apps/api/test/adminStatsService.test.js test/productionEnvContract.test.js test/deploymentWorkflow.test.js`

Expected: all focused tests pass.

- [x] **Step 2: Run the full suite**

Run: `npm.cmd test`

Expected: all tests pass with zero failures.

- [x] **Step 3: Check the diff**

Run: `git diff --check` and `git status --short`

Expected: no whitespace errors and only PR A files are changed.

- [ ] **Step 4: Commit and publish**

Stage only PR A files, commit with an intentional message, push `codex/issue-115a-parser-observability`, and open a draft PR into `master` containing baseline/result, docs checked, privacy impact, DB/production impact, exact rollback, assumptions, and `## User Release Notes`.
