import test from "node:test";
import assert from "node:assert/strict";

import { summarizeLocalParserCsvRows } from "../src/localParserCsvAudit.js";

test("CSV parser audit returns category-only aggregates without preserving source rows", () => {
  const report = summarizeLocalParserCsvRows([
    { note: "electric train", amount: 61, currency: "RUB", category: "transport" },
    { note: "unknown item", amount: 80, currency: "RUB", category: "education" },
    { note: "metro", amount: 100, currency: "RUB", category: "transport" }
  ], {
    parseExpenseText(text) {
      if (text.startsWith("electric train")) return { expenses: [{ category_slug: "transport" }] };
      if (text.startsWith("metro")) return { expenses: [{ category_slug: "transport" }] };
      return { expenses: [{ category_slug: "other" }] };
    }
  });

  assert.deepEqual(report, {
    totalRecordCount: 3,
    localResolvedCount: 2,
    localOtherCount: 1,
    categoryMismatchCount: 1,
    localCategoryCounts: { other: 1, transport: 2 }
  });
  assert.equal(JSON.stringify(report).includes("unknown item"), false);
  assert.equal(JSON.stringify(report).includes("61"), false);
});
