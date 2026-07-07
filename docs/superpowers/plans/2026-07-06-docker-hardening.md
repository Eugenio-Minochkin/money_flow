# Docker Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the production Docker containers less fragile and more production-ready with minimal, additive changes: non-root API container, Docker healthchecks for API and Postgres, ordered startup (API waits for a healthy Postgres), and a runbook section documenting the new checks. No business logic, DB schema, migrations, env names, or the existing `runWithRetry` connection retry are touched.

**Scope guardrails (from task):**
- Do NOT change application business logic, DB schema, or migrations.
- Do NOT rename env variables.
- Do NOT remove `runWithRetry`; it stays as the app-level connection fallback.
- Do NOT rewrite Dockerfile/compose from scratch — additive changes only.
- Do NOT change service names, ports, or volume names.

**Architecture / current state (doc-grounded):**
- `Dockerfile` — `node:24-alpine`, runs as root, no `USER`, no healthcheck. `CMD ["node", "apps/api/src/server.js"]`, `EXPOSE 3000`.
- `docker-compose.yml` — dev compose; only the `postgres` service (API runs locally via `npm run dev:api`).
- `compose.prod.yml` — production; `api` + `postgres`. API currently uses `depends_on: - postgres` (list form, no condition). No healthchecks.
- `/health` endpoint already exists (`apps/api/src/server.js`, DB-backed `SELECT 1`, returns `{ok,db}`); `scripts/prod-security-check.sh` already curls it.
- `runWithRetry` lives in `apps/api/src/db.js` and is used by `migrate()` at startup.
- The API has no runtime filesystem writes (verified) → a read-only `/app` is fine for a non-root user.

**Tech Stack:** Dockerfile, Docker Compose v2 (compose spec), Node 24 (global `fetch`), Postgres 16 `pg_isready`.

**Key decisions:**
- **Non-root user:** create a dedicated system user/group `app` in the image, `chown -R app:app /app`, then `USER app`. Dedicated user (not the built-in `node` user) matches the explicit task requirement and keeps intent clear.
- **API healthcheck:** declared in the `Dockerfile` via `HEALTHCHECK` using `node -e` + global `fetch` against the existing `http://127.0.0.1:3000/health` (no curl/wget dependency; node is guaranteed present). Reuses the existing endpoint — no new route added.
- **Postgres healthcheck:** declared in compose via `pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"` using `$$` escaping so credentials come from the container env (not hardcoded).
- **Startup order:** convert `api.depends_on` to the long form with `condition: service_healthy`. The deploy already uses `docker compose` (v2), which supports this. `runWithRetry` remains as the app-level fallback regardless.
- **Healthchecks are additive** and do not change env var names, service names, ports, or volumes.

---

### Task 1: Non-root API container + API healthcheck (Dockerfile)

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1:** After the source `COPY` steps, add a `RUN` that creates a system group/user `app` and sets ownership of `/app` (`addgroup -S app && adduser -S -G app app && chown -R app:app /app`).
- [ ] **Step 2:** Add `USER app` before `CMD`.
- [ ] **Step 3:** Add a `HEALTHCHECK` (interval 30s, timeout 5s, start-period 30s, retries 3) using `node -e` with global `fetch` against `http://127.0.0.1:3000/health`, exiting 0 on HTTP 2xx and 1 otherwise.
- [ ] **Step 4:** Keep `npm ci --omit=dev`, the `COPY` steps, `ENV NODE_ENV=production`, `EXPOSE 3000`, and the `CMD` unchanged.

### Task 2: Postgres healthcheck + ordered startup (compose.prod.yml)

**Files:**
- Modify: `compose.prod.yml`

- [ ] **Step 1:** Add a `healthcheck` to the `postgres` service using `pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"` (CMD-SHELL with `$$` escaping), `interval: 10s`, `timeout: 5s`, `retries: 5`, `start_period: 10s`.
- [ ] **Step 2:** Convert the `api` service `depends_on` to the long form: `postgres: { condition: service_healthy }`.
- [ ] **Step 3:** Do not change any env keys, the api port mapping (`127.0.0.1:3000:3000`), service names, or the `postgres_data` volume.

### Task 3: Dev Postgres healthcheck (docker-compose.yml)

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1:** Add the same `pg_isready` `healthcheck` to the dev `postgres` service so `docker compose ps` reports health in dev too. No other changes.

### Task 4: Tests for hardening

**Files:**
- Modify: `test/deploymentWorkflow.test.js`

- [ ] **Step 1:** Add a test asserting the API `Dockerfile` runs as a non-root user (`USER` present, not `root`/`0`) and defines a healthcheck targeting `/health`.
- [ ] **Step 2:** Add a test asserting `compose.prod.yml` makes the API wait for a healthy Postgres (`condition: service_healthy`) and that the Postgres service has a `pg_isready` healthcheck that does not hardcode the password.
- [ ] **Step 3:** Ensure the existing `productionEnvContract.test.js` env-key parser still passes (the env block is unchanged and terminates at `depends_on`).

### Task 5: Runbook update

**Files:**
- Modify: `docs/deployment-runbook.md`

- [ ] **Step 1:** Add a "Docker health and hardening" section documenting: `docker compose ps` health status, `docker compose logs api --tail=100`, `docker compose exec api id` (must not be `uid=0`), Postgres health inspection, what to do when API or Postgres is unhealthy, and the note that `depends_on.condition: service_healthy` reduces early-start risk while `runWithRetry` remains the app-level fallback.

### Task 6: Verification

- [ ] **Step 1:** Run `npm test` — all tests green.
- [ ] **Step 2:** Build the image locally; confirm `id` inside the container is non-root.
- [ ] **Step 3:** Bring up the prod compose stack locally with a throwaway env; confirm `docker compose ps` shows healthy API + Postgres and `/health` returns 200. Tear down with `-v`.
- [ ] **Step 4:** Confirm `runWithRetry` in `apps/api/src/db.js` is unchanged.

### Task 7: PR

- [ ] **Step 1:** Commit on `codex/docker-hardening`, push, open a PR into `master` with summary, files changed, verification evidence (`ps` output, `id` output), and the explicit statement that `runWithRetry` is retained.
