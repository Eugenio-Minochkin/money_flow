# Money Flow Agent Guide

Money Flow is a lightweight personal expense tracker, not an accounting system.
Keep changes focused on helping one user understand day-to-day money movement with as little friction as possible.

## Working Agreement For Agents

- Treat `master` and production as protected. Do not push directly to `master`, merge your own PR, deploy, roll back, SSH into production, or run production commands unless the user explicitly asks for that exact action in the current task.
- Make code and documentation changes on a short-lived branch, open a GitHub PR into `master`, and send the user the PR link for review. Stop after opening or updating the PR unless the user explicitly asks to merge or deploy.
- Use the mandatory skills before implementation: `grill-with-docs` / "grill with docs" for doc-grounded understanding and `superpowers` for planning/execution. If a task already has a plan under `docs/superpowers/plans/`, follow it checkbox by checkbox and keep the plan status honest.
- Ask clarifying questions when requirements are ambiguous, especially around product behavior, budgets, currencies, planned payments, reserve, onboarding, reminders, Telegram UX, release notes, security, migrations, database writes, or production operations. If progress is still safe without an answer, document assumptions in the PR.
- Keep the scope narrow. Do not include drive-by refactors, dependency upgrades, formatting churn, or unrelated fixes without asking first.
- Before editing, inspect the relevant code, tests, and docs. Do not guess paths or rewrite flows from memory.

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

## Database And Production Safety

- Never change production database contents without explicit user approval for the exact operation.
- Do not run write SQL, destructive migrations, seed scripts, backfills, deletes, updates, restores, or rollbacks against any database without approval and a rollback plan.
- Read-only diagnostic SQL is allowed only when it is needed to understand a bug. Redact real financial data, Telegram IDs, emails, tokens, and secrets from shared output.
- For schema migrations, describe the DB impact and rollback/forward-fix plan in the PR. Destructive or data-rewriting migrations require explicit approval before implementation.

## Testing And PR Readiness

- Add or update tests for changed behavior. Prefer focused failing tests first, then implementation.
- Run relevant focused tests before the full test suite. For broad changes, run `npm test`.
- Review `git diff` before committing and remove accidental unrelated changes.
- Every PR should include: summary, changed areas, docs checked/updated, tests run, DB/prod impact, release notes impact, screenshots for UI changes, and any open questions or assumptions.
- Every PR with user-visible changes must include the `## User Release Notes` block described in `docs/deployment-runbook.md`.

## Secret Hygiene

Never add secrets to documentation or examples: `.env` values, API keys, Telegram IDs, real user financial data, production credentials, or production database contents.
