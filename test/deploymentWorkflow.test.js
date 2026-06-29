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

test('production compose passes configured admin Telegram ids to the API', () => {
  const compose = readText('compose.prod.yml');

  assert.match(compose, /ADMIN_TELEGRAM_IDS:\s*\$\{ADMIN_TELEGRAM_IDS:-\}/);
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

test('production compose enables strict Telegram Mini App auth', () => {
  const compose = readText('compose.prod.yml');

  assert.match(compose, /NODE_ENV:\s*production/);
  assert.match(compose, /TELEGRAM_WEBHOOK_SECRET:\s*\$\{TELEGRAM_WEBHOOK_SECRET\}/);
  assert.match(compose, /REQUIRE_TELEGRAM_INIT_DATA:\s*\$\{REQUIRE_TELEGRAM_INIT_DATA:-true\}/);
});

test('production env example documents required Telegram security settings', () => {
  const envExample = readText('.env.production.example');

  assert.match(envExample, /TELEGRAM_WEBHOOK_SECRET=replace_with_long_random_secret/);
  assert.match(envExample, /REQUIRE_TELEGRAM_INIT_DATA=true/);
});
