import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");

test("editable item fields include budget impact select with regular default", () => {
  assert.match(source, /name="\$\{prefix\}-budget_impact"/);
  assert.match(source, /item\.budget_impact \?\? "regular"/);
  assert.match(source, /option\("planned"/);
  assert.match(source, /option\("large_oneoff"/);
});

test("expense editor passes current budget impact and collectItem submits it", () => {
  assert.match(source, /budget_impact: expense\.budget_impact \?\? "regular"/);
  assert.match(source, /budget_impact: input\(`\$\{prefix\}-budget_impact`\)\?\.value \?\? original\.budget_impact \?\? "regular"/);
});

test("expense row renders planned and large one-off markers", () => {
  assert.match(source, /budgetImpactLabel\(expense\.budget_impact\)/);
  assert.match(source, /planned.*🧾 Плановая/s);
  assert.match(source, /large_oneoff.*📦 Крупная/s);
});
