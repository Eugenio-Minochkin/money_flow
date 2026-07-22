# Planned payment undo — implementation plan

- [x] 1. Add repository red tests for exact-link undo, ownership, invalid date,
  idempotency, consistency, reserve closure, snapshot stability, and analytics.
- [x] 2. Implement the one-client transaction with plan → payment → expense
  locking and post-commit, privacy-minimal analytics.
- [x] 3. Add the exact authenticated DELETE route and API/security status tests.
- [x] 4. Add the Mini App occurrence buttons, translations, and isolated undo
  lifecycle helper with pure interaction tests.
- [x] 5. Extend the disposable PostgreSQL smoke scenario and update focused
  domain/testing documentation.
- [ ] 6. Run focused tests, full `npm.cmd test`, PostgreSQL smoke, narrow-width
  RU/EN visual QA; commit, push, and open a draft PR. Automated checks and
  draft PR are complete; screenshots remain the final review artifact.
