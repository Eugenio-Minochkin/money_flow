import test from "node:test";
import assert from "node:assert/strict";
import { resolveDraftSaveResponse, classifyConfirmOutcome, shouldConfirmAfterSave } from "../src/draftSave.js";

test("resolveDraftSaveResponse flags 409 with a fresh draft as a conflict", () => {
  assert.equal(resolveDraftSaveResponse(409, { draft: { id: 1, version: 5 } }).conflict, true);
  assert.equal(resolveDraftSaveResponse(200, { draft: { id: 1, version: 2 } }).conflict, false);
});

test("classifyConfirmOutcome reports alreadySaved from the confirm response", () => {
  assert.equal(classifyConfirmOutcome({ alreadySaved: true }).alreadySaved, true);
  assert.equal(classifyConfirmOutcome({ alreadySaved: false }).alreadySaved, false);
  assert.equal(classifyConfirmOutcome(undefined).alreadySaved, false);
});

test("shouldConfirmAfterSave is false after a 409 conflict (saved:false) and true otherwise", () => {
  assert.equal(shouldConfirmAfterSave({ saved: false }), false);
  assert.equal(shouldConfirmAfterSave({ saved: true }), true);
  assert.equal(shouldConfirmAfterSave(undefined), false);
});
