import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("expense evidence migration persists only workflow metadata and draft links", async () => {
  const sql = await readFile(
    new URL("../migrations/020_expense_evidence_imports.sql", import.meta.url),
    "utf8"
  );

  assert.match(sql, /CREATE TABLE IF NOT EXISTS expense_evidence_imports/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS expense_evidence_candidates/);
  assert.match(sql, /image_bytes_hmac TEXT NOT NULL/);
  assert.match(sql, /telegram_file_hmac TEXT/);
  assert.match(sql, /candidate_set_hmac TEXT/);
  assert.match(sql, /draft_id BIGINT REFERENCES drafts\(id\) ON DELETE SET NULL/);
  assert.doesNotMatch(sql, /\b(image_bytes|data_url|ocr_text|caption|merchant|amount|balance)\b/i);
});

test("expense evidence session migration persists only ownership, lifecycle, and import links", async () => {
  const sql = await readFile(
    new URL("../migrations/021_expense_evidence_sessions.sql", import.meta.url),
    "utf8"
  );

  assert.match(sql, /CREATE TABLE IF NOT EXISTS expense_evidence_sessions/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS expense_evidence_session_imports/);
  assert.match(sql, /user_id BIGINT NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(sql, /source_chat_id BIGINT NOT NULL/);
  assert.match(sql, /status TEXT NOT NULL CHECK \(status IN \('collecting', 'finalizing', 'ready', 'cancelled', 'expired'\)\)/);
  assert.match(sql, /PRIMARY KEY\(session_id, import_id\)/);
  assert.doesNotMatch(sql, /\b(image_bytes|data_url|file_id|caption|transcript|ocr|merchant|amount|currency|balance|context)\b/i);
});
