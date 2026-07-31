import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

function readText(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function extractShellFunction(source, name) {
  const match = source.match(
    new RegExp(`^ {10}${name}\\(\\) \\{\\r?\\n[\\s\\S]*?^ {10}\\}\\r?$`, 'm')
  );
  assert.ok(match, `expected ${name} shell function`);
  return match[0].replace(/^ {10}/gm, '');
}

function bashExecutable() {
  if (process.platform !== 'win32') {
    return 'bash';
  }

  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const gitBash = `${programFiles}\\Git\\bin\\bash.exe`;
  assert.ok(existsSync(gitBash), `Git Bash not found at ${gitBash}`);
  return gitBash;
}

function runDeploymentVerification({
  mode,
  appRevision = 'revision-123',
  actualRevision = 'revision-123',
  builtImageId = 'sha256:fresh',
  runningImageId = 'sha256:fresh',
  markerReadFails = false,
}) {
  const workflow = readText('.github/workflows/deploy.yml');
  const verifyFunction = extractShellFunction(workflow, 'verify_api_deployment');
  const script = `
set -euo pipefail

${verifyFunction}

docker() {
  if [ "$1" = compose ]; then
    case " $* " in
      *" ps -q api "*)
        printf '%s\\n' api-container
        ;;
      *" exec -T api cat /app/REVISION "*)
        if [ "$FAKE_MARKER_READ_FAILS" = 1 ]; then
          printf '%s\\n' 'marker read failed' >&2
          return 1
        fi
        printf '%s\\n' "$FAKE_ACTUAL_REVISION"
        ;;
      *)
        printf 'unexpected docker compose command: %s\\n' "$*" >&2
        return 97
        ;;
    esac
    return 0
  fi

  if [ "$1" = inspect ]; then
    printf '%s\\n' "$FAKE_RUNNING_IMAGE_ID"
    return 0
  fi

  printf 'unexpected docker command: %s\\n' "$*" >&2
  return 98
}

APP_REVISION="$FAKE_APP_REVISION"
built_api_image_id="$FAKE_BUILT_IMAGE_ID"
revision_check_mode="$FAKE_MODE"
verify_api_deployment
`;
  const result = spawnSync(bashExecutable(), ['-s'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FAKE_MODE: mode,
      FAKE_APP_REVISION: appRevision,
      FAKE_ACTUAL_REVISION: actualRevision,
      FAKE_BUILT_IMAGE_ID: builtImageId,
      FAKE_RUNNING_IMAGE_ID: runningImageId,
      FAKE_MARKER_READ_FAILS: markerReadFails ? '1' : '0',
    },
    input: script,
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test('exact revision mode succeeds only for the freshly built matching revision', () => {
  const result = runDeploymentVerification({ mode: 'exact_revision' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verification mode: exact revision \(revision-123\)/);
});

test('exact revision mode fails for a wrong or unreadable revision marker', () => {
  const mismatch = runDeploymentVerification({
    mode: 'exact_revision',
    actualRevision: 'revision-other',
  });
  const missing = runDeploymentVerification({
    mode: 'exact_revision',
    markerReadFails: true,
  });

  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /API revision mismatch/);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /API revision marker is required/);
});

test('legacy rollback mode succeeds for the freshly built image without reading the marker', () => {
  const result = runDeploymentVerification({
    mode: 'legacy_rollback',
    markerReadFails: true,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verification mode: legacy rollback/);
  assert.doesNotMatch(result.stderr, /marker read failed/);
});

test('legacy rollback mode fails when the running image ID does not match the build', () => {
  const result = runDeploymentVerification({
    mode: 'legacy_rollback',
    runningImageId: 'sha256:stale',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /API image ID mismatch/);
});

test('production deploy embeds and strictly verifies the exact Git revision', () => {
  const dockerfile = readText('Dockerfile');
  const compose = readText('compose.prod.yml');
  const workflow = readText('.github/workflows/deploy.yml');

  assert.match(dockerfile, /ARG APP_REVISION=unknown/);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision="\$APP_REVISION"/);
  assert.match(dockerfile, /printf '%s\\n' "\$APP_REVISION" > \/app\/REVISION/);

  assert.match(compose, /image:\s*money-flow-api:production/);
  assert.match(compose, /APP_REVISION:\s*\$\{APP_REVISION:-unknown\}/);

  assert.match(workflow, /APP_REVISION="\$\(git rev-parse HEAD\)"/);
  assert.match(workflow, /export APP_REVISION/);
  assert.match(
    workflow,
    /git grep -Fq '\/app\/REVISION' HEAD -- Dockerfile[\s\S]*revision_check_mode=exact_revision[\s\S]*revision_check_mode=legacy_rollback/
  );
  assert.match(workflow, /build --pull --no-cache api/);
  assert.match(workflow, /verify_api_deployment\(\)/);
  assert.match(
    workflow,
    /if \[ "\$revision_check_mode" = exact_revision \]; then[\s\S]*api cat \/app\/REVISION/
  );
  assert.match(
    workflow,
    /if \[ "\$actual_revision" != "\$APP_REVISION" \]; then[\s\S]*API revision mismatch[\s\S]*return 1/
  );
  assert.match(workflow, /Verification mode: exact revision/);
  assert.doesNotMatch(workflow, /cat \/app\/REVISION\s*\|\|\s*true/);
  assert.ok((workflow.match(/verify_api_deployment/g) ?? []).length >= 3);
});

test('production deploy keeps its remote script intact and verifies public revision plus webhook', () => {
  const workflow = readText('.github/workflows/deploy.yml');

  assert.match(
    workflow,
    /BACKUP_DIR="\$APP_DIR\/backups\/postgres"[\s\\]+"\$APP_DIR\/scripts\/backup-postgres\.sh" <\/dev\/null/
  );
  assert.match(workflow, /verify_public_api_revision\(\)/);
  assert.match(workflow, /https:\/\/\$\{APP_DOMAIN\}\/health/);
  assert.match(workflow, /Public API revision mismatch/);
  assert.match(workflow, /verify_telegram_webhook\(\)/);
  assert.match(workflow, /https:\/\/\$\{APP_DOMAIN\}\/telegram\/webhook/);
  assert.match(workflow, /Telegram webhook URL mismatch/);
  assert.match(workflow, /curl -fsS --config "\$webhook_curl_config"/);
  assert.doesNotMatch(workflow, /api\.telegram\.org\/bot\$\{?TELEGRAM_BOT_TOKEN\}?\/getWebhookInfo/);
});

test('legacy rollback verifies the recreated container uses the freshly built image', () => {
  const workflow = readText('.github/workflows/deploy.yml');

  assert.match(
    workflow,
    /compose_project_name="\$\([\s\S]*awk '\$1 == "name:" \{ print \$2; exit \}'[\s\S]*\)"/
  );
  assert.match(
    workflow,
    /if \[ -z "\$api_image_name" \]; then[\s\S]*api_image_name="\$\{compose_project_name\}-api"/
  );
  assert.match(
    workflow,
    /build --pull --no-cache api[\s\S]*built_api_image_id="\$\([\s\S]*docker image inspect[\s\S]*\)"/
  );
  assert.match(
    workflow,
    /running_api_image_id="\$\(docker inspect --format '\{\{\.Image\}\}' "\$api_container_id"\)"/
  );
  assert.match(
    workflow,
    /if \[ "\$running_api_image_id" != "\$built_api_image_id" \]; then[\s\S]*API image ID mismatch[\s\S]*return 1/
  );
  assert.match(workflow, /Verification mode: legacy rollback/);
});

test('deploy recreates from the saved image without rebuilding between build and verification', () => {
  const workflow = readText('.github/workflows/deploy.yml');

  assert.match(
    workflow,
    /build --pull --no-cache api[\s\S]*built_api_image_id=[\s\S]*release_digest_scheduler_disabled=1[\s\S]*up -d --no-deps --force-recreate api[\s\S]*verify_api_deployment/
  );
  assert.doesNotMatch(
    workflow,
    /built_api_image_id=[\s\S]*up -d --build --no-deps --force-recreate api/
  );
});

test('deployment runbook documents exact and backward-compatible rollback verification', () => {
  const runbook = readText('docs/deployment-runbook.md');

  assert.match(runbook, /Verification mode: exact revision/);
  assert.match(runbook, /Verification mode: legacy rollback/);
  assert.match(
    runbook,
    /legacy path only when the target commit's[\s\S]*Dockerfile[\s\S]*does not contain the `\/app\/REVISION` mechanism/
  );
  assert.match(
    runbook,
    /image-ID mismatch fails the[\s\S]*rollback[\s\S]*absence of `\/app\/REVISION` is never ignored/
  );
});

test('failed image builds do not recreate the API, while partial starts restore the scheduler', () => {
  const workflow = readText('.github/workflows/deploy.yml');

  assert.match(workflow, /release_digest_scheduler_disabled=0/);
  assert.match(
    workflow,
    /if \[ "\$release_digest_scheduler_disabled" -eq 1 \]; then[\s\S]*up -d --force-recreate api/
  );
  assert.match(
    workflow,
    /build --pull --no-cache api[\s\S]*built_api_image_id=[\s\S]*release_digest_scheduler_disabled=1[\s\S]*RELEASE_DIGEST_AUTO_SEND_ENABLED=false[\s\S]*up -d --no-deps --force-recreate api/
  );
});
