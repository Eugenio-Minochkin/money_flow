import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { migrate, runWithRetry, listMigrationFiles } from "../src/db.js";

test("retries transient startup failures before succeeding", async () => {
  let attempts = 0;

  const result = await runWithRetry(async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error("not ready");
      error.code = "ECONNREFUSED";
      throw error;
    }
    return "ready";
  }, { retries: 3, delayMs: 1 });

  assert.equal(result, "ready");
  assert.equal(attempts, 3);
});

test("migration files are listed in lexical order and include the Telegram editor prompt migration", async () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const files = await listMigrationFiles(dir);
  assert.ok(files.includes("001_initial.sql"));
  assert.ok(files.includes("002_draft_confirm_flow.sql"));
  assert.ok(files.includes("008_product_analytics.sql"));
  assert.ok(files.includes("014_quick_access_tokens.sql"));
  assert.ok(files.includes("015_quick_capture_safety.sql"));
  assert.ok(files.includes("016_quick_access_token_single_active.sql"));
  assert.ok(files.includes("017_telegram_expense_capture_safety.sql"));
  assert.ok(files.includes("010_telegram_editor_prompt_message.sql"));
  assert.deepEqual(files, [...files].sort());
});

test("Telegram capture safety migration adds durable chat and message claims", async () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const sql = await readFile(resolve(dir, "017_telegram_expense_capture_safety.sql"), "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS telegram_expense_captures/i);
  assert.match(sql, /UNIQUE\(user_id, chat_id, message_id\)/i);
  assert.match(sql, /status TEXT NOT NULL CHECK \(status IN \('processing', 'completed'\)\)/i);
  assert.match(sql, /draft_id BIGINT REFERENCES drafts\(id\)/i);
});

test("Telegram capture inbox migration retains restart-resumable work", async () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const sql = await readFile(resolve(dir, "022_telegram_capture_inbox.sql"), "utf8");

  assert.match(sql, /ALTER TABLE telegram_expense_captures/i);
  assert.match(sql, /payload JSONB/i);
  assert.match(sql, /last_error_code TEXT/i);
  assert.match(sql, /attempt_count INTEGER NOT NULL DEFAULT 0/i);
  assert.match(sql, /WHERE status = 'processing'/i);
});

test("Telegram capture terminal-failure migration preserves a durable failed state", async () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const sql = await readFile(resolve(dir, "023_telegram_capture_terminal_failures.sql"), "utf8");

  assert.match(sql, /DROP CONSTRAINT IF EXISTS telegram_expense_captures_status_check/i);
  assert.match(sql, /status IN \('processing', 'completed', 'failed'\)/i);
});

test("Quick Capture safety migration adds durable claims and inactive prepared keys", async () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const sql = await readFile(resolve(dir, "015_quick_capture_safety.sql"), "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS quick_capture_requests/i);
  assert.match(sql, /UNIQUE\(user_id, client_request_id\)/i);
  assert.match(sql, /status TEXT NOT NULL CHECK \(status IN \('processing', 'completed'\)\)/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS prepared_expires_at TIMESTAMPTZ/i);
  assert.match(sql, /SET activated_at = created_at/i);
});

test("Telegram editor prompt migration adds a nullable prompt message reference", async () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const sql = await readFile(resolve(dir, "010_telegram_editor_prompt_message.sql"), "utf8");

  assert.match(sql, /ALTER TABLE\s+telegram_input_sessions\s+ADD COLUMN IF NOT EXISTS prompt_message_id BIGINT/i);
  assert.doesNotMatch(sql, /NOT NULL/i);
});

test("budget top-up migration creates drafts, topups, idempotency index, and explicit FX source", async () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const sql = await readFile(resolve(dir, "003_budget_topups.sql"), "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS budget_topup_drafts/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS budget_topups/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS budget_topup_drafts_one_pending_per_user/i);
  assert.match(sql, /ON budget_topup_drafts\(user_id\)/i);
  assert.match(sql, /WHERE status = 'pending'/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS budget_topups_user_draft_unique/i);
  assert.match(sql, /WHERE draft_id IS NOT NULL/i);
  assert.match(sql, /exchange_rate_source TEXT NOT NULL[,)]/i);
  assert.doesNotMatch(sql, /exchange_rate_source TEXT NOT NULL DEFAULT/i);
});

test("report delivery migration creates universal delivery ledger", async () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const sql = await readFile(resolve(dir, "004_report_deliveries.sql"), "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS report_deliveries/i);
  assert.match(sql, /report_type TEXT NOT NULL CHECK \(report_type IN \('weekly', 'monthly'\)\)/i);
  assert.match(sql, /status TEXT NOT NULL CHECK \(status IN \('pending', 'sent', 'failed', 'skipped'\)\)/i);
  assert.match(sql, /UNIQUE\(user_id, report_type, period_key\)/i);
});

