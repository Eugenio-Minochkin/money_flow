# Telegram independent parse implementation plan

> Execution: scoped Luna implementation and bounded Sol design/final concurrency review, under the approved issue #233 scope.

**Goal:** Save and deliver an independent local-safe B before the preceding slow LLM A settles.
**Architecture:** Keep every running job inside the existing global concurrency cap. Permit up to two independent same-user text jobs, with FIFO barriers for stateful input. Acquire a per-user mutation lease after parsing and retain it through persistence and terminal delivery.
**Tech stack:** Node test runner, PostgreSQL smoke harness, existing Telegram capture repository.

- [x] Inspect master, capture lifecycle, financial boundary and existing characterization.
- [x] Bounded Sol design: no global slot release; commands/editor/callbacks require real barriers.
- [x] Queue regression tests first: overtaking, barrier ordering, cancellation, reservations and bounded load. Implement independent scheduling and cancellation-aware mutation acquisition in telegramJobQueue.js.
- [x] Telegram regression first: real rejected parser A and safe B, independent eligibility, durable replay and stateful barriers. Integrate async pre-persist mutation acquisition in expenseDraftService.js and telegram.js.
- [x] Parser regression first: propagate parent cancellation without fallback or early resource release.
- [ ] PostgreSQL checks: concurrent ready drafts, month closure during FX, changed base currency and snapshot revalidation.
- [x] Lab benchmark: injected 20-second A, B saved and delivered under one second, aggregate stage timings only.
- [x] Update domain/decision/testing documentation, run focused tests then npm.cmd test and git diff --check.
- [ ] Final bounded Sol review; resolve concrete findings, open draft PR and verify exact-head unit/PostgreSQL CI. No merge or production operations.

Validation: local full suite 1753 tests / 1747 pass / 6 Windows POSIX skips. The 20-second lab delay completed B in 194.8 ms before A. Final Sol finding (queued callback ACK) is fixed with a real queue regression. PostgreSQL smoke cases are added; execution awaits disposable GitHub CI because local Docker is unavailable.
