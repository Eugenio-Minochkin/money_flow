import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { isQuickCaptureAutoSaveEligible } from "../src/quickCapture.js";

test("only a confident single-item Quick Capture may save immediately", () => {
  assert.equal(isQuickCaptureAutoSaveEligible([{ category_slug: "food_cafe", needs_review: false }]), true);
  assert.equal(isQuickCaptureAutoSaveEligible([{ category_slug: "other", needs_review: false }]), false);
  assert.equal(isQuickCaptureAutoSaveEligible([{ category_slug: "food_cafe", needs_review: true }]), false);
  assert.equal(isQuickCaptureAutoSaveEligible([
    { category_slug: "food_cafe", needs_review: false },
    { category_slug: "transport", needs_review: false }
  ]), false);
});

test("Mini App Quick Entry saves eligible drafts and returns other drafts for review", async () => {
  const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");

  assert.match(server, /if \(isQuickCaptureAutoSaveEligible\(draft\.items\)\)/);
  assert.match(server, /saveDraftAsExpense\(draft\.id, auth\.telegramUserId\)/);
  assert.match(server, /return sendJson\(res, 201, \{ saved \}\);/);
  assert.match(server, /return sendJson\(res, 201, \{ draft \}\);/);
});