test("exchange rate migration creates persistent pair-date cache", async () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const sql = await readFile(resolve(dir, "005_exchange_rates.sql"), "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS exchange_rates/i);
  assert.match(sql, /rate_date DATE NOT NULL/i);
  assert.match(sql, /base_currency TEXT NOT NULL/i);
  assert.match(sql, /quote_currency TEXT NOT NULL/i);
  assert.match(sql, /rate NUMERIC\(18,\s*8\) NOT NULL/i);
  assert.match(sql, /provider TEXT NOT NULL/i);
  assert.match(sql, /UNIQUE\(rate_date, base_currency, quote_currency\)/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS exchange_rates_pair_date_idx/i);
});

test("feedback migration creates feedback capture table", async () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const sql = await readFile(resolve(dir, "006_feedback.sql"), "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS feedback/i);
  assert.match(sql, /id BIGSERIAL PRIMARY KEY/i);
  assert.match(sql, /user_id BIGINT REFERENCES users\(id\) ON DELETE SET NULL/i);
  assert.match(sql, /telegram_user_id BIGINT NOT NULL/i);
  assert.match(sql, /message TEXT NOT NULL/i);
  assert.match(sql, /created_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/i);
  assert.match(sql, /status TEXT NOT NULL DEFAULT 'new'/i);
  assert.match(sql, /source TEXT NOT NULL DEFAULT 'bot'/i);
  assert.match(sql, /CHECK \(status IN \('new', 'reviewed', 'archived'\)\)/i);
  assert.match(sql, /CHECK \(source IN \('bot', 'miniapp'\)\)/i);
  assert.match(sql, /CHECK \(length\(btrim\(message\)\) >= 3\)/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS feedback_status_created_at_idx/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS feedback_telegram_user_created_at_idx/i);
});

test("account deletion migration creates request table and indexes", async () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const sql = await readFile(resolve(dir, "007_account_deletion.sql"), "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS account_deletion_requests/i);
  assert.match(sql, /id BIGSERIAL PRIMARY KEY/i);
  assert.match(sql, /user_id BIGINT NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /source TEXT NOT NULL CHECK \(source IN \('telegram', 'miniapp'\)\)/i);
  assert.match(sql, /stage TEXT NOT NULL CHECK \(stage IN \('requested', 'awaiting_text'\)\)/i);
  assert.match(sql, /status TEXT NOT NULL CHECK \(status IN \('pending', 'cancelled', 'expired'\)\)/i);
  assert.match(sql, /expires_at TIMESTAMPTZ NOT NULL/i);
  assert.match(sql, /created_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/i);
  assert.match(sql, /updated_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS account_deletion_requests_one_pending_per_user/i);
  assert.match(sql, /ON account_deletion_requests\(user_id\)/i);
  assert.match(sql, /WHERE status = 'pending'/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS account_deletion_requests_user_status_expires_idx/i);
  assert.match(sql, /ON account_deletion_requests\(user_id, status, expires_at\)/i);
});

test("account deletion migration repairs release note delivery user cascade FK idempotently", async () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const sql = await readFile(resolve(dir, "007_account_deletion.sql"), "utf8");

  assert.match(sql, /DO \$\$/i);
  assert.match(sql, /FROM pg_constraint/i);
  assert.match(sql, /JOIN pg_class child_table/i);
  assert.match(sql, /JOIN pg_attribute child_column/i);
  assert.match(sql, /child_table\.relname = 'release_note_deliveries'/i);
  assert.match(sql, /child_column\.attname = 'user_id'/i);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS/i);
  assert.match(sql, /ADD CONSTRAINT release_note_deliveries_user_id_fkey/i);
  assert.match(sql, /FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/i);
});

test("product analytics migration adds first-touch fields and singleton onboarding index without backfill", async () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const sql = await readFile(resolve(dir, "008_product_analytics.sql"), "utf8");

  assert.match(sql, /ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_source TEXT/i);
  assert.match(sql, /ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_first_seen_at TIMESTAMPTZ/i);
  assert.match(sql, /ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_blocked_at TIMESTAMPTZ/i);
  assert.match(sql, /ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_unblocked_at TIMESTAMPTZ/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS app_events_singleton_onboarding_user_event_idx/i);
  assert.match(sql, /ON app_events \(user_id, event_name\)/i);
  assert.match(sql, /WHERE user_id IS NOT NULL/i);
  assert.match(sql, /event_name IN \(\s*'onboarding_started',\s*'currency_selected',\s*'budget_set',\s*'onboarding_completed'\s*\)/i);
  assert.doesNotMatch(sql, /UPDATE\s+users/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+app_events/i);
});

test("planned reminder migration stores exact occurrence state without financial text", async () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const sql = await readFile(resolve(dir, "013_planned_payment_reminders.sql"), "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS planned_payment_reminders/i);
  assert.match(sql, /user_id BIGINT NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /planned_expense_id BIGINT NOT NULL REFERENCES planned_expenses\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /occurrence_date DATE NOT NULL/i);
  assert.match(sql, /UNIQUE\s*\(planned_expense_id,\s*occurrence_date\)/i);
  assert.match(sql, /tg_chat_id BIGINT/i);
  assert.match(sql, /tg_message_id BIGINT/i);
  assert.doesNotMatch(sql, /description|amount|source_text|token/i);
});

