# GitHub Actions Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub Actions CI/CD path so pushes to `master` test and deploy Money Flow to the existing server over SSH.

**Architecture:** GitHub Actions runs Node tests for all pushes and pull requests. Deploy runs only for `master` or manual workflow dispatch, connects to the server over SSH, checks out the requested ref in `/opt/money-flow`, rebuilds with Docker Compose, and runs the production check script.

**Tech Stack:** GitHub Actions, OpenSSH, Docker Compose, Node.js `node --test`.

---

### Task 1: Deployment Workflow Contract Test

**Files:**
- Create: `test/deploymentWorkflow.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/deploymentWorkflow.test.js` with assertions for `.github/workflows/deploy.yml` and `docs/deployment-runbook.md`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/deploymentWorkflow.test.js`

Expected: fail because the workflow and runbook do not exist yet.

### Task 2: GitHub Actions Workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Add CI and deploy workflow**

Create a workflow with:

- `ci` job on push and pull request.
- `deploy` job after `ci`.
- deploy only when the event is a push to `refs/heads/master` or `workflow_dispatch`.
- SSH setup from GitHub Secrets.
- remote `git checkout --force "$DEPLOY_REF"`.
- `docker compose --env-file .env.production -f compose.prod.yml up -d --build`.
- `./scripts/prod-security-check.sh`.

- [ ] **Step 2: Run the focused test**

Run: `npm test -- test/deploymentWorkflow.test.js`

Expected: pass.

### Task 3: Operator Runbook

**Files:**
- Create: `docs/deployment-runbook.md`

- [ ] **Step 1: Document daily development flow**

Include commands for status, testing, staging, commit, push, and reading Git history.

- [ ] **Step 2: Document first-time server/GitHub setup**

Include SSH key generation, server `authorized_keys`, GitHub Secrets, server app directory, and `.env.production` ownership.

- [ ] **Step 3: Document rollback**

Document manual workflow dispatch with an older commit SHA.

- [ ] **Step 4: Run all tests**

Run: `npm test`

Expected: all tests pass.
