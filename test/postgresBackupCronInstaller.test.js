import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const installerPath = new URL('../scripts/install-postgres-backup-cron.sh', import.meta.url);

test('Postgres backup cron installer is committed with an idempotent check mode', () => {
  assert.ok(existsSync(installerPath), 'expected committed Postgres backup cron installer');

  const installer = readFileSync(installerPath, 'utf8');
  assert.match(installer, /EUID.*0/);
  assert.match(installer, /--check/);
  assert.match(installer, /\/etc\/cron\.d\/money-flow-backup/);
  assert.match(installer, /APP_DIR=.*\/opt\/money-flow/);
  assert.match(installer, /SHELL=\/bin\/bash/);
  assert.match(installer, /PATH=.*\/usr\/bin/);
  assert.match(installer, /15 2 \* \* \* root cd \$APP_DIR/);
  assert.match(installer, /ENV_FILE=\$APP_DIR\/\.env\.production/);
  assert.match(installer, /COMPOSE_FILE=\$APP_DIR\/compose\.prod\.yml/);
  assert.match(installer, /BACKUP_DIR=\$APP_DIR\/backups\/postgres/);
  assert.match(installer, /\$APP_DIR\/scripts\/backup-postgres\.sh/);
  assert.match(installer, />> \$APP_DIR\/logs\/postgres-backup\.log 2>&1/);
  assert.match(installer, /chmod 0644/);
  assert.match(installer, /legacy.*backup-postgres\.sh/i);
});
