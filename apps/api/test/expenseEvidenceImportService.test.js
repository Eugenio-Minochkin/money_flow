import assert from "node:assert/strict";
import test from "node:test";
import { createExpenseEvidenceImportService } from "../src/expenseEvidenceImportService.js";

test("creates canonical reviewable drafts without retaining image data", async () => {
  let completed;
  const controller = new AbortController();
  const forwardedSignals = [];
  const service = createExpenseEvidenceImportService({
    analyzer: { async analyze({ signal }) { forwardedSignals.push(signal); return { evidenceType: "receipt", candidateSetHmac: "set-hmac", candidates: [{ amount: 1840, currency: "THB", spentOn: "2026-08-18", spentAt: null, merchant: "big c", description: "Groceries", categorySlug: "groceries", confidence: 0.9, needsReview: false }] }; } },
    imageDownloader: { async download({ signal }) { forwardedSignals.push(signal); return { bytes: Buffer.from([1, 2]), mimeType: "image/jpeg", sizeBucket: "<=1mb" }; } },
    repository: {
      async claimExpenseEvidenceImport() { return { state: "claimed", claimVersion: 1 }; },
      async listExpenseEvidenceDuplicateCandidates() { return []; },
      async completeExpenseEvidenceImport(value) { completed = value; return { id: 7 }; },
      async releaseExpenseEvidenceImport() {}
    },
    hmac: () => "bytes-hmac"
  });

  const result = await service.importImage({ user: { id: 2 }, chatId: 3, messageId: 4, fileId: "not-persisted", fileUniqueId: "unique", declaredMimeType: "image/jpeg", signal: controller.signal });
  assert.equal(result.state, "ready");
  assert.equal(result.importId, 7);
  assert.equal(completed.imageBytesHmac, "bytes-hmac");
  assert.equal(completed.candidateSetHmac, "set-hmac");
  assert.equal(completed.candidates[0].items[0].needs_review, false);
  assert.doesNotMatch(JSON.stringify(completed), /not-persisted|\[1,2\]/);
  assert.deepEqual(forwardedSignals, [controller.signal, controller.signal]);
});

test("passes internal user identity and durable Telegram request key to image analysis", async () => {
  let analysisInput;
  const service = createExpenseEvidenceImportService({
    analyzer: {
      async analyze(input) {
        analysisInput = input;
        return { evidenceType: "unknown", candidateSetHmac: null, candidates: [] };
      }
    },
    imageDownloader: { async download() { return { bytes: Buffer.from([1, 2]), mimeType: "image/jpeg" }; } },
    repository: {
      async claimExpenseEvidenceImport() { return { state: "claimed", claimVersion: 1 }; },
      async listExpenseEvidenceDuplicateCandidates() { return []; },
      async completeExpenseEvidenceImport() { return { id: 7 }; },
      async releaseExpenseEvidenceImport() {}
    },
    hmac: () => "bytes-hmac"
  });

  await service.importImage({ user: { id: 42 }, chatId: 10, messageId: 77, fileId: "file", declaredMimeType: "image/jpeg" });

  assert.equal(analysisInput.usageUserId, 42);
  assert.equal(analysisInput.requestKey, "telegram:42:10:77");
});

test("does not analyze or account a replayed or concurrent photo claim", async (t) => {
  for (const state of ["ready", "completed", "processing"]) {
    await t.test(state, async () => {
      let analysisCalls = 0;
      let downloadCalls = 0;
      const service = createExpenseEvidenceImportService({
        analyzer: { async analyze() { analysisCalls += 1; } },
        imageDownloader: { async download() { downloadCalls += 1; } },
        repository: { async claimExpenseEvidenceImport() { return { state, id: 7 }; } },
        hmac: () => "bytes-hmac"
      });

      const result = await service.importImage({ user: { id: 42 }, chatId: 10, messageId: 77, fileId: "file", declaredMimeType: "image/jpeg" });

      assert.equal(analysisCalls, 0);
      assert.equal(downloadCalls, 0);
      assert.equal(result.state, state === "processing" ? "processing" : state);
    });
  }
});

test("releases the durable photo claim without creating drafts when quota rejects analysis", async () => {
  const quotaError = Object.assign(new Error("paid_provider_limit_reached"), { code: "paid_provider_limit_reached" });
  let released;
  let completed = false;
  const service = createExpenseEvidenceImportService({
    analyzer: { async analyze() { throw quotaError; } },
    imageDownloader: { async download() { return { bytes: Buffer.from([1, 2]), mimeType: "image/jpeg" }; } },
    repository: {
      async claimExpenseEvidenceImport() { return { state: "claimed", claimVersion: 3 }; },
      async completeExpenseEvidenceImport() { completed = true; },
      async releaseExpenseEvidenceImport(...args) { released = args; }
    },
    hmac: () => "bytes-hmac"
  });

  await assert.rejects(
    () => service.importImage({ user: { id: 42 }, chatId: 10, messageId: 77, fileId: "file", declaredMimeType: "image/jpeg" }),
    (error) => error === quotaError
  );
  assert.deepEqual(released, [42, 10, 77, 3]);
  assert.equal(completed, false);
});

