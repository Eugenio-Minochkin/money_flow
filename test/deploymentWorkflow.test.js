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

test('deployment runbook documents secrets, local flow, deploy, and rollback', () => {
  const runbook = readText('docs/deployment-runbook.md');

  assert.match(runbook, /PROD_SSH_HOST/);
  assert.match(runbook, /PROD_SSH_USER/);
  assert.match(runbook, /PROD_SSH_KEY/);
  assert.match(runbook, /npm test/);
  assert.match(runbook, /git commit/);
  assert.match(runbook, /git push origin master/);
  assert.match(runbook, /\/opt\/money-flow/);
  assert.match(runbook, /\.env\.production/);
  assert.match(runbook, /Rollback/i);
  assert.match(runbook, /workflow_dispatch/);
});
