# Money Flow Deployment Runbook

This project deploys from GitHub Actions to the existing production server over SSH.

## Daily Local Flow

Use this when you change code yourself:

```bash
git status
npm test
git add <files>
git commit -m "Describe the change"
git push origin master
```

After `git push origin master`, GitHub Actions runs tests and then deploys production if tests pass.

Useful checks:

```bash
git log --oneline -n 10
git status
git diff
```

## GitHub Secrets

Create these repository secrets in GitHub:

- `PROD_SSH_HOST`: server IP address or DNS name.
- `PROD_SSH_USER`: Linux user used for deployment.
- `PROD_SSH_KEY`: private SSH key for that user.

Optional:

- `PROD_SSH_PORT`: SSH port. Defaults to `22`.
- `PROD_APP_DIR`: production checkout directory. Defaults to `/opt/money-flow`.
- `PROD_SSH_KNOWN_HOSTS`: pinned SSH host key output. If omitted, the workflow uses `ssh-keyscan`.

Do not put Telegram, database, OpenAI, or Deepgram secrets in GitHub Actions. They stay on the server in `.env.production`.

## Automatic Release Digest

Every PR with user-visible changes includes this block:

```markdown
## User Release Notes

audience: user
version: v.1.19
category: history

RU:
- В истории расходов появился выбор периода.

EN:
- Expense history now has a period picker.
```

`version` is optional. If it is missing, malformed, stale, or already used,
the sync script assigns the next `v.1.x` version. Use `audience: admin` or
`audience: internal` for changes that must never reach normal users.

After production health and security checks, the workflow resolves the merged
PR associated with the deployed SHA and synchronizes its release block into
PostgreSQL. The API sends pending public notes at the configured local hour.
Release note synchronization is best-effort: if the release block is malformed
or GitHub lookup fails after the application is already healthy, deploy logs a
warning and continues. Fix the PR body and run the sync command manually if the
release note still needs to be published.

Add these values to production `.env.production`:

```env
RELEASE_DIGEST_AUTO_SEND_ENABLED=true
RELEASE_DIGEST_TIMEZONE=Asia/Bangkok
RELEASE_DIGEST_SEND_HOUR=21
RELEASE_DIGEST_CHECK_INTERVAL_MINUTES=15
GITHUB_TOKEN=<read-only GitHub token>
GITHUB_REPOSITORY=Eugenio-Minochkin/money_flow
```

`GITHUB_TOKEN` needs read access to pull requests. It remains on the production
server and is passed only to the API container. The deploy workflow never logs
the token.

## First-Time Server Setup

On your local machine, create a deploy key:

```bash
ssh-keygen -t ed25519 -C "money-flow-github-actions" -f money_flow_deploy_key
```

Copy the public key to the server deploy user:

```bash
ssh <user>@<server>
mkdir -p ~/.ssh
chmod 700 ~/.ssh
cat >> ~/.ssh/authorized_keys
```

Paste the contents of `money_flow_deploy_key.pub`, press Enter, then press Ctrl+D.

Add the private key contents from `money_flow_deploy_key` to GitHub as `PROD_SSH_KEY`.

The server should already have the repository at:

```bash
/opt/money-flow
```

The server directory must contain:

```bash
.env.production
compose.prod.yml
scripts/prod-security-check.sh
```

The deploy user needs permission to run:

```bash
cd /opt/money-flow
git fetch origin --prune --tags
git checkout --force <commit-sha>
docker compose --env-file .env.production -f compose.prod.yml up -d --build
./scripts/prod-security-check.sh
docker compose --env-file .env.production -f compose.prod.yml exec -T api \
  npm run release-notes:sync-pr -- --pr=<pull-request-number>
```

## What Deploy Does

The workflow deploys a specific Git commit:

```bash
cd /opt/money-flow
git fetch origin --prune --tags
git checkout --force "$DEPLOY_REF"
docker compose --env-file .env.production -f compose.prod.yml up -d --build
./scripts/prod-security-check.sh
docker compose --env-file .env.production -f compose.prod.yml exec -T api \
  npm run release-notes:sync-pr -- --pr="$RELEASE_PR_NUMBER"
```

The production database remains in the Docker volume. Application secrets remain in `.env.production`.
The release-note sync step is intentionally non-blocking after health checks:
it should not roll back or fail a healthy application deploy.

## Rollback

Find the previous good commit:

```bash
git log --oneline
```

Open GitHub Actions, choose `CI and Deploy`, click `Run workflow`, and enter the previous commit SHA in the `ref` input. This uses `workflow_dispatch` and runs the same deploy steps against the older commit.

## If Deploy Fails

Check the failed GitHub Actions log first.

Common causes:

- Missing or invalid GitHub SSH secret.
- Deploy user cannot access `/opt/money-flow`.
- Deploy user cannot run Docker.
- `.env.production` is missing on the server.
- `scripts/prod-security-check.sh` detects a failed health check or exposed Postgres port.

If only `release-notes:sync-pr` fails, the application deploy has already
passed health checks. Correct the `## User Release Notes` block in the PR body
and run the release sync command manually if needed.

Manual server check:

```bash
cd /opt/money-flow
docker compose --env-file .env.production -f compose.prod.yml ps
./scripts/prod-security-check.sh
```
