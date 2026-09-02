import assert from "node:assert/strict";
import test from "node:test";

import { createExpenseEvidenceAnalyzer } from "../src/expenseEvidenceAnalyzer.js";

test("analyzes a sanitized image through Responses structured output without storage", async () => {
  let requestBody;
  const analyzer = createExpenseEvidenceAnalyzer({
    apiKey: "test-key",
    model: "gpt-test",
    hmacSecret: "test-hmac",
    now: () => new Date("2026-08-21T10:00:00.000Z"),
    fetchImpl: async (_url, request) => {
      requestBody = JSON.parse(request.body);
      return jsonResponse({ output_text: JSON.stringify({
        evidence_type: "receipt",
        candidates: [{
          amount: 1840,
          currency: "THB",
          spent_on: "2026-08-18",
          spent_at: null,
          merchant: "Big C",
          description: "Groceries",
          category_slug: "groceries",
          confidence: 0.93,
          needs_review: false,
          uncertain: false
        }]
      }) });
    }
  });

  const result = await analyzer.analyze({
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    mimeType: "image/jpeg",
    caption: "private caption must not be persisted"
  });

  assert.equal(requestBody.model, "gpt-test");
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.text.format.type, "json_schema");
  assert.equal(requestBody.input[1].content[1].type, "input_image");
  assert.match(requestBody.input[1].content[1].image_url, /^data:image\/jpeg;base64,/);
  assert.equal(result.evidenceType, "receipt");
  assert.deepEqual(result.candidates, [{
    amount: 1840,
    currency: "THB",
    spentOn: "2026-08-18",
    spentAt: null,
    merchant: "big c",
    description: "Groceries",
    categorySlug: "groceries",
    confidence: 0.93,
    needsReview: false
  }]);
  assert.match(result.candidateSetHmac, /^[a-f0-9]{64}$/);
});

test("stable candidate canonicalization makes correlation HMAC independent of analyzer ordering", async () => {
  const response = (candidates) => createExpenseEvidenceAnalyzer({
    apiKey: "test-key",
    hmacSecret: "test-hmac",
    fetchImpl: async () => jsonResponse({ output_text: JSON.stringify({ evidence_type: "bank_transactions", candidates }) })
  });
  const first = await response([candidate("Shop B", 20), candidate("Shop A", 10)]).analyze(image());
  const second = await response([candidate("Shop A", 10), candidate("Shop B", 20)]).analyze(image());

  assert.equal(first.candidateSetHmac, second.candidateSetHmac);
});

test("keeps unsupported evidence empty and turns unclear financial fields into review", async () => {
  const analyzer = createExpenseEvidenceAnalyzer({
    apiKey: "test-key",
    hmacSecret: "test-hmac",
    fetchImpl: async () => jsonResponse({ output_text: JSON.stringify({ evidence_type: "unsupported", candidates: [] }) })
  });
  assert.deepEqual(await analyzer.analyze(image()), { evidenceType: "unsupported", candidates: [], candidateSetHmac: null });
});

function candidate(merchant, amount) {
  return { amount, currency: "THB", spent_on: "2026-08-20", spent_at: null, merchant, description: merchant, category_slug: "groceries", confidence: 0.9, needs_review: false, uncertain: false };
}

function image() {
  return { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: "image/jpeg" };
}

function jsonResponse(body) {
  return { ok: true, status: 200, async text() { return JSON.stringify(body); } };
}
