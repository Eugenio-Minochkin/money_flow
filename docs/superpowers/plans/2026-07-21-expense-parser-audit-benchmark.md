# Expense Parser Audit And Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add privacy-safe read-only historical audit tooling and a reproducible synthetic RU/EN model/prompt benchmark without accessing production or changing runtime behavior.

**Architecture:** Keep database access, pure aggregation/privacy logic, benchmark scoring, synthetic fixtures, and executable CLI adapters in separate modules. Both CLIs emit only bounded aggregate JSON; tests inject database/model adapters so ordinary CI performs no external calls.

**Tech Stack:** Node.js ESM, `node:test`, existing `pg` dependency, existing expense parser and shared time/category helpers.

---

### Task 1: Read-only audit contract

**Files:**
- Create: `apps/api/test/parserAudit.test.js`
- Create: `apps/api/src/parserAudit.js`

- [x] Write failing tests that require strict floors (`minCount >= 3`, `minDistinctUsers >= 2`, `dominanceThreshold >= 0.8`), RU/EN separation, identifier removal, rare-candidate suppression, confirmed-expense category truth, unconfirmed review-only evidence, and a report with no raw fields or IDs.
- [x] Run `node --test apps/api/test/parserAudit.test.js` and verify failure because the module does not exist.
- [x] Implement pure normalization, candidate extraction, aggregation, dominance decisions, percentile-free report formatting, and fixed `HISTORICAL_AUDIT_SQL` that reads regular drafts plus confirmed expenses through `draft_id`.
- [x] Re-run the focused test and keep the implementation free of stdout/file writes.

### Task 2: Safe database runner and CLI

**Files:**
- Create: `apps/api/test/parserAuditScript.test.js`
- Create: `apps/api/scripts/audit-expense-parser.js`
- Modify: `package.json`

- [x] Write failing tests for argument parsing, dedicated audit URL, loopback-only `local-copy`, verified server posture for `read-replica`, `BEGIN TRANSACTION READ ONLY`, validated `SET LOCAL statement_timeout`, fixed SELECT-only query execution, unconditional `ROLLBACK`, and safe configuration errors.
- [x] Run `node --test apps/api/test/parserAuditScript.test.js apps/api/test/parserAudit.test.js` and verify expected failures.
- [x] Implement the injected runner and executable `parser:audit` adapter using `pg.Client`; add a write-keyword guard over executable audit SQL and never print an error object, URL, query parameters, or row data.
- [x] Re-run audit tests and verify all database calls are read-only.

### Task 3: Synthetic benchmark corpus and scorer

**Files:**
- Create: `packages/shared/testFixtures/expense-parser-benchmark-corpus.js`
- Create: `apps/api/test/parserBenchmark.test.js`
- Create: `apps/api/src/parserBenchmark.js`

- [x] Write failing tests for a fixed invented RU/EN corpus, critical versus reviewable correctness, per-language aggregation, errors represented only by safe case IDs/codes, and P50/P95 latency calculated independently from correctness.
- [x] Run `node --test apps/api/test/parserBenchmark.test.js` and verify failure because the benchmark module is absent.
- [x] Implement a pure scorer and injected variant runner. Compare expense count, amount, currency, timezone-aware day, normalized budget impact, category, and `needs_review` without logging fixture text.
- [x] Re-run benchmark tests.

### Task 4: Explicit real-API benchmark adapter

**Files:**
- Create: `apps/api/test/parserBenchmarkScript.test.js`
- Create: `apps/api/scripts/benchmark-expense-parser.js`
- Modify: `package.json`

- [x] Write failing tests proving the CLI defaults to configured `OPENAI_MODEL`/`gpt-5-mini` and candidate `gpt-5-nano`, requires an API key only for explicit execution, forces LLM-only parser routing, never mutates configuration, and emits safe aggregate JSON.
- [x] Run `node --test apps/api/test/parserBenchmarkScript.test.js apps/api/test/parserBenchmark.test.js` and verify expected failures without making network calls.
- [x] Implement `parser:benchmark:api` using `createExpenseParser({ fastPathMode: "off" })`, the current prompt/schema, injected fetch in tests, and fixed synthetic inputs. Record model result and `llmHttpMs`; normalize failures to a fixed safe code.
- [x] Re-run benchmark-focused tests and confirm no ordinary test can reach the network.

### Task 5: Documentation and decision rules

**Files:**
- Create: `docs/expense-parser-audit-benchmark.md`
- Modify: `CONTEXT.md`
- Modify: `docs/DECISIONS.md`
- Modify: `docs/TESTING_GUIDE.md`

- [x] Document exact local-copy/read-replica commands, safe-source checks, report schema, privacy exclusions, thresholds, manual alias rules, benchmark invocation, and the statement `blocked: production data not provided`.
- [x] Add glossary terms for Historical Parser Audit and Alias Candidate without implementation detail.
- [x] Record that confirmed expenses are category truth, RU/EN stay separate, no automatic alias/model change is allowed, and all real-data/model decisions are follow-up PRs.
- [x] Add a follow-up checklist for owner-run aggregate audit, candidate review, synthetic generalization, model quality gate, and separate PR approval.

### Task 6: Verification and publication

**Files:**
- Modify only files already listed if verification finds a scoped defect.

- [x] Run focused tests: `node --test apps/api/test/parserAudit.test.js apps/api/test/parserAuditScript.test.js apps/api/test/parserBenchmark.test.js apps/api/test/parserBenchmarkScript.test.js`.
- [x] Run `npm.cmd test` and confirm zero failures.
- [x] Run `git diff --check` and review `origin/master...HEAD` for privacy, write queries, production access, model/config changes, and scope.
- [ ] Commit and push `codex/issue-115c-parser-audit-benchmark`.
- [ ] Open a draft PR into `master` with tooling/docs summary, test evidence, safe aggregate example, explicit audit blocker, DB/prod impact, no model switch, follow-up list, and `## User Release Notes`.
- [ ] Do not merge, deploy, access production, change production env/rollout, switch the model, or add real user messages.
