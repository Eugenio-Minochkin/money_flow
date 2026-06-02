import test from "node:test";
import assert from "node:assert/strict";

import { categoryName, inferCategory } from "../src/categories.js";

test("adds education category for learning expenses", () => {
  assert.equal(categoryName("education"), "Образование");
  assert.equal(inferCategory("English lesson"), "education");
  assert.equal(inferCategory("курс английского"), "education");
});
