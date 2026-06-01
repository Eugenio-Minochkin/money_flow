import { parseExpenseText } from "../../../packages/shared/src/parser.js";

const DEFAULT_MODEL = "gpt-4.1-mini";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const ALLOWED_CURRENCIES = new Set(["THB", "USD", "RUB"]);
const ALLOWED_CATEGORIES = new Set([
  "food_cafe",
  "groceries",
  "home",
  "transport",
  "health",
  "sport_activities",
  "gear",
  "travel",
  "subscriptions",
  "gifts_help",
  "entertainment",
  "other"
]);

export function createExpenseParser(options = {}) {
  const apiKey = options.apiKey;
  const model = options.model ?? DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());

  return {
    async parse(text) {
      if (!apiKey || !fetchImpl) {
        return parseExpenseText(text, { now: now() });
      }

      try {
        return await parseWithOpenAI({ text, apiKey, model, fetchImpl, now: now() });
      } catch (error) {
        console.error("[expense-parser] OpenAI parser failed, using local parser", error.message);
        const fallback = parseExpenseText(text, { now: now() });
        return {
          ...fallback,
          notes: [...fallback.notes, "AI parser unavailable, used local parser."]
        };
      }
    }
  };
}

async function parseWithOpenAI({ text, apiKey, model, fetchImpl, now }) {
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
          content: buildSystemPrompt(now)
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
  return normalizeParseResult(JSON.parse(outputText), now);
}

function buildSystemPrompt(now) {
  return [
    "You are an expense parser for a personal finance Telegram bot.",
    "Return only JSON that matches the schema.",
    "Extract one expense per purchase. Multiple expenses may appear in one message.",
    "Default currency is THB when the user does not specify a currency.",
    "Supported currencies: THB, USD, RUB.",
    "Use these category slugs only: food_cafe, groceries, home, transport, health, sport_activities, gear, travel, subscriptions, gifts_help, entertainment, other.",
    "Category is the type of expense. Tags are context.",
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
            currency: { type: "string", enum: ["THB", "USD", "RUB"] },
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

function normalizeParseResult(result, now) {
  const expenses = Array.isArray(result.expenses) ? result.expenses : [];
  return {
    expenses: expenses.map((expense) => normalizeExpense(expense, now)).filter(Boolean),
    notes: Array.isArray(result.notes) ? result.notes.map(String) : []
  };
}

function normalizeExpense(expense, now) {
  const amount = Number(expense.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const currency = ALLOWED_CURRENCIES.has(expense.currency) ? expense.currency : "THB";
  const category = ALLOWED_CATEGORIES.has(expense.category_slug) ? expense.category_slug : "other";
  const confidence = clamp(Number(expense.confidence), 0, 1);

  return {
    amount,
    currency,
    description: String(expense.description || "расход").trim(),
    category_slug: category,
    tags: Array.isArray(expense.tags) ? expense.tags.map(String).filter(Boolean) : [],
    spent_at: normalizeSpentAt(expense.spent_at, now),
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
