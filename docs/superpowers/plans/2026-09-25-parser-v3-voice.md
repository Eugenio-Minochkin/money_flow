# Parser v3 and voice acceptance implementation plan

**Goal:** Complete available #235 implementation and verify #210 synthetic voice paths; stop at Draft PR.

**Architecture:** Keep existing rollout and canonical save. Return category-only uncertainty locally; resolve single unknown descriptions from current human-confirmed history with an indexed, bounded lookup. No persistent phrase map or positive cache.

**Tech stack:** Node test runner, PostgreSQL, existing parser and Telegram services.

- [x] Reproduce paid category guessing in `apps/api/test/expenseParser.test.js`, then return `local_review` only for category-only uncertainty in `apps/api/src/expenseParser.js`. Preserve other review reasons, rollout and unsafe intent guards.
- [x] Add `apps/api/src/categoryMemory.js` and tests: exact user-scoped SQL normalization; at most 101 matches; abstain above 100; three distinct explicitly confirmed single-item drafts; any current category conflict vetoes. Require current draft/expense description and category agreement. No learning from Smart Save.
- [x] Add an index-only migration on user and normalized-description digest, with exact normalized equality rechecked to guard collisions. Bound connection acquisition and query time; release late connections and destroy timed-out clients. Failure returns no hint.
- [x] Wire the lookup in `server.js` and `expenseParser.js` using internal `usageUserId` only. Hints change category/review flags only, retain parser provenance, and never turn `other` into automatic acceptance.
- [x] Audit #210 and expand queued synthetic voice regressions in `telegram.test.js`; no production change unless a defect is reproduced.
- [x] Add disposable PostgreSQL coverage for agreement, conflict, user isolation, provenance, edits/deletion, query/index behavior and overhead. Run focused tests before `npm.cmd test`; run `git diff --check`.
- [x] Update domain/product/testing decisions, record benchmarks and blockers, prepare Draft PR. Historical aliases await approved aggregate data; real Telegram/Deepgram voice recordings remain manual acceptance.

No merge, production access, rollout changes or historical database audit is authorized by this implementation plan. Index creation runs through the existing transactional migration runner and may briefly block expense writes during a separately authorized deployment; rollback can leave the index unused.

## Evidence and remaining external acceptance

- RED: corpus unknown-category and paid-usage tests failed before routing changes; personal lookup tests failed before implementation; `J3 30 GEL` failed before the numeric-token boundary fix.
- Focused parser/Telegram/memory/shared corpus: 333 passed. Full suite: 1772 passed, 6 POSIX-only skips, zero failures. Disposable localhost PostgreSQL 17: 51 passed including the additive migration twice, current-history invalidation and replay.
- Synthetic Node 24 parser benchmark: fixed date/timezone, 20 warmups then 200 samples per route; P50/P95 milliseconds: local_safe 0.65/1.04, local_review 1.18/1.60, mocked personal hint 1.18/1.96. No paid requests. Cold startup/JIT and Telegram/queue delivery are excluded.
- Real local PostgreSQL query benchmark: 30 warm synthetic lookups, P50 0.85ms / P95 0.96ms. Tiny fixture; the EXPLAIN index-eligibility check locally disables seq scans, so it is not a production query-plan/scale claim.
- Observability: the existing `local_fast_path_count` includes both new routes. The older `local_primary_count` still counts only the named `local_primary` route; it is not the total of all no-LLM results. Individual traces distinguish `local_review` and `local_category_memory`; no phrase map or new admin alert is emitted.
- Historical aliases: blocked because an approved copy/replica or safe aggregate report was not supplied. No new global aliases are claimed. Owner procedure remains `docs/expense-parser-audit-benchmark.md`.
- #210 manual acceptance remains: physical voice recordings of `чурчхела семь лари`, `такси семь лари`, `такси три пятьдесят лари`, `такси три точка пятьдесят лари`, `такси триста пятьдесят лари`, plus text `Такси 3,50 лари`. Verify 7 / 3.50 / 350 GEL as appropriate, one final response replacing the loader, and an actionable response for unclear speech/ambiguous currency. Synthetic transcriber tests do not establish real Deepgram/device acceptance.
