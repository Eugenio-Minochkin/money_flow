import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { readFile } from "node:fs/promises";
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
