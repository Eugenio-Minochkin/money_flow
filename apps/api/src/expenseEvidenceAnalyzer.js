import crypto from "node:crypto";

import { CATEGORIES } from "../../../packages/shared/src/categories.js";
import { SUPPORTED_CURRENCY_CODES } from "../../../packages/shared/src/currencies.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const EVIDENCE_TYPES = ["bank_transactions", "receipt", "order_confirmation", "payment_confirmation", "unsupported"];
const CATEGORIES_BY_SLUG = new Set(CATEGORIES.map((category) => category.slug));
const CURRENCIES = new Set(SUPPORTED_CURRENCY_CODES);

export function createExpenseEvidenceAnalyzer({
  apiKey,
  model = "gpt-5-mini",
  hmacSecret,
  timeoutMs = 30_000,
  fetchImpl = globalThis.fetch,
  now = () => new Date()
} = {}) {
  return {
    model: apiKey ? model : null,
    async analyze({ bytes, mimeType, caption = "" }) {
      if (!apiKey || !fetchImpl || !hmacSecret) throw analysisError();
      const response = await requestStructuredAnalysis({ apiKey, model, timeoutMs, fetchImpl, bytes, mimeType, caption });
      const result = normalizeAnalysis(response, now());
      return {
        evidenceType: result.evidenceType,
        candidates: result.candidates,
        candidateSetHmac: result.candidates.length > 0 ? candidateSetHmac(result.candidates, hmacSecret) : null
      };
    }
  };
}

async function requestStructuredAnalysis({ apiKey, model, timeoutMs, fetchImpl, bytes, mimeType, caption }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        store: false,
        input: [
          { role: "system", content: "Extract personal expense evidence from one image. Return only JSON matching the schema. Never invent a currency, a date, or a paid total." },
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
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeAnalysis(value, now) {
  const evidenceType = EVIDENCE_TYPES.includes(value?.evidence_type) ? value.evidence_type : "unsupported";
  if (evidenceType === "unsupported" || !Array.isArray(value?.candidates)) return { evidenceType: "unsupported", candidates: [] };
  const candidates = value.candidates.map((candidate) => normalizeCandidate(candidate, now)).filter(Boolean);
  if (["receipt", "order_confirmation", "payment_confirmation"].includes(evidenceType)) return { evidenceType, candidates: candidates.slice(0, 1) };
  return { evidenceType, candidates };
}

function normalizeCandidate(value, now) {
  const amount = Number(value?.amount);
  const currency = String(value?.currency ?? "").toUpperCase();
  if (!Number.isFinite(amount) || amount <= 0 || !CURRENCIES.has(currency)) return null;
  const spentOn = normalizeDate(value.spent_on, now);
  const categorySlug = CATEGORIES_BY_SLUG.has(value.category_slug) ? value.category_slug : "other";
  const confidence = clamp(Number(value.confidence));
  const description = String(value.description ?? "").trim() || "Expense";
  const merchant = normalizeMerchant(value.merchant);
  const needsReview = Boolean(value.needs_review) || Boolean(value.uncertain) || !spentOn || categorySlug === "other" || confidence < 0.7;
  return {
    amount,
    currency,
    spentOn,
    spentAt: normalizeTime(value.spent_at),
    merchant,
    description,
    categorySlug,
    confidence,
    needsReview
  };
}

function normalizeDate(value, now) {
  const text = String(value ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(new Date(`${text}T00:00:00Z`).getTime())) return text;
  if (!/^\d{2}-\d{2}$/.test(text)) return null;
  const [month, day] = text.split("-").map(Number);
  const current = new Date(now);
  const candidate = new Date(Date.UTC(current.getUTCFullYear(), month - 1, day));
  if (candidate > current) candidate.setUTCFullYear(candidate.getUTCFullYear() - 1);
  const ageDays = (current.getTime() - candidate.getTime()) / 86_400_000;
  if (ageDays < 0 || ageDays > 45 || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null;
  return candidate.toISOString().slice(0, 10);
}

function normalizeTime(value) {
  const text = String(value ?? "");
  return /^\d{2}:\d{2}$/.test(text) ? text : null;
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
            category_slug: { type: "string", enum: [...CATEGORIES_BY_SLUG] }, confidence: { type: "number" }, needs_review: { type: "boolean" }, uncertain: { type: "boolean" }
          },
          required: ["amount", "currency", "spent_on", "spent_at", "merchant", "description", "category_slug", "confidence", "needs_review", "uncertain"]
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