test("does not analyze or account when image download fails before the paid request", async () => {
  let analysisCalls = 0;
  let released = false;
  const downloadError = new Error("invalid image");
  const service = createExpenseEvidenceImportService({
    analyzer: { async analyze() { analysisCalls += 1; } },
    imageDownloader: { async download() { throw downloadError; } },
    repository: {
      async claimExpenseEvidenceImport() { return { state: "claimed", claimVersion: 2 }; },
      async releaseExpenseEvidenceImport() { released = true; }
    },
    hmac: () => "bytes-hmac"
  });

  await assert.rejects(
    () => service.importImage({ user: { id: 42 }, chatId: 10, messageId: 77, fileId: "file", declaredMimeType: "image/jpeg" }),
    (error) => error === downloadError
  );
  assert.equal(analysisCalls, 0);
  assert.equal(released, true);
});

test("releases the durable claim without creating drafts after a paid provider failure", async () => {
  const providerError = Object.assign(new Error("analysis_failed"), { code: "analysis_failed" });
  let released = false;
  let completed = false;
  const service = createExpenseEvidenceImportService({
    analyzer: { async analyze() { throw providerError; } },
    imageDownloader: { async download() { return { bytes: Buffer.from([1, 2]), mimeType: "image/jpeg" }; } },
    repository: {
      async claimExpenseEvidenceImport() { return { state: "claimed", claimVersion: 4 }; },
      async completeExpenseEvidenceImport() { completed = true; },
      async releaseExpenseEvidenceImport() { released = true; }
    },
    hmac: () => "bytes-hmac"
  });

  await assert.rejects(
    () => service.importImage({ user: { id: 42 }, chatId: 10, messageId: 77, fileId: "file", declaredMimeType: "image/jpeg" }),
    (error) => error === providerError
  );
  assert.equal(released, true);
  assert.equal(completed, false);
});

test("classifies image candidates against owned financial facts before completing the import", async () => {
  let completed;
  const service = createExpenseEvidenceImportService({
    analyzer: { async analyze() { return { evidenceType: "receipt", candidateSetHmac: "set-hmac", candidates: [
      { amount: 1840, currency: "THB", spentOn: "2026-08-18", spentAt: "12:05", merchant: "Big C", description: "Groceries", categorySlug: "groceries", confidence: 0.9, needsReview: false }
    ] }; } },
    imageDownloader: { async download() { return { bytes: Buffer.from([1, 2]), mimeType: "image/jpeg" }; } },
    repository: {
      async claimExpenseEvidenceImport() { return { state: "claimed", claimVersion: 1 }; },
      async listExpenseEvidenceDuplicateCandidates() { return [{ amount: 1840, currency: "THB", spentOn: "2026-08-18", spentAt: "12:10", merchant: "Big C" }]; },
      async completeExpenseEvidenceImport(value) { completed = value; return { id: 7 }; },
      async releaseExpenseEvidenceImport() {}
    },
    hmac: () => "bytes-hmac"
  });

  await service.importImage({ user: { id: 2 }, chatId: 3, messageId: 4, fileId: "file", declaredMimeType: "image/jpeg" });

  assert.equal(completed.candidates[0].dedupeClassification, "likely_duplicate");
  assert.equal(completed.candidates[0].dedupeReasonCode, "amount_currency_date_merchant");
});

test("resolves an owned import one candidate at a time with partial outcomes", async () => {
  const calls = [];
  const service = createExpenseEvidenceImportService({
    repository: {
      async resolveExpenseEvidenceCandidate({ candidateId, action }) {
        calls.push({ candidateId, action });
        return candidateId === 9 ? { state: "blocked", reasonCode: "likely_duplicate" } : { state: "saved", draftId: 12 };
      }
    },
    hmac: () => "bytes-hmac"
  });

  const result = await service.resolveImportCandidates({ userId: 2, importId: 7, actions: [
    { candidateId: 8, action: "save" },
    { candidateId: 9, action: "save" },
    { candidateId: 10, action: "already_accounted" }
  ] });

  assert.deepEqual(result.outcomes, [
    { candidateId: 8, state: "saved", draftId: 12 },
    { candidateId: 9, state: "blocked", reasonCode: "likely_duplicate" },
    { candidateId: 10, state: "saved", draftId: 12 }
  ]);
  assert.deepEqual(calls, [
    { candidateId: 8, action: "save" },
    { candidateId: 9, action: "save" },
    { candidateId: 10, action: "already_accounted" }
  ]);
});

test("continues resolving later candidates when one action fails", async () => {
  const calls = [];
  const service = createExpenseEvidenceImportService({
    repository: {
      async resolveExpenseEvidenceCandidate({ candidateId }) {
        calls.push(candidateId);
        if (candidateId === 8) throw new Error("database unavailable");
        return { state: "saved", draftId: 12 };
      }
    },
    hmac: () => "bytes-hmac"
  });

  const result = await service.resolveImportCandidates({ userId: 2, importId: 7, actions: [
    { candidateId: 8, action: "save" }, { candidateId: 9, action: "save" }
  ] });

  assert.deepEqual(calls, [8, 9]);
  assert.deepEqual(result.outcomes, [
    { candidateId: 8, state: "failed", reasonCode: "resolution_failed" },
    { candidateId: 9, state: "saved", draftId: 12 }
  ]);
});

test("forwards an explicit add override to the canonical candidate resolver", async () => {
  let received;
  const service = createExpenseEvidenceImportService({
    repository: { async resolveExpenseEvidenceCandidate(value) { received = value; return { state: "saved", draftId: 12 }; } },
    hmac: () => "bytes-hmac"
  });

  await service.resolveImportCandidates({ userId: 2, importId: 7, actions: [{ candidateId: 8, action: "add" }] });

  assert.deepEqual(received, { userId: 2, importId: 7, candidateId: 8, action: "add" });
});
