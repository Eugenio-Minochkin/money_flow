import assert from "node:assert/strict";
import test from "node:test";

import { collectQuickCaptureReviewItems } from "../src/quickCaptureReview.js";

test("Quick Capture review preserves parser provenance for untouched confident items", () => {
  const items = collectQuickCaptureReviewItems([
    { description: "coffee", amount: 120, category_slug: "food_cafe", category_source: "parser", needs_review: false }
  ], () => undefined);

  assert.deepEqual(items, [
    { description: "coffee", amount: 120, category_slug: "food_cafe", category_source: "parser", needs_review: false }
  ]);
});

test("Quick Capture review marks a selected uncertain category as user-provided", () => {
  const items = collectQuickCaptureReviewItems([
    { description: "coffee", amount: 120, category_slug: "other", category_source: "parser", needs_review: true }
  ], (name) => name.endsWith("-amount") ? "130" : "food_cafe", () => true);

  assert.deepEqual(items, [
    { description: "coffee", amount: 130, category_slug: "food_cafe", category_source: "user", needs_review: false }
  ]);
});

test("Quick Capture review keeps parser provenance when an uncertain item category is not explicitly changed", () => {
  const items = collectQuickCaptureReviewItems([
    { description: "coffee", amount: 120, category_slug: "food_cafe", category_source: "parser", needs_review: true }
  ], (name) => name.endsWith("-amount") ? "130" : "food_cafe");

  assert.deepEqual(items, [
    { description: "coffee", amount: 130, category_slug: "food_cafe", category_source: "parser", needs_review: false }
  ]);
});
