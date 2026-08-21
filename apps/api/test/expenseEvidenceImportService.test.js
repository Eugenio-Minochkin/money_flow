import assert from "node:assert/strict";
import test from "node:test";
import { createExpenseEvidenceImportService } from "../src/expenseEvidenceImportService.js";

test("creates canonical reviewable drafts without retaining image data", async () => {
  let completed;
  const service = createExpenseEvidenceImportService({
    analyzer: { async analyze() { return { evidenceType: "receipt", candidateSetHmac: "set-hmac", candidates: [{ amount: 1840, currency: "THB", spentOn: "2026-08-18", spentAt: null, merchant: "big c", description: "Groceries", categorySlug: "groceries", confidence: 0.9, needsReview: false }] }; } },
    imageDownloader: { async download() { return { bytes: Buffer.from([1, 2]), mimeType: "image/jpeg", sizeBucket: "<=1mb" }; } },
    repository: {
      async claimExpenseEvidenceImport() { return { state: "claimed", claimVersion: 1 }; },
      async completeExpenseEvidenceImport(value) { completed = value; return { id: 7 }; },
      async releaseExpenseEvidenceImport() {}
    },
    hmac: () => "bytes-hmac"
  });

  const result = await service.importImage({ user: { id: 2 }, chatId: 3, messageId: 4, fileId: "not-persisted", fileUniqueId: "unique", declaredMimeType: "image/jpeg" });
  assert.equal(result.state, "ready");
  assert.equal(completed.imageBytesHmac, "bytes-hmac");
  assert.equal(completed.candidateSetHmac, "set-hmac");
  assert.equal(completed.candidates[0].items[0].needs_review, false);
  assert.doesNotMatch(JSON.stringify(completed), /not-persisted|\[1,2\]/);
});
