import crypto from "node:crypto";

import { CATEGORIES } from "../../../packages/shared/src/categories.js";
import { SUPPORTED_CURRENCY_CODES } from "../../../packages/shared/src/currencies.js";
import { localDateKey, normalizeTimeZone } from "../../../packages/shared/src/time.js";
import { deadlineSignal } from "./deadlineSignal.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const EVIDENCE_TYPES = ["bank_transactions", "bank_history", "receipt", "order_confirmation", "payment_confirmation", "bill", "product_price", "purchase_photo", "unknown", "unsupported"];
const CATEGORIES_BY_SLUG = new Set(CATEGORIES.map((category) => category.slug));
const CURRENCIES = new Set(SUPPORTED_CURRENCY_CODES);

export function createExpenseEvidenceAnalyzer({
  apiKey,
  model = "gpt-5-mini",
  hmacSecret,
  timeoutMs = 30_000,
  fetchImpl = globalThis.fetch,
  consumeAnalysisUsage = null,
  now = () => new Date()
} = {}) {
  return {
    model: apiKey ? model : null,
    async analyze({ bytes, mimeType, caption = "", timeZone = null, usageUserId = null, requestKey = null, signal = null }) {
      if (!apiKey || !fetchImpl || !hmacSecret) throw analysisError();
      const normalizedTimeZone = normalizeTimeZone(timeZone).timeZone;
      await consumeAnalysisUsage?.({ userId: usageUserId, requestKey });
      const response = await requestStructuredAnalysis({ apiKey, model, timeoutMs, fetchImpl, bytes, mimeType, caption, signal });
      const result = normalizeAnalysis(response, now(), normalizedTimeZone);
      return {
        evidenceType: result.evidenceType,
        candidates: result.candidates,
        candidateSetHmac: result.candidates.length > 0 ? candidateSetHmac(result.candidates, hmacSecret) : null
      };
    }
  };
}

