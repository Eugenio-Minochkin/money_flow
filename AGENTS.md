# Money Flow Agent Guide

Money Flow is a lightweight personal expense tracker, not an accounting system.
Keep changes focused on helping one user understand day-to-day money movement with as little friction as possible.

## Working Agreement For Agents

- Treat `master` and production as protected. Do not push directly to `master`, merge your own PR, deploy, roll back, SSH into production, or run production commands unless the user explicitly asks for that exact action in the current task.
- Make code and documentation changes on a short-lived branch, open a GitHub PR into `master`, and send the user the PR link for review. Stop after opening or updating the PR unless the user explicitly asks to merge or deploy.
- Opening or updating a draft PR is the required completion step for code/documentation changes and does not require separate approval. Only merge, deploy, production access, and database writes require explicit approval.
- Classify the task as DIRECT, STANDARD, or DEEP before choosing a workflow. Use the least heavy process that reliably addresses the task; do not turn a local change into a broader project. If an existing approved plan under `docs/superpowers/plans/` is directly applicable, follow it and keep its status honest.
- Ask clarifying questions when requirements are ambiguous, especially around product behavior, budgets, currencies, planned payments, reserve, onboarding, reminders, Telegram UX, release notes, security, migrations, database writes, or production operations. If progress is still safe without an answer, document assumptions in the PR.
- Keep the scope narrow. Do not include drive-by refactors, dependency upgrades, formatting churn, or unrelated fixes without asking first.
- Before editing, inspect the relevant code, tests, and docs. Do not guess paths or rewrite flows from memory.

## Task Complexity Routing

- **DIRECT** — an unambiguous, local change with a known or quickly verifiable cause; no public API, schema, security, dependency, migration, or product/architecture decision changes. Examples: typo, text change, small CSS defect, focused fixture correction, obvious null guard, or a single existing configuration value. Inspect the relevant files, make the smallest change, run proportionate focused verification, and report it briefly. Do not wait for a separate confirmation before a safe DIRECT change. Do not automatically invoke `using-superpowers`, `grill-with-docs`, brainstorming, systematic debugging, TDD, a large plan, a worktree, or subagents.
- **STANDARD** — a bounded change across several related parts where the intended behavior is understood. A short 3–6 step outline, focused tests, and one directly relevant skill are allowed when they materially reduce risk. Do not start interviews, worktrees, multiple subagents, or a separate design process without a concrete need.
- **DEEP** — a change with unresolved product or architecture choices, a public API, migration/schema/security impact, major cross-layer behavior, or multiple independent workstreams. First clarify the unresolved decision. Brainstorming, an implementation plan, isolation, or subagents may be used only when each is proportionate to that concrete risk. `grill-with-docs` runs only on a direct user request.
- Apply `systematic-debugging` when the cause of a failure is unknown or ambiguous. For an obvious local regression, inspect the relevant evidence and add focused regression coverage when code behavior changes; do not automatically run the full debugging workflow.
- Apply TDD to a testable change of behavior when a reasonable regression test can be added, especially new or substantially changed business logic. It is not required for text, documentation, configuration-only, fixture-only, or obvious CSS edits unless a changed behavior needs regression coverage.
- Keep verification proportionate: a focused check is sufficient for DIRECT; expand it only when the change or its risk warrants it. Explicit user requests for a named skill always take precedence.

## Start-Of-Task Git Hygiene

- Before changing files, fetch and sync from `origin/master`.
- If working on `master`, run `git pull --ff-only origin master` before creating a task branch.
- Create task branches only from updated `master` / `origin/master`, not from stale local history.
- Verify that repository instruction files such as `AGENTS.md` and required docs such as `docs/superpowers/` exist locally before editing.
- If sync fails, the branch has diverged, the working tree is unexpectedly dirty, or required instruction/docs files are missing locally, stop and ask the user. Do not create missing instruction files from scratch.
- Do not use `git reset --hard`, `git stash`, branch deletion, or overwrite local files unless the user explicitly approves that exact recovery action.

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

- Ephemeral local/test database writes performed by the automated test suite are allowed.
- Never point tests, scripts, migrations, seeders, backfills, or ad-hoc SQL at production, staging, or any persistent/user-data database without explicit user approval for that exact operation.
- Read-only diagnostic SQL is allowed only when it is needed to understand a bug. Redact real financial data, Telegram IDs, emails, tokens, and secrets from shared output.
- For schema migrations, describe the DB impact and rollback/forward-fix plan in the PR. Destructive or data-rewriting migrations require explicit approval before implementation.

## Testing And PR Readiness

- Add or update tests for changed behavior. Prefer focused failing tests first, then implementation.
- Run relevant focused tests before the full test suite. For broad changes, run `npm test`.
- Review `git diff` before committing and remove accidental unrelated changes.
- Every PR should include: summary, changed areas, docs checked/updated, tests run, DB/prod impact, release notes impact, screenshots for UI changes, and any open questions or assumptions.
- Every PR with user-visible changes must include the `## User Release Notes` block described in `docs/deployment-runbook.md`.
- Every PR that adds or changes admin alerts / Telegram observability must show an example alert from a test or local run in the PR description, with sensitive values redacted and message length reviewed.

## Secret Hygiene

Never add secrets to documentation or examples: `.env` values, API keys, Telegram IDs, real user financial data, production credentials, or production database contents.
