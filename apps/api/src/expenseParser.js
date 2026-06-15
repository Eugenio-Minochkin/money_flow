import { parseExpenseText } from "../../../packages/shared/src/parser.js";
import { SUPPORTED_CURRENCY_CODES, normalizeCurrency } from "../../../packages/shared/src/currencies.js";
import { CATEGORIES } from "../../../packages/shared/src/categories.js";

const DEFAULT_MODEL = "gpt-4.1-mini";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const ALLOWED_CURRENCIES = new Set(SUPPORTED_CURRENCY_CODES);
const ALLOWED_CATEGORIES = new Set(CATEGORIES.map((category) => category.slug));

export function createExpenseParser(options = {}) {
  const apiKey = options.apiKey;
  const model = options.model ?? DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());

  return {
    model: apiKey ? model : "local-parser",

    async parse(text, parseOptions = {}) {
      const defaultCurrency = normalizeCurrency(parseOptions.defaultCurrency, "THB");
      if (!apiKey || !fetchImpl) {
        const result = parseExpenseText(text, { now: now(), defaultCurrency });
        parseOptions.onLlmTrace?.({
          model: "local-parser",
          promptChars: String(text ?? "").length,
          responseChars: JSON.stringify(result).length
        });
        return result;
      }

      try {
        const parsed = await parseWithOpenAI({ text, apiKey, model, fetchImpl, now: now(), defaultCurrency });
        parseOptions.onLlmTrace?.(parsed.metadata);
        return parsed.result;
      } catch (error) {
        console.error("[expense-parser] OpenAI parser failed, using local parser", error.message);
        const fallback = parseExpenseText(text, { now: now(), defaultCurrency });
        parseOptions.onLlmTrace?.({
          model,
          promptChars: String(text ?? "").length,
          responseChars: JSON.stringify(fallback).length,
          fallback: "local-parser"
        });
        return {
          ...fallback,
          notes: [...fallback.notes, "AI parser unavailable, used local parser."]
        };
      }
    }
  };
}

async function parseWithOpenAI({ text, apiKey, model, fetchImpl, now, defaultCurrency }) {
  const systemPrompt = buildSystemPrompt(now, defaultCurrency);
  const response = await fetchImpl(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: text
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "expense_parse_result",
          strict: true,
          schema: expenseParseSchema()
        }
      }
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI Responses API failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  const outputText = extractOutputText(body);
  if (!outputText) throw new Error("OpenAI response did not include output text");
  return {
    result: normalizeParseResult(JSON.parse(outputText), now, defaultCurrency),
    metadata: {
      model,
      promptChars: systemPrompt.length + String(text ?? "").length,
      responseChars: outputText.length
    }
  };
}

function buildSystemPrompt(now, defaultCurrency = "THB") {
  return [
    "You are an expense parser for a personal finance Telegram bot.",
    "Return only JSON that matches the schema.",
    "Extract one expense per purchase. Multiple expenses may appear in one message.",
    `Default currency is ${defaultCurrency} when the user does not specify a currency.`,
    "Understand compact thousands notation: 14k, 14к, 14 000 and 14000 all mean 14000.",
    `Supported currencies: ${SUPPORTED_CURRENCY_CODES.join(", ")}.`,
    `Use these category slugs only: ${[...ALLOWED_CATEGORIES].join(", ")}.`,
    "Category is the type of expense. Tags are context.",
    "Set budget_impact from explicit user wording:",
    "- planned when the user says: плановая, запланированная, из плана, planned.",
    "- large_oneoff when the user says: крупная, большая покупка, разовая крупная, large/big one-off purchase or expense.",
    "- regular otherwise.",
    "If category or description is unclear, set needs_review=true and confidence below 0.7.",
    "For relative dates and times, use the provided current timestamp and timezone.",
    `Current timestamp: ${now.toISOString()}. User timezone for expense timestamps: +07:00.`
  ].join("\n");
}

function expenseParseSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      expenses: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            amount: { type: "number" },
            currency: { type: "string", enum: SUPPORTED_CURRENCY_CODES },
            description: { type: "string" },
            category_slug: {
              type: "string",
              enum: [...ALLOWED_CATEGORIES]
            },
            tags: {
              type: "array",
              items: { type: "string" }
            },
            spent_at: { type: "string" },
            budget_impact: { type: "string", enum: ["regular", "planned", "large_oneoff"] },
            confidence: { type: "number" },
            needs_review: { type: "boolean" }
          },
          required: [
            "amount",
            "currency",
            "description",
            "category_slug",
            "tags",
            "spent_at",
            "budget_impact",
            "confidence",
            "needs_review"
          ]
        }
      },
      notes: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: ["expenses", "notes"]
  };
}

function extractOutputText(body) {
  if (typeof body.output_text === "string") return body.output_text;

  const textParts = [];
  for (const item of body.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        textParts.push(content.text);
      }
    }
  }
  return textParts.join("");
}

function normalizeParseResult(result, now, defaultCurrency = "THB") {
  const expenses = Array.isArray(result.expenses) ? result.expenses : [];
  return {
    expenses: expenses.map((expense) => normalizeExpense(expense, now, defaultCurrency)).filter(Boolean),
    notes: Array.isArray(result.notes) ? result.notes.map(String) : []
  };
}

function normalizeExpense(expense, now, defaultCurrency = "THB") {
  const amount = Number(expense.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const currency = ALLOWED_CURRENCIES.has(expense.currency) ? expense.currency : normalizeCurrency(expense.currency, defaultCurrency);
  const category = ALLOWED_CATEGORIES.has(expense.category_slug) ? expense.category_slug : "other";
  const confidence = clamp(Number(expense.confidence), 0, 1);

  return {
    amount,
    currency,
    description: String(expense.description || "расход").trim(),
    category_slug: category,
    tags: Array.isArray(expense.tags) ? expense.tags.map(String).filter(Boolean) : [],
    spent_at: normalizeSpentAt(expense.spent_at, now),
    budget_impact: ["regular", "planned", "large_oneoff"].includes(expense.budget_impact) ? expense.budget_impact : "regular",
    confidence,
    needs_review: Boolean(expense.needs_review) || category === "other" || confidence < 0.7
  };
}

function normalizeSpentAt(value, now) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? now.toISOString() : value;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
