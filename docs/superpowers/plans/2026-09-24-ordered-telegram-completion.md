# Ordered Telegram completion implementation plan

**Goal:** Fix #237 while retaining bounded parallel expense parsing and durable idempotency.

**Architecture:** Extend the existing per-user queue to reserve admission order before asynchronous context lookup. Hold the mutation/completion turn through bounded terminal delivery. Retain the existing capture payload until delivery finalization; reclaim only the oldest unfinished capture per user without occupying worker slots with orphaned successors. No schema or public API change.

**Tech stack:** Node.js, node:test, PostgreSQL, existing Telegram queue and capture repository.

- [x] Inspect #237, current master, queue, bot, capture repository and domain/testing/UI docs. Isolate unrelated Mini App work. Baseline: 1747 passing, 6 skipped.
- [x] Add failing PostgreSQL regression in apps/api/integration/postgres-smoke.js for retained completed/failed results, old lease ordering, and stale finalization ownership.
- [x] Implement retained payload and claim-version guarded finalization in apps/api/src/repository.js; verify PostgreSQL regression and repository unit tests.
- [x] Add failing queue/bot regressions before implementation: parallel ready B, strict A/B/C effects, controlled errors/timeouts, slow admission, replay and recovery.
- [x] Update apps/api/src/telegramJobQueue.js and apps/api/src/telegram.js with ordered admission/completion and durable recovery hooks. Preserve source-message loaders and stateful barriers.
- [x] Verify bot recovery against real PostgreSQL, then run focused tests, full npm.cmd test, npm.cmd run test:integration:postgres and git diff --check.
- [x] Review final diff for ordering/liveness risks and unnecessary complexity; update product/domain/UI/testing documentation and prepare the draft PR. PR delivery is tracked in GitHub.

## Routing evidence and operational limit

A synthetic local run of the issue phrase with fastPathMode=enabled and rollout=100 yields local_primary, local_safe, llmSkipped=true. Off/shadow/excluded rollout can still invoke the LLM. Production configuration and trace were not accessed or changed, so the historical slowdown remains unverified.

## Recovery semantics

No migration or data backfill. Existing finished captures with null payload remain finished. A crash after Telegram accepts a response but before finalization can repeat that response; the saved expense remains idempotent. Ordered terminalization means a bounded delivery attempt, including a controlled final delivery failure, because a Telegram outage must not permanently lock a user's queue.

Final local verification: 1763 unit tests, 1757 passed, 6 Windows POSIX skips, 0 failures; PostgreSQL smoke 43/43; git diff --check clean. The 20-second ordering regression fails on the original bot/queue and passes on the fix.
