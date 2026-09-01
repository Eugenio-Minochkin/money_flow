import test from "node:test";
import assert from "node:assert/strict";

import { createPaidProviderUsageGate, PaidProviderLimitError } from "../src/paidProviderUsage.js";

test("usage gate passes only privacy-minimal dimensions to the repository", async () => {
  let received;
  const gate = createPaidProviderUsageGate({
    repository: {
      reservePaidProviderUsage: async (input) => {
        received = input;
        return { allowed: true };
      }
    },
    provider: "openai_parser",
    windowMs: 86_400_000,
    maxRequests: 100
  });

  await gate({ userId: 42, requestUnits: 1, requestKey: "telegram:7:8" });

  assert.deepEqual(received, {
    userId: 42,
    provider: "openai_parser",
    windowMs: 86_400_000,
    maxRequests: 100,
    maxAudioSeconds: null,
    audioSeconds: 0,
    requestUnits: 1,
    requestKey: "telegram:7:8"
  });
});

test("usage gate returns a controlled limit error without user payload", async () => {
  const gate = createPaidProviderUsageGate({
    repository: { reservePaidProviderUsage: async () => ({ allowed: false, reason: "request_limit" }) },
    provider: "deepgram_transcription",
    windowMs: 86_400_000,
    maxRequests: 50,
    maxAudioSeconds: 900
  });

  await assert.rejects(
    () => gate({ userId: 42, audioSeconds: 7, requestKey: "telegram:7:8" }),
    (error) => error instanceof PaidProviderLimitError
      && error.code === "paid_provider_limit_reached"
      && error.provider === "deepgram_transcription"
  );
});
