# Planned payment undo — implementation plan

- [ ] 1. Add repository red tests for exact-link undo, ownership, invalid date,
  idempotency, consistency, reserve closure, snapshot stability, and analytics.
- [ ] 2. Implement the one-client transaction with plan → payment → expense
  locking and post-commit, privacy-minimal analytics.
- [ ] 3. Add the exact authenticated DELETE route and API/security status tests.
- [ ] 4. Add the Mini App occurrence buttons, translations, and isolated undo
  lifecycle helper with pure interaction tests.
- [ ] 5. Extend the disposable PostgreSQL smoke scenario and update focused
  domain/testing documentation.
- [ ] 6. Run focused tests, full `npm.cmd test`, PostgreSQL smoke, narrow-width
  RU/EN visual QA; commit, push, and open a draft PR.
