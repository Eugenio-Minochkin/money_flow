# GitHub Actions Deploy Design

## Goal

Make Money Flow deployable without relying on a Codex session: local changes are tested, committed, pushed to GitHub, and production updates automatically after `master` changes.

## Chosen Flow

Money Flow will use GitHub Actions as the control plane and the existing server as the build/runtime host.

1. Developers make changes locally.
2. `npm test` runs locally before commit.
3. Every push and pull request runs CI in GitHub Actions.
4. A push to `master` runs deployment after CI succeeds.
5. Deployment connects to the server over SSH.
6. The server checks out the requested Git ref in `/opt/money-flow`.
7. Docker Compose rebuilds and restarts the production services.
8. The production security check script verifies health and critical exposure rules.

## Architecture

GitHub stores only deployment transport secrets:

- `PROD_SSH_HOST`
- `PROD_SSH_USER`
- `PROD_SSH_KEY`
- optional `PROD_SSH_PORT`
- optional `PROD_APP_DIR`
- optional `PROD_SSH_KNOWN_HOSTS`

Application secrets stay on the server in `.env.production`. The workflow never copies Telegram, database, OpenAI, or Deepgram secrets into GitHub.

## Deployment Command

The remote deployment command is intentionally close to the current README flow:

```bash
cd /opt/money-flow
git fetch origin --prune --tags
git checkout --force "$DEPLOY_REF"
docker compose --env-file .env.production -f compose.prod.yml up -d --build
./scripts/prod-security-check.sh
```

`DEPLOY_REF` is the GitHub commit SHA for automatic deployments, or a manually supplied ref for rollback and redeploy runs.

## Rollback

Rollback uses the same deploy workflow manually with an older commit SHA. This avoids a separate rollback mechanism and keeps the server state reproducible from Git.

## Local Operator Flow

The documented solo-developer flow is:

```bash
git status
npm test
git add <files>
git commit -m "<message>"
git push origin master
```

If production needs to roll back:

```bash
git log --oneline
```

Then run the GitHub Actions deploy workflow manually with the previous good commit SHA.

## Error Handling

CI failures block deployment. SSH failures, Docker build failures, failed container startup, or failed security checks mark the deploy workflow red in GitHub Actions.

The workflow does not delete server files. It relies on the server checkout and Docker Compose project state already used by Money Flow.

## Testing

The repository will include a Node test that verifies the workflow and runbook exist and contain the required deployment controls:

- CI is configured for pushes and pull requests.
- Deploy is configured for `master`.
- Manual redeploy/rollback is configured.
- The remote deployment uses `.env.production`, `compose.prod.yml`, and `prod-security-check.sh`.
- The runbook documents GitHub Secrets and rollback.
