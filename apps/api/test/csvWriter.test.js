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

test("writeCsv neutralizes spreadsheet formula cells", () => {
  const csv = writeCsv([{
    equals: "=1+1",
    plus: "+2+2",
    minus: "-3+4",
    at: "@SUM(A1:A2)",
    spaced: " \t=5+5",
    bom: "\ufeff=6+6",
    quoted: "=SUM(1,2)",
    safe: "ordinary note",
    date: "2026-07-08",
    numeric: -12
  }], ["equals", "plus", "minus", "at", "spaced", "bom", "quoted", "safe", "date", "numeric"]);

  assert.equal(
    csv,
    "\ufeffequals,plus,minus,at,spaced,bom,quoted,safe,date,numeric\r\n'=1+1,'+2+2,'-3+4,'@SUM(A1:A2),' \t=5+5,'\ufeff=6+6,\"'=SUM(1,2)\",ordinary note,2026-07-08,-12"
  );
});
