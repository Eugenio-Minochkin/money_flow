import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function readText(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('production deploy embeds and verifies the exact Git revision', () => {
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
  assert.match(workflow, /build --pull --no-cache api/);
  assert.match(workflow, /function verify_api_revision|verify_api_revision\(\)/);
  assert.match(workflow, /exec -T api cat \/app\/REVISION/);
  assert.match(workflow, /API revision mismatch/);
  assert.ok((workflow.match(/verify_api_revision/g) ?? []).length >= 3);
});

test('failed pre-start builds do not recreate the API before the scheduler was disabled', () => {
  const workflow = readText('.github/workflows/deploy.yml');

  assert.match(workflow, /release_digest_scheduler_disabled=0/);
  assert.match(
    workflow,
    /if \[ "\$release_digest_scheduler_disabled" -eq 1 \]; then[\s\S]*up -d --force-recreate api/
  );
  assert.match(
    workflow,
    /RELEASE_DIGEST_AUTO_SEND_ENABLED=false[\s\S]*up -d --build --no-deps --force-recreate api[\s\S]*release_digest_scheduler_disabled=1/
  );
});
