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
  await pool.query(migration);
}

export async function closeDb() {
  await pool.end();
}
