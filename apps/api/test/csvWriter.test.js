import test from "node:test";
import assert from "node:assert/strict";

import { writeCsv } from "../src/csvWriter.js";

test("writeCsv emits UTF-8 BOM, headers, and escaped rows", () => {
  const csv = writeCsv([
    {
      date: "2026-07-08",
      amount: "120.50",
      currency: "THB",
      note: "кофе, круассан\n\"утро\"",
      empty: null
    }
  ], ["date", "amount", "currency", "note", "empty"]);

  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.equal(
    csv,
    "\ufeffdate,amount,currency,note,empty\r\n2026-07-08,120.50,THB,\"кофе, круассан\n\"\"утро\"\"\","
  );
});

test("writeCsv writes headers only when there are no rows", () => {
  assert.equal(writeCsv([], ["date", "amount"]), "\ufeffdate,amount");
});
