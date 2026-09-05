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
          uncertain: false,
          paid_purchase_evidence: false,
          transaction_kind: "debit",
          is_final_total: true
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
  assert.ok(requestBody.text.format.schema.properties.evidence_type.enum.includes("purchase_photo"));
  assert.match(requestBody.input[0].content, /never treat a visible product price as a purchase/i);
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

test("does not turn a visible product price into an expense candidate", async () => {
  const analyzer = createExpenseEvidenceAnalyzer({
    apiKey: "test-key",
    hmacSecret: "test-hmac",
    fetchImpl: async () => jsonResponse({ output_text: JSON.stringify({
      evidence_type: "product_price",
      candidates: [candidate("Shelf price", 199)]
    }) })
  });

  assert.deepEqual(await analyzer.analyze(image()), {
    evidenceType: "product_price",
    candidates: [],
    candidateSetHmac: null
  });
});

test("requires explicit paid-purchase evidence before a purchase photo can create a review candidate", async () => {
  const analyzer = createExpenseEvidenceAnalyzer({
    apiKey: "test-key",
    hmacSecret: "test-hmac",
    fetchImpl: async () => jsonResponse({ output_text: JSON.stringify({
      evidence_type: "purchase_photo",
      candidates: [candidate("Bag", 199)]
    }) })
  });

  assert.deepEqual(await analyzer.analyze(image()), {
    evidenceType: "purchase_photo",
    candidates: [],
    candidateSetHmac: null
  });
});

test("keeps a paid purchase photo reviewable and limits it to one candidate", async () => {
  const analyzer = createExpenseEvidenceAnalyzer({
    apiKey: "test-key",
    hmacSecret: "test-hmac",
    fetchImpl: async () => jsonResponse({ output_text: JSON.stringify({
      evidence_type: "purchase_photo",
      candidates: [
        { ...candidate("Paid bag", 199), paid_purchase_evidence: true },
        { ...candidate("Second bag", 299), paid_purchase_evidence: true }
      ]
    }) })
  });

  const result = await analyzer.analyze(image());
  assert.equal(result.evidenceType, "purchase_photo");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].amount, 199);
  assert.equal(result.candidates[0].needsReview, true);
});

test("keeps only debit rows from bank history", async () => {
  const analyzer = createExpenseEvidenceAnalyzer({
    apiKey: "test-key",
    hmacSecret: "test-hmac",
    fetchImpl: async () => jsonResponse({ output_text: JSON.stringify({
      evidence_type: "bank_transactions",
      candidates: [
        { ...candidate("Salary", 500), transaction_kind: "credit" },
        { ...candidate("Transfer", 100), transaction_kind: "transfer" },
        { ...candidate("Balance", 900), transaction_kind: "balance" },
        { ...candidate("Market", 200), transaction_kind: "debit" }
      ]
    }) })
  });

  const result = await analyzer.analyze(image());
  assert.deepEqual(result.candidates.map(({ merchant, amount }) => ({ merchant, amount })), [{ merchant: "market", amount: 200 }]);
});

test("recognizes bank history as evidence while rejecting its non-debit rows", async () => {
  const analyzer = createExpenseEvidenceAnalyzer({
    apiKey: "test-key",
    hmacSecret: "test-hmac",
    fetchImpl: async () => jsonResponse({ output_text: JSON.stringify({
      evidence_type: "bank_history",
      candidates: [
        { ...candidate("Refund", 50), transaction_kind: "credit" },
        { ...candidate("Coffee", 60), transaction_kind: "debit" }
      ]
    }) })
  });

  const result = await analyzer.analyze(image());
  assert.equal(result.evidenceType, "bank_history");
  assert.deepEqual(result.candidates.map(({ amount }) => amount), [60]);
});

test("uses only the final total from a bill", async () => {
  const analyzer = createExpenseEvidenceAnalyzer({
    apiKey: "test-key",
    hmacSecret: "test-hmac",
    fetchImpl: async () => jsonResponse({ output_text: JSON.stringify({
      evidence_type: "bill",
      candidates: [
        { ...candidate("Power", 100), is_final_total: false },
        { ...candidate("Power", 107), is_final_total: true }
      ]
    }) })
  });

  const result = await analyzer.analyze(image());
  assert.deepEqual(result.candidates.map(({ amount }) => amount), [107]);
});

function candidate(merchant, amount) {
  return { amount, currency: "THB", spent_on: "2026-08-20", spent_at: null, merchant, description: merchant, category_slug: "groceries", confidence: 0.9, needs_review: false, uncertain: false, paid_purchase_evidence: false, transaction_kind: "debit", is_final_total: true };
}

function image() {
  return { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: "image/jpeg" };
}

function jsonResponse(body) {
  return { ok: true, status: 200, async text() { return JSON.stringify(body); } };
}
