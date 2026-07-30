import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const bash = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash';
const runtimeSkip = process.platform === 'win32'
  ? 'requires POSIX child processes; covered by the Ubuntu CI job'
  : false;

function writeExecutable(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  chmodSync(path, 0o755);
}

function makeSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'money-flow-backup-test-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, bin };
}

function runScript(script, { args = [], cwd = repoRoot, env = {} } = {}) {
  const command = process.platform === 'win32'
    ? [process.env.ComSpec, ['/d', '/s', '/c', `"${bash}" "${script}" ${args.map((arg) => `"${arg}"`).join(' ')}`]]
    : [bash, [script, ...args]];
  const result = spawnSync(command[0], command[1], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  return result;
}

function backupDockerStub(bin) {
  writeExecutable(join(bin, 'docker'), `#!/usr/bin/env bash
set -u
args="$*"
printf '%s\\n' "$args" >> "$DOCKER_LOG"
if [[ "$args" == *" pg_dump "* ]]; then
  printf 'custom dump'
  exit 0
fi
if [[ "$args" == *" cp "* ]]; then
  : > "$CONTAINER_CP_MARKER"
if [ "\${TERM_ON_CP:-false}" = "true" ]; then
    kill -TERM "$PPID"
  fi
exit "\${DOCKER_CP_EXIT:-0}"
fi
if [[ "$args" == *" pg_restore "* ]]; then
exit "\${PG_RESTORE_EXIT:-0}"
fi
if [[ "$args" == *" rm -f /tmp/money-flow-backup-validate-"* ]]; then
  : > "$CONTAINER_RM_MARKER"
fi
`);
  writeExecutable(join(bin, 'aws'), `#!/usr/bin/env bash
: > "$AWS_MARKER"
`);
}

function backupEnv(sandbox, backupDir, extra = {}) {
  return {
    PATH: `${sandbox.bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
    BACKUP_DIR: backupDir,
    COMPOSE_FILE: join(sandbox.root, 'compose.yml'),
    BACKUP_RETENTION_DAYS: '1',
    DOCKER_LOG: join(sandbox.root, 'docker.log'),
    CONTAINER_CP_MARKER: join(sandbox.root, 'container-cp'),
    CONTAINER_RM_MARKER: join(sandbox.root, 'container-rm'),
    AWS_MARKER: join(sandbox.root, 'aws-called'),
    ...extra,
  };
}

test('backup runtime publishes only a validated 0600 final dump and cleans temporary artifacts', { skip: runtimeSkip }, (t) => {
  const sandbox = makeSandbox(t);
  const backupDir = join(sandbox.root, 'backups');
  backupDockerStub(sandbox.bin);

  const result = runScript('scripts/backup-postgres.sh', {
    env: backupEnv(sandbox, backupDir),
  });

  assert.equal(result.status, 0, result.stderr);
  const dumps = readFileSync(join(sandbox.root, 'docker.log'), 'utf8');
  assert.match(dumps, /pg_dump/);
  assert.match(dumps, /pg_restore/);
  const [finalName] = readdirSync(backupDir).filter((name) => name.endsWith('.dump'));
  const finalDump = readFileSync(join(backupDir, finalName), 'utf8');
  assert.equal(finalDump, 'custom dump');
  assert.equal(statSync(join(backupDir, finalName)).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(backupDir).filter((name) => name.includes('.tmp.')), []);
  assert.equal(existsSync(join(sandbox.root, 'container-rm')), true);
  assert.equal(existsSync(join(sandbox.root, 'aws-called')), false);
});

test('backup runtime cleans host and container temporaries when validation or copy fails', { skip: runtimeSkip }, (t) => {
  const sandbox = makeSandbox(t);
  const backupDir = join(sandbox.root, 'backups');
  backupDockerStub(sandbox.bin);
  mkdirSync(backupDir, { recursive: true });
  const oldDump = join(backupDir, 'moneyflow-postgres-old.dump');
  writeFileSync(oldDump, 'keep');
  utimesSync(oldDump, new Date(0), new Date(0));

  const result = runScript('scripts/backup-postgres.sh', {
    env: backupEnv(sandbox, backupDir, {
      PG_RESTORE_EXIT: '17',
      BACKUP_REMOTE_ENABLED: 'true',
      BACKUP_S3_BUCKET: 'test-bucket',
    }),
  });

  assert.notEqual(result.status, 0);
  assert.equal(existsSync(oldDump), true);
  assert.equal(existsSync(join(sandbox.root, 'aws-called')), false);
  assert.equal(existsSync(join(sandbox.root, 'container-rm')), true);
  assert.deepEqual(readdirSync(backupDir).filter((name) => name.includes('.tmp.')), []);
  assert.deepEqual(readdirSync(backupDir).filter((name) => name.endsWith('.dump')), ['moneyflow-postgres-old.dump']);

  const copyFailure = runScript('scripts/backup-postgres.sh', {
    env: backupEnv(sandbox, backupDir, { DOCKER_CP_EXIT: '12' }),
  });
  assert.notEqual(copyFailure.status, 0);
  assert.equal(existsSync(join(sandbox.root, 'container-rm')), true);
  assert.deepEqual(readdirSync(backupDir).filter((name) => name.includes('.tmp.')), []);
});

test('backup runtime cleanup trap runs after an interrupt during container copy', { skip: runtimeSkip }, (t) => {
  const sandbox = makeSandbox(t);
  const backupDir = join(sandbox.root, 'backups');
  backupDockerStub(sandbox.bin);

  const result = runScript('scripts/backup-postgres.sh', {
    env: backupEnv(sandbox, backupDir, { TERM_ON_CP: 'true' }),
  });

  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(sandbox.root, 'container-rm')), true);
  assert.deepEqual(readdirSync(backupDir).filter((name) => name.includes('.tmp.')), []);
});

function securityStubs(sandbox) {
  writeExecutable(join(sandbox.bin, 'curl'), `#!/usr/bin/env bash
set -u
args="$*"
out=""
for ((i = 1; i <= $#; i++)); do
  if [ "\${!i}" = "-o" ]; then
    next=$((i + 1)); out="\${!next}"
  fi
done
if [[ "$args" == *"/health"* ]]; then printf '{"ok":true,"db":true}'; exit 0; fi
if [[ "$args" == *"dashboard"* ]]; then printf '{"telegram_init_data_required"}' > "$out"; printf '400'; exit 0; fi
printf '{"invalid_webhook_secret"}' > "$out"; printf '401'
`);
  writeExecutable(join(sandbox.bin, 'ss'), '#!/usr/bin/env bash\nexit 1\n');
  writeExecutable(join(sandbox.bin, 'docker'), `#!/usr/bin/env bash
set -u
args="$*"
if [[ "$args" == *" ps -q api"* ]]; then echo api-container; exit 0; fi
if [[ "$args" == inspect* ]]; then echo money-flow-network; exit 0; fi
if [[ "$args" == network\ inspect* ]]; then echo 172.18.0.1; exit 0; fi
if [[ "$args" == *" cp "* ]]; then
  printf '%s\\n' "$args" > "$SECURITY_CP_LOG"
  : > "$SECURITY_CP_MARKER"
  exit "\${SECURITY_CP_EXIT:-0}"
fi
if [[ "$args" == *" pg_restore "* ]]; then exit "\${SECURITY_PG_RESTORE_EXIT:-0}"; fi
if [[ "$args" == *" rm -f /tmp/money-flow-seccheck-backup-"* ]]; then : > "$SECURITY_RM_MARKER"; fi
`);
}

function securityEnv(sandbox, appDir, backupDir, extra = {}) {
  writeFileSync(join(appDir, '.env.production'), 'REQUIRE_TELEGRAM_INIT_DATA=true\nTELEGRAM_WEBHOOK_SECRET=test\nTRUSTED_PROXY_IPS=172.18.0.1\n');
  return {
    PATH: `${sandbox.bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
    APP_DIR: appDir,
    BACKUP_DIR: backupDir,
    SECURITY_CP_LOG: join(sandbox.root, 'security-cp.log'),
    SECURITY_CP_MARKER: join(sandbox.root, 'security-cp'),
    SECURITY_RM_MARKER: join(sandbox.root, 'security-rm'),
    ...extra,
  };
}

test('security check chooses newest mtime with a stable filename tie-break and cleans its container copy', { skip: runtimeSkip }, (t) => {
  const sandbox = makeSandbox(t);
  const appDir = join(sandbox.root, 'app');
  const backupDir = join(sandbox.root, 'backups');
  mkdirSync(appDir); mkdirSync(backupDir);
  securityStubs(sandbox);
  const older = join(backupDir, 'moneyflow-postgres-a.dump');
  const expected = join(backupDir, 'moneyflow-postgres-z.dump');
  writeFileSync(older, 'old'); writeFileSync(expected, 'new');
  const sameTime = new Date('2026-07-30T00:00:00Z');
  utimesSync(older, sameTime, sameTime); utimesSync(expected, sameTime, sameTime);

  const result = runScript('scripts/prod-security-check.sh', {
    env: securityEnv(sandbox, appDir, backupDir),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(sandbox.root, 'security-cp.log'), 'utf8'), /moneyflow-postgres-z\.dump/);
  assert.equal(existsSync(join(sandbox.root, 'security-rm')), true);
});

test('security check reports missing stale and corrupt backups separately and cleans after copy failure', { skip: runtimeSkip }, (t) => {
  const sandbox = makeSandbox(t);
  const appDir = join(sandbox.root, 'app');
  const backupDir = join(sandbox.root, 'backups');
  mkdirSync(appDir); mkdirSync(backupDir);
  securityStubs(sandbox);

  let result = runScript('scripts/prod-security-check.sh', { env: securityEnv(sandbox, appDir, backupDir) });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /No Postgres backup files/);

  const dump = join(backupDir, 'moneyflow-postgres-test.dump');
  writeFileSync(dump, 'dump'); utimesSync(dump, new Date(0), new Date(0));
  result = runScript('scripts/prod-security-check.sh', { env: securityEnv(sandbox, appDir, backupDir) });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Newest Postgres backup is stale/);

  utimesSync(dump, new Date(), new Date());
  result = runScript('scripts/prod-security-check.sh', {
    env: securityEnv(sandbox, appDir, backupDir, { SECURITY_PG_RESTORE_EXIT: '13' }),
  });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Newest backup is not a valid pg_restore archive/);

  result = runScript('scripts/prod-security-check.sh', {
    env: securityEnv(sandbox, appDir, backupDir, { SECURITY_CP_EXIT: '12' }),
  });
  assert.notEqual(result.status, 0); assert.equal(existsSync(join(sandbox.root, 'security-rm')), true);
});

test('cron installer is idempotent, check is read-only, and legacy paths are rejected', { skip: runtimeSkip }, (t) => {
  const sandbox = makeSandbox(t);
  const appDir = join(sandbox.root, 'app');
  const cronFile = join(sandbox.root, 'money-flow-backup');
  const env = { APP_DIR: appDir, CRON_FILE: cronFile };

  let result = runScript('scripts/install-postgres-backup-cron.sh', { env });
  assert.equal(result.status, 0, result.stderr);
  const first = readFileSync(cronFile, 'utf8');
  assert.equal(statSync(cronFile).mode & 0o777, 0o644);
  result = runScript('scripts/install-postgres-backup-cron.sh', { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(cronFile, 'utf8'), first);
  const beforeCheckMtime = statSync(cronFile).mtimeMs;
  result = runScript('scripts/install-postgres-backup-cron.sh', { args: ['--check'], env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(cronFile, 'utf8'), first);
  assert.equal(statSync(cronFile).mtimeMs, beforeCheckMtime);
  writeFileSync(cronFile, first.replace(`${appDir}/scripts/backup-postgres.sh`, '/opt/money-flow/backup-postgres.sh'));
  result = runScript('scripts/install-postgres-backup-cron.sh', { args: ['--check'], env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /legacy backup-postgres\.sh path/);
});