async function requestStructuredAnalysis({ apiKey, model, timeoutMs, fetchImpl, bytes, mimeType, caption, signal }) {
  try {
    const response = await fetchImpl(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      signal: deadlineSignal(signal, timeoutMs),
      body: JSON.stringify({
        model,
        store: false,
        input: [
          { role: "system", content: "Extract personal expense evidence from one image. Return only JSON matching the schema. Never invent a currency, a date, or a paid total. Classify arbitrary/non-expense images as unknown and visible price tags as product_price; never treat a visible product price as a purchase. For purchase_photo, set paid_purchase_evidence true only for clear paid-purchase evidence. For bank history, mark only outgoing expenses debit; credits, transfers, and balances are not expenses. For receipts and bills, mark only the final paid total is_final_total true." },
          {
            role: "user",
            content: [
              { type: "input_text", text: `Optional user caption: ${String(caption).slice(0, 2000)}` },
              { type: "input_image", image_url: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}` }
            ]
          }
        ],
        text: { format: { type: "json_schema", name: "expense_evidence", strict: true, schema: evidenceSchema() } }
      })
    });
    const responseText = await response.text();
    if (!response.ok) throw analysisError();
    const output = JSON.parse(responseText);
    const outputText = extractOutputText(output);
    if (!outputText) throw analysisError();
    return JSON.parse(outputText);
  } catch (error) {
    if (error?.code === "analysis_failed") throw error;
    throw analysisError();
  }
}

function normalizeAnalysis(value, now, timeZone) {
  const evidenceType = EVIDENCE_TYPES.includes(value?.evidence_type) ? value.evidence_type : "unsupported";
  if (evidenceType === "unsupported" || !Array.isArray(value?.candidates)) return { evidenceType: "unsupported", candidates: [] };
  if (["product_price", "unknown"].includes(evidenceType)) return { evidenceType, candidates: [] };
  if (evidenceType === "purchase_photo") {
    const candidates = value.candidates
      .filter((candidate) => candidate?.paid_purchase_evidence === true)
      .map((candidate) => normalizeCandidate(candidate, now, timeZone))
      .filter(Boolean)
      .slice(0, 1)
      .map(asPurchaseReviewCandidate);
    return { evidenceType, candidates };
  }
  const rawCandidates = ["bank_transactions", "bank_history"].includes(evidenceType)
    ? value.candidates.filter((candidate) => candidate?.transaction_kind === "debit")
    : value.candidates;
  const candidates = rawCandidates.map((candidate) => normalizeCandidate(candidate, now, timeZone)).filter(Boolean);
  if (["receipt", "bill"].includes(evidenceType)) {
    const finalTotals = value.candidates
      .filter((candidate) => candidate?.is_final_total === true)
      .map((candidate) => normalizeCandidate(candidate, now, timeZone))
      .filter(Boolean);
    return { evidenceType, candidates: finalTotals.slice(0, 1) };
  }
  if (["order_confirmation", "payment_confirmation"].includes(evidenceType)) return { evidenceType, candidates: candidates.slice(0, 1) };
  return { evidenceType, candidates };
}

function normalizeCandidate(value, now, timeZone) {
  const amount = Number(value?.amount);
  const currency = String(value?.currency ?? "").toUpperCase();
  if (!Number.isFinite(amount) || amount <= 0 || !CURRENCIES.has(currency)) return null;
  const spentOn = normalizeDate(value.spent_on, now, timeZone);
  const categorySlug = CATEGORIES_BY_SLUG.has(value.category_slug) ? value.category_slug : "other";
  const confidence = clamp(Number(value.confidence));
  const description = String(value.description ?? "").trim() || "Expense";
  const merchant = normalizeMerchant(value.merchant);
  const spentAt = normalizeTime(value.spent_at);
  const invalidLocalDateTime = String(value.spent_at ?? "").trim() !== "" && !spentAt;
  const needsReview = Boolean(value.needs_review) || Boolean(value.uncertain) || !spentOn || invalidLocalDateTime || categorySlug === "other" || confidence < 0.7;
  return {
    amount,
    currency,
    spentOn,
    spentAt,
    ...(invalidLocalDateTime ? { invalidLocalDateTime: true } : {}),
    merchant,
    description,
    categorySlug,
    confidence,
    needsReview
  };
}

function asPurchaseReviewCandidate(candidate) {
  return { ...candidate, needsReview: true };
}

function normalizeDate(value, now, timeZone) {
  const text = String(value ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return isValidDateKey(text) ? text : null;
  if (!/^\d{2}-\d{2}$/.test(text)) return null;
  const [month, day] = text.split("-").map(Number);
  const currentKey = localDateKey(new Date(now), timeZone);
  let year = Number(currentKey.slice(0, 4));
  let candidateKey = `${year}-${pad2(month)}-${pad2(day)}`;
  if (!isValidDateKey(candidateKey)) return null;
  if (candidateKey > currentKey) {
    year -= 1;
    candidateKey = `${year}-${pad2(month)}-${pad2(day)}`;
  }
  const ageDays = (Date.parse(`${currentKey}T00:00:00Z`) - Date.parse(`${candidateKey}T00:00:00Z`)) / 86_400_000;
  return ageDays >= 0 && ageDays <= 45 ? candidateKey : null;
}

function normalizeTime(value) {
  const text = String(value ?? "");
  if (!/^\d{2}:\d{2}$/.test(text)) return null;
  const [hour, minute] = text.split(":").map(Number);
  return hour <= 23 && minute <= 59 ? text : null;
}

function isValidDateKey(value) {
  const [year, month, day] = value.split("-").map(Number);
  return month >= 1 && month <= 12 && day >= 1 && new Date(Date.UTC(year, month, 0)).getUTCDate() >= day;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function normalizeMerchant(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replaceAll(/\s+/g, " ").trim();
}

function candidateSetHmac(candidates, secret) {
  const canonical = candidates
    .map(({ amount, currency, spentOn, spentAt, merchant, description, categorySlug }) => ({ amount, currency, spentOn, spentAt, merchant, description: description.trim().toLowerCase(), categorySlug }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return crypto.createHmac("sha256", secret).update(JSON.stringify(canonical)).digest("hex");
}

function evidenceSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      evidence_type: { type: "string", enum: EVIDENCE_TYPES },
      candidates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            amount: { type: "number" }, currency: { type: "string", enum: SUPPORTED_CURRENCY_CODES },
            spent_on: { type: ["string", "null"] }, spent_at: { type: ["string", "null"] }, merchant: { type: "string" }, description: { type: "string" },
            category_slug: { type: "string", enum: [...CATEGORIES_BY_SLUG] }, confidence: { type: "number" }, needs_review: { type: "boolean" }, uncertain: { type: "boolean" },
            paid_purchase_evidence: { type: "boolean" }, transaction_kind: { type: "string", enum: ["debit", "credit", "transfer", "balance", "unknown"] }, is_final_total: { type: "boolean" }
          },
          required: ["amount", "currency", "spent_on", "spent_at", "merchant", "description", "category_slug", "confidence", "needs_review", "uncertain", "paid_purchase_evidence", "transaction_kind", "is_final_total"]
        }
      }
    },
    required: ["evidence_type", "candidates"]
  };
}

function extractOutputText(body) {
  if (typeof body?.output_text === "string") return body.output_text;
  return (body?.output ?? []).flatMap((item) => item.content ?? []).filter((content) => content.type === "output_text").map((content) => content.text).join("");
}

function clamp(value) { return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }

function analysisError() { const error = new Error("analysis_failed"); error.code = "analysis_failed"; return error; }
