import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { config } from "./config.js";

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

export const pool = new Pool({
  connectionString: config.databaseUrl
});

export async function listMigrationFiles(migrationsDir) {
  const entries = await readdir(migrationsDir);
  return entries.filter((file) => file.endsWith(".sql")).sort();
}

export async function migrate(options = {}) {
  const migrationsDir = options.migrationsDir ?? resolve(__dirname, "../migrations");
  const dbPool = options.pool ?? pool;
  const logger = options.logger ?? console;

  await runWithRetry(() => dbPool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `));

  const files = await listMigrationFiles(migrationsDir);
  for (const file of files) {
    const sql = await readFile(resolve(migrationsDir, file), "utf8");
    await runWithRetry(() => applyMigration({ dbPool, filename: file, sql, logger }));
  }
}

async function applyMigration({ dbPool, filename, sql, logger }) {
  const client = await dbPool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE");

    const existing = await client.query(
      "SELECT 1 FROM schema_migrations WHERE filename = $1",
      [filename]
    );
    if (existing.rows.length > 0) {
      await client.query("COMMIT");
      transactionStarted = false;
      logger.info?.({ filename }, "migration skipped");
      return;
    }

    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations (filename) VALUES ($1)",
      [filename]
    );
    await client.query("COMMIT");
    transactionStarted = false;
    logger.info?.({ filename }, "migration applied");
  } catch (error) {
    if (transactionStarted) {
      await rollbackMigration(client, filename, error, logger);
    } else {
      logger.error?.({ filename, error }, "migration failed");
    }
    throw error;
  } finally {
    client.release();
  }
}

async function rollbackMigration(client, filename, error, logger) {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    logger.error?.({ filename, error: rollbackError }, "migration rollback failed");
  }
  logger.error?.({ filename, error }, "migration failed");
}

export async function closeDb() {
  await pool.end();
}

export async function runWithRetry(operation, options = {}) {
  const retries = options.retries ?? 20;
  const delayMs = options.delayMs ?? 1_000;
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === retries || !isTransientStartupError(error)) {
        throw error;
      }
      await sleep(delayMs);
    }
  }

  throw lastError;
}

function isTransientStartupError(error) {
  return ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"].includes(error?.code);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
