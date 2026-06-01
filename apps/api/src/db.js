import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { config } from "./config.js";

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

export const pool = new Pool({
  connectionString: config.databaseUrl
});

export async function migrate() {
  const migration = await readFile(resolve(__dirname, "../migrations/001_initial.sql"), "utf8");
  await runWithRetry(() => pool.query(migration));
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
