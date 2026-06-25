# Money Flow Agent Guide

Money Flow is a lightweight personal expense tracker, not an accounting system.
Keep changes focused on helping one user understand day-to-day money movement with as little friction as possible.

## Product Shape

- Main flow: user sends an expense by text or voice -> bot parses it -> user confirms -> expense is saved -> dashboard refreshes the budget state.
- Prefer polishing existing MVP scenarios over adding large new features.
- Do not rewrite unrelated flows unless the user explicitly asks for that.
- Do not rename domain concepts unless the user explicitly asks for that.

## Domain Safety

- Before changing budget, planned payment, reserve, onboarding, dashboard, or currency logic, read `docs/DOMAIN_RULES.md`.
- When changing business logic, add or update tests that cover the changed behavior.
- When making an important domain change, update `docs/DOMAIN_RULES.md` or `docs/DECISIONS.md`.
- Keep `docs/PRODUCT_CONTEXT.md`, `docs/UI_PRINCIPLES.md`, and `docs/TESTING_GUIDE.md` in sync with product-facing changes.

## Secret Hygiene

Never add secrets to documentation or examples: `.env` values, API keys, Telegram IDs, real user financial data, production credentials, or production database contents.
