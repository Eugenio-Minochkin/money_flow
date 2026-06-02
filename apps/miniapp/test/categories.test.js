import test from "node:test";
import assert from "node:assert/strict";

import { categories, categoryColor, categoryLabel } from "../src/categories.js";

test("category helpers return labels and colors with fallback", () => {
  assert.equal(categories[0][0], "food_cafe");
  assert.equal(categoryLabel("food_cafe"), categories[0][1]);
  assert.equal(categoryColor("food_cafe"), categories[0][2]);
  assert.equal(categoryLabel("unknown"), "unknown");
  assert.equal(categoryColor("unknown"), "#756b61");
});
