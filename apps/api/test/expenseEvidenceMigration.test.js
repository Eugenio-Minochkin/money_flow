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
