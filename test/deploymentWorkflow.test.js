import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function readText(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('GitHub Actions deploy workflow runs CI, SSH deploy, and production checks', () => {
  const workflow = readText('.github/workflows/deploy.yml');

  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /branches:\s*\[\s*master\s*\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /PROD_SSH_HOST/);
  assert.match(workflow, /PROD_SSH_USER/);
  assert.match(workflow, /PROD_SSH_KEY/);
  assert.match(workflow, /DEPLOY_REF/);
  assert.match(workflow, /git fetch origin --prune --tags/);
  assert.match(workflow, /git checkout --force "\$DEPLOY_REF"/);
  assert.match(workflow, /docker compose --env-file \.env\.production -f compose\.prod\.yml up -d --build/);
  assert.match(workflow, /\.\/scripts\/prod-security-check\.sh/);
});

test('GitHub Actions runs Postgres smoke integration tests against a disposable database', () => {
  const workflow = readText('.github/workflows/deploy.yml');

  assert.match(workflow, /postgres-integration:/);
  assert.match(workflow, /name:\s*Postgres integration smoke/);
  assert.match(workflow, /services:\s+postgres:/);
  assert.match(workflow, /image:\s*postgres:17/);
  assert.match(workflow, /POSTGRES_DB:\s*money_flow_test/);
  assert.match(workflow, /POSTGRES_USER:\s*postgres/);
  assert.match(workflow, /POSTGRES_PASSWORD:\s*postgres/);
  assert.match(workflow, /pg_isready -U postgres -d money_flow_test/);
  assert.match(workflow, /NODE_ENV:\s*test/);
  assert.match(workflow, /DATABASE_URL:\s*postgres:\/\/postgres:postgres@localhost:5432\/money_flow_test/);
  assert.match(workflow, /npm run test:integration:postgres/);
  assert.match(workflow, /needs:\s*\[\s*ci,\s*postgres-integration\s*\]/);
  assert.doesNotMatch(workflow, /secrets\.[A-Z_]*DATABASE/);
});

test('production compose passes configured admin Telegram ids to the API', () => {
  const compose = readText('compose.prod.yml');

  assert.match(compose, /ADMIN_TELEGRAM_IDS:\s*\$\{ADMIN_TELEGRAM_IDS:-\}/);
});

test('production compose passes admin alert settings to the API', () => {
  const compose = readText('compose.prod.yml');

  assert.match(compose, /ADMIN_ALERTS_ENABLED:\s*\$\{ADMIN_ALERTS_ENABLED:-false\}/);
  assert.match(compose, /ADMIN_ALERT_THROTTLE_MS:\s*\$\{ADMIN_ALERT_THROTTLE_MS:-600000\}/);
  assert.match(compose, /ADMIN_ALERT_MAX_MESSAGE_LENGTH:\s*\$\{ADMIN_ALERT_MAX_MESSAGE_LENGTH:-900\}/);
});

test('production deploy resolves a PR and syncs release notes after security checks', () => {
  const workflow = readText('.github/workflows/deploy.yml');
  const restoreTrapIndex = workflow.indexOf('trap restore_release_digest_scheduler EXIT');
  const disabledStartIndex = workflow.indexOf('RELEASE_DIGEST_AUTO_SEND_ENABLED=false');
  const securityCheckIndex = workflow.indexOf('./scripts/prod-security-check.sh');
  const releaseSyncIndex = workflow.indexOf('release-notes:sync-pr');
  const enabledRestartIndex = workflow.lastIndexOf('up -d --force-recreate api');
  const clearTrapIndex = workflow.lastIndexOf('trap - EXIT');

  assert.match(workflow, /commits\/\$\{DEPLOY_SHA\}\/pulls/);
  assert.match(workflow, /select\(\.merged_at != null and \.base\.ref == "master"\)/);
  assert.match(workflow, /RELEASE_PR_NUMBER/);
  assert.match(workflow, /GITHUB_EVENT_NAME/);
  assert.match(workflow, /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
  assert.match(workflow, /RELEASE_SYNC_GITHUB_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
  assert.match(workflow, /RELEASE_SYNC_GITHUB_REPOSITORY:\s*\$\{\{\s*github\.repository\s*\}\}/);
  assert.doesNotMatch(workflow, /RELEASE_SYNC_GITHUB_TOKEN_B64/);
  assert.match(workflow, /mktemp \/tmp\/money-flow-release-sync\.XXXXXX/);
  assert.match(workflow, /printf '%s' "\$RELEASE_SYNC_GITHUB_TOKEN" \| ssh/);
  assert.match(workflow, /umask 077; cat > '\$release_sync_token_file'/);
  assert.match(workflow, /release_sync_github_token="\$\(cat "\$RELEASE_SYNC_TOKEN_FILE"\)"/);
  assert.match(workflow, /rm -f "\$RELEASE_SYNC_TOKEN_FILE"/);
  assert.doesNotMatch(workflow, /-e GITHUB_TOKEN="\$release_sync_github_token"/);
  assert.match(
    workflow,
    /export GITHUB_TOKEN="\$release_sync_github_token"[\s\S]*exec -T\s+[\s\S]*-e GITHUB_TOKEN\s+[\s\S]*-e GITHUB_REPOSITORY\s+[\s\S]*api/
  );
  assert.ok(restoreTrapIndex >= 0);
  assert.ok(disabledStartIndex > restoreTrapIndex);
  assert.ok(disabledStartIndex >= 0);
  assert.ok(securityCheckIndex >= 0);
  assert.ok(releaseSyncIndex > securityCheckIndex);
  assert.ok(enabledRestartIndex > releaseSyncIndex);
  assert.ok(clearTrapIndex > enabledRestartIndex);
  assert.match(
    workflow.slice(enabledRestartIndex),
    /\.\/scripts\/prod-security-check\.sh/
  );
});

test('release note sync warnings do not fail a successful production deploy', () => {
  const workflow = readText('.github/workflows/deploy.yml');
  const releaseSyncIndex = workflow.indexOf('release-notes:sync-pr');
  const releaseSyncWarningIndex = workflow.indexOf('Warning: release note sync failed');
  const releaseSyncBlock = workflow.slice(releaseSyncIndex, releaseSyncWarningIndex);

  assert.ok(releaseSyncIndex >= 0);
  assert.ok(releaseSyncWarningIndex > releaseSyncIndex);
  assert.match(
    workflow,
    /if ! docker compose --env-file \.env\.production -f compose\.prod\.yml exec -T\s+[\s\S]*release-notes:sync-pr -- --pr="\$RELEASE_PR_NUMBER"[\s\S]*then[\s\S]*Warning: release note sync failed/
  );
  assert.doesNotMatch(releaseSyncBlock, /exit 1/);
});

test('production compose passes automatic release digest settings to the API', () => {
  const compose = readText('compose.prod.yml');

  assert.match(compose, /RELEASE_DIGEST_AUTO_SEND_ENABLED:\s*\$\{RELEASE_DIGEST_AUTO_SEND_ENABLED:-false\}/);
  assert.match(compose, /RELEASE_DIGEST_TIMEZONE:\s*\$\{RELEASE_DIGEST_TIMEZONE:-Asia\/Bangkok\}/);
  assert.match(compose, /RELEASE_DIGEST_SEND_HOUR:\s*\$\{RELEASE_DIGEST_SEND_HOUR:-21\}/);
  assert.match(compose, /RELEASE_DIGEST_CHECK_INTERVAL_MINUTES:\s*\$\{RELEASE_DIGEST_CHECK_INTERVAL_MINUTES:-15\}/);
  assert.match(compose, /GITHUB_TOKEN:\s*\$\{GITHUB_TOKEN:-\}/);
  assert.match(compose, /GITHUB_REPOSITORY:\s*\$\{GITHUB_REPOSITORY:-\}/);
});

test('production compose passes rate limiter and trusted proxy settings to the API', () => {
  const compose = readText('compose.prod.yml');

  assert.match(compose, /RATE_LIMIT_WINDOW_MS:\s*\$\{RATE_LIMIT_WINDOW_MS:-60000\}/);
  assert.match(compose, /RATE_LIMIT_MAX_REQUESTS:\s*"\$\{RATE_LIMIT_MAX_REQUESTS:-\$\{RATE_LIMIT_MAX:-120\}\}"/);
  assert.match(compose, /RATE_LIMIT_BUCKET_TTL_MS:\s*\$\{RATE_LIMIT_BUCKET_TTL_MS:-120000\}/);
  assert.match(compose, /RATE_LIMIT_CLEANUP_INTERVAL_MS:\s*\$\{RATE_LIMIT_CLEANUP_INTERVAL_MS:-60000\}/);
  assert.match(compose, /TRUSTED_PROXY_IPS:\s*\$\{TRUSTED_PROXY_IPS:-127\.0\.0\.1,::1,172\.18\.0\.1\}/);
});

test('deployment runbook documents secrets, local flow, deploy, and rollback', () => {
  const runbook = readText('docs/deployment-runbook.md');

  assert.match(runbook, /PROD_SSH_HOST/);
  assert.match(runbook, /PROD_SSH_USER/);
  assert.match(runbook, /PROD_SSH_KEY/);
  assert.match(runbook, /npm test/);
  assert.match(runbook, /git commit/);
  assert.match(runbook, /git checkout -b codex\/<short-change-name>/);
  assert.match(runbook, /git push -u origin codex\/<short-change-name>/);
  assert.match(runbook, /gh pr create --base master/);
  assert.match(runbook, /must not push directly to `master`/);
  assert.match(runbook, /\/opt\/money-flow/);
  assert.match(runbook, /\.env\.production/);
  assert.match(runbook, /Rollback/i);
  assert.match(runbook, /workflow_dispatch/);
  assert.match(runbook, /## User Release Notes/);
  assert.match(runbook, /RELEASE_DIGEST_AUTO_SEND_ENABLED/);
  assert.match(runbook, /GITHUB_REPOSITORY/);
});

test('deployment runbook documents rate limit proxy compatibility settings', () => {
  const runbook = readText('docs/deployment-runbook.md');

  assert.match(runbook, /TRUSTED_PROXY_IPS/);
  assert.match(runbook, /172\.18\.0\.1/);
  assert.match(runbook, /RATE_LIMIT_MAX_REQUESTS/);
  assert.match(runbook, /legacy `RATE_LIMIT_MAX`/);
  assert.match(runbook, /prod-security-check\.sh/);
  assert.match(runbook, /asserts this on every deploy/);
  assert.match(runbook, /gateway[\s\S]*TRUSTED_PROXY_IPS/);
});

test('deployment runbook requires PRs for admin alerts to show a safe sample message', () => {
  const runbook = readText('docs/deployment-runbook.md');

  assert.match(runbook, /admin alerts/i);
  assert.match(runbook, /PR description[\s\S]*example alert/i);
  assert.match(runbook, /test or local run/i);
  assert.match(runbook, /too long/i);
  assert.match(runbook, /sensitive data/i);
});

test('deployment runbook documents admin alert configuration and safety checks', () => {
  const runbook = readText('docs/deployment-runbook.md');

  assert.match(runbook, /Admin Alerts/);
  assert.match(runbook, /ADMIN_ALERTS_ENABLED/);
  assert.match(runbook, /ADMIN_ALERT_THROTTLE_MS/);
  assert.match(runbook, /ADMIN_ALERT_MAX_MESSAGE_LENGTH/);
  assert.match(runbook, /ADMIN_TELEGRAM_IDS/);
  assert.match(runbook, /TELEGRAM_BOT_TOKEN/);
  assert.match(runbook, /tokens[\s\S]*initData[\s\S]*authorization headers[\s\S]*raw request bodies/);
  assert.match(runbook, /backup failure alerts/);
  assert.match(runbook, /sources that file before checking alert settings/);
  assert.match(runbook, /temporary `0600` curl config file/);
});

test('backup script sends safe admin alerts on failure only when enabled', () => {
  const script = readText('scripts/backup-postgres.sh');
  const alertText = script.match(/alert_text="\$\(printf '([\s\S]*?)' /)?.[1] ?? '';
  const envSourceIndex = script.indexOf('. "$ENV_FILE"');
  const alertFunctionIndex = script.indexOf('alert_admin_backup_failure()');

  assert.ok(envSourceIndex >= 0);
  assert.ok(alertFunctionIndex > envSourceIndex);
  assert.match(script, /trap on_backup_exit EXIT/);
  assert.match(script, /ADMIN_ALERTS_ENABLED:-false/);
  assert.match(script, /ADMIN_TELEGRAM_IDS/);
  assert.match(script, /TELEGRAM_BOT_TOKEN/);
  assert.match(script, /source: backup\\njobName: postgres-backup\\noperation: backup-postgres/);
  assert.match(script, /curl -fsS --max-time 5/);
  assert.match(script, /curl_config/);
  assert.doesNotMatch(script, /https:\/\/api\.telegram\.org\/bot\$\{TELEGRAM_BOT_TOKEN\}\/sendMessage/);
  assert.doesNotMatch(alertText, /TOKEN|PASSWORD|SECRET|DATABASE_URL|AWS_|POSTGRES_/);
});

test('prod-security-check verifies the Docker compose gateway is trusted by the rate limiter', () => {
  const script = readText('scripts/prod-security-check.sh');

  // resolves the running api container
  assert.match(script, /docker compose --env-file \.env\.production -f compose\.prod\.yml ps -q api/);
  // resolves the api container's Docker network via read-only inspect
  assert.match(script, /docker inspect[\s\S]*NetworkSettings\.Networks/);
  // resolves the compose network gateway via read-only network inspect
  assert.match(script, /docker network inspect[\s\S]*IPAM/);
  assert.match(script, /\.Gateway/);
  // reads the trusted proxy list sourced from .env.production
  assert.match(script, /TRUSTED_PROXY_IPS/);
  // fails with a clear, actionable message when the gateway is not trusted
  assert.match(script, /does not include the Docker compose gateway/);
  assert.match(script, /add it to TRUSTED_PROXY_IPS in \.env\.production/);
  assert.match(script, /exit 1/);
});

test('prod-security-check fails when the compose gateway cannot be determined', () => {
  const script = readText('scripts/prod-security-check.sh');

  assert.match(script, /Could not determine the gateway[\s\S]*exit 1/);
  assert.match(script, /Could not resolve the api container[\s\S]*exit 1/);
});

test('deployment runbook documents start-of-task git sync preflight', () => {
  const runbook = readText('docs/deployment-runbook.md');

  assert.match(runbook, /git fetch origin --prune/);
  assert.match(runbook, /git switch master/);
  assert.match(runbook, /git pull --ff-only origin master/);
  assert.match(runbook, /git status -sb/);
  assert.match(runbook, /diverged branch/);
  assert.match(runbook, /stop and ask the user/);
});

test('production compose enables strict Telegram Mini App auth', () => {
  const compose = readText('compose.prod.yml');

  assert.match(compose, /NODE_ENV:\s*production/);
  assert.match(compose, /TELEGRAM_WEBHOOK_SECRET:\s*\$\{TELEGRAM_WEBHOOK_SECRET:\?TELEGRAM_WEBHOOK_SECRET is required\}/);
  assert.match(compose, /REQUIRE_TELEGRAM_INIT_DATA:\s*\$\{REQUIRE_TELEGRAM_INIT_DATA:-true\}/);
});

test('production env example documents required Telegram security settings', () => {
  const envExample = readText('.env.production.example');

  assert.match(envExample, /TELEGRAM_WEBHOOK_SECRET=replace_with_long_random_secret/);
  assert.match(envExample, /REQUIRE_TELEGRAM_INIT_DATA=true/);
});

test('production env example documents admin alert settings', () => {
  const envExample = readText('.env.production.example');

  assert.match(envExample, /ADMIN_ALERTS_ENABLED=false/);
  assert.match(envExample, /ADMIN_ALERT_THROTTLE_MS=600000/);
  assert.match(envExample, /ADMIN_ALERT_MAX_MESSAGE_LENGTH=900/);
});

test('production env example does not contain duplicate keys', () => {
  const envExample = readText('.env.production.example');
  const keys = envExample
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('=', 1)[0]);
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);

  assert.deepEqual(duplicates, []);
});

test('api Dockerfile runs as a non-root user and exposes a healthcheck', () => {
  const dockerfile = readText('Dockerfile');

  assert.match(dockerfile, /^USER\s+\S+/m);
  assert.doesNotMatch(dockerfile, /^USER\s+root\b/m);
  assert.doesNotMatch(dockerfile, /^USER\s+0\b/m);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*\/health/);
});

test('production api waits for a healthy postgres before starting', () => {
  const compose = readText('compose.prod.yml');

  assert.match(compose, /depends_on:\s+postgres:\s+condition:\s*service_healthy/);
});

test('production postgres healthcheck uses pg_isready without hardcoded credentials', () => {
  const compose = readText('compose.prod.yml');

  assert.match(compose, /\bpg_isready\b/);
  const pgIsreadyLine = compose.match(/pg_isready[^\n]*/)[0];
  assert.match(pgIsreadyLine, /\$\$\{POSTGRES_USER\}/);
  assert.match(pgIsreadyLine, /\$\$\{POSTGRES_DB\}/);
  assert.doesNotMatch(pgIsreadyLine, /POSTGRES_PASSWORD|password/i);
});
