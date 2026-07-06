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

test("migration files are listed in lexical order and include 001 and 002", async () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const files = await listMigrationFiles(dir);
  assert.ok(files.includes("001_initial.sql"));
  assert.ok(files.includes("002_draft_confirm_flow.sql"));
  assert.deepEqual(files, [...files].sort());
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
