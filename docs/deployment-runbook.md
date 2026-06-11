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
```

## What Deploy Does

The workflow deploys a specific Git commit:

```bash
cd /opt/money-flow
git fetch origin --prune --tags
git checkout --force "$DEPLOY_REF"
docker compose --env-file .env.production -f compose.prod.yml up -d --build
./scripts/prod-security-check.sh
```

The production database remains in the Docker volume. Application secrets remain in `.env.production`.

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

Manual server check:

```bash
cd /opt/money-flow
docker compose --env-file .env.production -f compose.prod.yml ps
./scripts/prod-security-check.sh
```
