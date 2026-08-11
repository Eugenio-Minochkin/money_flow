import assert from "node:assert/strict";
import test from "node:test";
import { createQuickAccessToken, hashQuickAccessToken, matchesQuickAccessToken } from "../src/quickAccessService.js";

test("quick access token has 256-bit raw entropy and only its hash is persisted", () => {
  const { token, tokenHash } = createQuickAccessToken();
  assert.ok(Buffer.from(token, "base64url").length >= 32);
  assert.notEqual(token, tokenHash);
  assert.equal(matchesQuickAccessToken(token, tokenHash), true);
  assert.equal(matchesQuickAccessToken(`${token}x`, tokenHash), false);
  assert.equal(hashQuickAccessToken(token), tokenHash);
});
