import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function hashQuickAccessToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function createQuickAccessToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashQuickAccessToken(token) };
}

export function matchesQuickAccessToken(token, tokenHash) {
  const actual = Buffer.from(hashQuickAccessToken(token), "hex");
  const expected = Buffer.from(String(tokenHash ?? ""), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