test("migrate records applied files and skips them on the second run", async () => {
  const dir = await createTempMigrations({
    "001_create_sample.sql": "CREATE TABLE sample_migration_probe (id integer PRIMARY KEY);",
    "002_insert_sample.sql": "INSERT INTO sample_migration_probe (id) VALUES (1);"
  });
  const fake = createMigrationPool();
  const logs = createLogger();

  try {
    await migrate({ migrationsDir: dir, pool: fake.pool, logger: logs });
    await migrate({ migrationsDir: dir, pool: fake.pool, logger: logs });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  assert.deepEqual(fake.appliedFiles(), ["001_create_sample.sql", "002_insert_sample.sql"]);
  assert.equal(fake.ledgerRows().length, 2);
  assert.equal(fake.ledgerRows().every((row) => row.applied_at instanceof Date), true);
  assert.deepEqual(fake.executedMigrationSql(), [
    "CREATE TABLE sample_migration_probe (id integer PRIMARY KEY);",
    "INSERT INTO sample_migration_probe (id) VALUES (1);"
  ]);
  assert.deepEqual(logs.messagesFor("migration applied"), [
    "001_create_sample.sql",
    "002_insert_sample.sql"
  ]);
  assert.deepEqual(logs.messagesFor("migration skipped"), [
    "001_create_sample.sql",
    "002_insert_sample.sql"
  ]);
});

test("migrate rolls back the migration and ledger insert together on failure", async () => {
  const dir = await createTempMigrations({
    "001_fails.sql": "FAIL MIGRATION;"
  });
  const fake = createMigrationPool();
  const logs = createLogger();

  try {
    await assert.rejects(
      () => migrate({ migrationsDir: dir, pool: fake.pool, logger: logs }),
      /migration boom/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  assert.deepEqual(fake.appliedFiles(), []);
  assert.deepEqual(fake.clientQueries(), ["BEGIN", "LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE", "ROLLBACK"]);
  assert.deepEqual(logs.messagesFor("migration failed"), ["001_fails.sql"]);
});

test("migration SQL does not contain personal data-fix updates", async () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const files = await listMigrationFiles(dir);

  for (const file of files) {
    const sql = await readFile(resolve(dir, file), "utf8");
    assert.doesNotMatch(
      sql,
      /UPDATE\s+users\s+SET\s+usd_thb_rate\s*=\s*32\.65\s+WHERE\s+usd_thb_rate\s*=\s*36/i,
      `${file} must not overwrite user usd_thb_rate = 36`
    );
    assert.doesNotMatch(
      sql,
      /UPDATE\s+users\s+SET[\s\S]*?WHERE[\s\S]*?telegram_user_id\s*=\s*\d+/i,
      `${file} must not contain personal UPDATE users fixes by telegram_user_id`
    );
  }
});

async function createTempMigrations(files) {
  const dir = await mkdtemp(join(tmpdir(), "money-flow-migrations-"));
  await Promise.all(
    Object.entries(files).map(([filename, sql]) => writeFile(join(dir, filename), sql, "utf8"))
  );
  return dir;
}

function createLogger() {
  const entries = [];
  return {
    info(metadata, message) {
      entries.push({ level: "info", metadata, message });
    },
    error(metadata, message) {
      entries.push({ level: "error", metadata, message });
    },
    messagesFor(message) {
      return entries
        .filter((entry) => entry.message === message)
        .map((entry) => entry.metadata.filename);
    }
  };
}

function createMigrationPool() {
  const ledger = new Map();
  const migrationSql = [];
  const clientQueries = [];
  let pendingLedgerInsert = null;

  const client = {
    async query(sql, params = []) {
      const query = normalizeSql(sql);
      if (["BEGIN", "COMMIT", "ROLLBACK", "LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE"].includes(query)) {
        clientQueries.push(query);
        if (query === "COMMIT" && pendingLedgerInsert) {
          ledger.set(pendingLedgerInsert, { filename: pendingLedgerInsert, applied_at: new Date() });
          pendingLedgerInsert = null;
        }
        if (query === "ROLLBACK") pendingLedgerInsert = null;
        return { rows: [] };
      }
      if (/SELECT\s+1\s+FROM\s+schema_migrations/i.test(query)) {
        return { rows: ledger.has(params[0]) ? [{ "?column?": 1 }] : [] };
      }
      if (/INSERT\s+INTO\s+schema_migrations/i.test(query)) {
        pendingLedgerInsert = params[0];
        return { rows: [] };
      }
      if (query === "FAIL MIGRATION;") {
        throw new Error("migration boom");
      }
      migrationSql.push(query);
      return { rows: [] };
    },
    release() {}
  };

  return {
    pool: {
      async query(sql) {
        if (/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+schema_migrations/i.test(normalizeSql(sql))) {
          return { rows: [] };
        }
        throw new Error(`unexpected pool query: ${sql}`);
      },
      async connect() {
        return client;
      }
    },
    appliedFiles: () => [...ledger.keys()],
    ledgerRows: () => [...ledger.values()],
    executedMigrationSql: () => migrationSql,
    clientQueries: () => clientQueries
  };
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}
