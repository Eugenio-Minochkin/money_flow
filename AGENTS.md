# Money Flow Agent Guide

Money Flow is a lightweight personal expense tracker, not an accounting system.
Keep changes focused on helping one user understand day-to-day money movement with as little friction as possible.

## Working Agreement For Agents

- Treat `master` and production as protected. Do not push directly to `master`, merge your own PR, deploy, roll back, SSH into production, or run production commands unless the user explicitly asks for that exact action in the current task.
- For requested code or documentation implementation, use a short-lived task branch. Ordinary pushes of that branch and opening or updating a draft PR into `master` are explicitly authorized without another confirmation; this is the repository exception to the global push restriction. Send the PR link after checking the published head and checks. Do not force-push, amend, merge, or deploy without an explicit request.
- A draft PR is the required completion step for code/documentation changes unless the user requests local-only work. If publication is blocked, preserve the patch and report the actual blocker. Production access and persistent/user-data database writes require explicit approval under the safety rules below.
- Follow the loaded global rules for task/model routing, skills, narrow scope, proportional verification, and simplify; keep those definitions in one place. If global rules are unavailable, use the smallest safe workflow and the configured model, and disclose missing model-routing guidance. Follow an existing approved plan under `docs/superpowers/plans/` only when directly applicable, and keep its status honest.
- Ask clarifying questions when requirements are ambiguous, especially around product behavior, budgets, currencies, planned payments, reserve, onboarding, reminders, Telegram UX, release notes, security, migrations, database writes, or production operations. If progress is still safe without an answer, document assumptions in the PR.
- Before editing, inspect the relevant code, tests, and docs. Do not guess paths or rewrite flows from memory.

## Start-Of-Task Git Hygiene

- Inspect branch, worktree status, and relevant local changes before editing. Fetch `origin/master` once when starting new implementation; create new task branches from the refreshed remote base. On a clean `master`, use `git pull --ff-only origin master` before branching.
- When continuing an existing task branch, preserve it; do not switch to `master` or merge/rebase automatically. Ask the user to choose merge or rebase only when integration of diverged history is actually needed.
- Unrelated local changes are not an automatic blocker. Preserve them and continue if they do not overlap the task; use an isolated worktree from the refreshed base when needed. Ask only if overlapping changes cannot be safely separated or ownership is unclear.
- If fetch/sync fails, diagnose the cause and continue independent read-only work or safe local preparation with the known base explicitly disclosed. Do not claim the branch is current; resolve the base before publishing a new task PR.
- Read relevant instruction/docs files before editing. If a required file is missing, check the fetched base and existing paths first; ask only when the missing guidance blocks safe progress. Do not fabricate missing instructions.
- Do not use `git reset --hard`, `git stash`, branch deletion, or overwrite another task's changes without explicit approval for that recovery action. See `docs/deployment-runbook.md` for commands.

## Product Shape

- Main flow: user sends an expense by text or voice -> bot parses it -> user confirms -> expense is saved -> dashboard refreshes the budget state.
- Prefer polishing existing MVP scenarios over adding large new features.
- Do not rewrite unrelated flows unless the user explicitly asks for that.
- Do not rename domain concepts unless the user explicitly asks for that.

## Domain Safety

- Before changing budget, planned payment, reserve, onboarding, dashboard, or currency logic, read `docs/DOMAIN_RULES.md`.
- When making an important domain change, update `docs/DOMAIN_RULES.md` or `docs/DECISIONS.md`.
- Keep `docs/PRODUCT_CONTEXT.md`, `docs/UI_PRINCIPLES.md`, and `docs/TESTING_GUIDE.md` in sync with product-facing changes.

## Database And Production Safety

- Ephemeral local/test database writes performed by the automated test suite are allowed.
- Never point tests, scripts, migrations, seeders, backfills, or ad-hoc SQL at production, staging, or any persistent/user-data database without explicit user approval for that exact operation.
- Read-only diagnostic SQL is allowed only when it is needed to understand a bug. Redact real financial data, Telegram IDs, emails, tokens, and secrets from shared output.
- For schema migrations, describe the DB impact and rollback/forward-fix plan in the PR. Destructive or data-rewriting migrations require explicit approval before implementation.

## Testing And PR Readiness

- Use `docs/TESTING_GUIDE.md` to select relevant focused tests; on Windows use `npm.cmd test -- <test-path>`. Run the full `npm.cmd test` suite when the change or its risk warrants it.
- Review `git diff` before committing and remove accidental unrelated changes.
- Every PR should explain the concrete change and actual verification. Include docs updates, DB/prod impact, screenshots, and assumptions only when relevant; avoid empty checklist sections. Report material blockers and unverified behavior.
- Every PR with user-visible changes must include the `## User Release Notes` block described in `docs/deployment-runbook.md`.
- Every PR that adds or changes admin alerts / Telegram observability must show an example alert from a test or local run in the PR description, with sensitive values redacted and message length reviewed.

## Secret Hygiene

Never add secrets to documentation or examples: `.env` values, API keys, Telegram IDs, real user financial data, production credentials, or production database contents.
