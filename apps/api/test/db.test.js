import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { runWithRetry, listMigrationFiles } from "../src/db.js";

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
