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
  const fastPathMode = normalizeFastPathMode(options.fastPathMode);

  return {
    model: apiKey ? model : "local-parser",

    async parse(text, parseOptions = {}) {
      const defaultCurrency = normalizeCurrency(parseOptions.defaultCurrency, "THB");
      const timeZone = parseOptions.timeZone ?? "Asia/Bangkok";
      const shouldRunLocalFastPath = fastPathMode === "enabled" || fastPathMode === "shadow";
      const localResult = shouldRunLocalFastPath || !apiKey || !fetchImpl
        ? parseExpenseText(text, { now: now(), defaultCurrency, timeZone })
        : null;
      const localFastPath = localResult
        ? evaluateLocalFastPath({ text, localResult })
        : {
            accepted: false,
            rejectReason: null,
            categoryResolution: null
          };

      if (!apiKey || !fetchImpl) {
        parseOptions.onLlmTrace?.({
          parserEngine: "local-fallback",
          localFastPathAccepted: localFastPath.accepted,
          localFastPathRejectReason: localFastPath.rejectReason,
          categoryResolution: localFastPath.categoryResolution,
          llmSkipped: true,
          fastPathMode,
          shadowDisagreement: null,
          shadowDisagreementFields: [],
          model: "local-parser",
          promptChars: String(text ?? "").length,
          responseChars: JSON.stringify(localResult).length
        });
        return localResult;
      }

      if (fastPathMode === "enabled" && localFastPath.accepted) {
        parseOptions.onLlmTrace?.({
          parserEngine: "local-fast-path",
          localFastPathAccepted: true,
          localFastPathRejectReason: null,
          categoryResolution: localFastPath.categoryResolution,
          llmSkipped: true,
          fastPathMode,
          shadowDisagreement: null,
          shadowDisagreementFields: [],
          model: "local-parser",
          promptChars: String(text ?? "").length,
          responseChars: JSON.stringify(localResult).length
        });
        return localResult;
      }

      try {
        const parsed = await parseWithOpenAI({ text, apiKey, model, fetchImpl, now: now(), defaultCurrency, timeZone });
        const shadowFields = fastPathMode === "shadow" && localFastPath.accepted
          ? compareParseResults(localResult, parsed.result)
          : [];
        parseOptions.onLlmTrace?.({
          ...parsed.metadata,
          parserEngine: "llm",
          localFastPathAccepted: localFastPath.accepted,
          localFastPathRejectReason: localFastPath.rejectReason,
          categoryResolution: localFastPath.categoryResolution,
          llmSkipped: false,
          fastPathMode,
          shadowDisagreement: fastPathMode === "shadow" && localFastPath.accepted ? shadowFields.length > 0 : null,
          shadowDisagreementFields: shadowFields
        });
        return parsed.result;
      } catch (error) {
        console.error("[expense-parser] OpenAI parser failed, using local parser", error.message);
        const fallback = localResult ?? parseExpenseText(text, { now: now(), defaultCurrency, timeZone });
        parseOptions.onLlmTrace?.({
          parserEngine: "local-fallback",
          localFastPathAccepted: localFastPath.accepted,
          localFastPathRejectReason: localFastPath.rejectReason,
          categoryResolution: localFastPath.categoryResolution,
          llmSkipped: false,
          fastPathMode,
          shadowDisagreement: null,
          shadowDisagreementFields: [],
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

export function evaluateLocalFastPath({ text, localResult }) {
  const stopReason = detectStopPatternReason(text);
  if (stopReason) {
    return {
      accepted: false,
      rejectReason: stopReason,
      categoryResolution: null
    };
  }

  if (!localResult?.expenses?.length) {
    return {
      accepted: false,
      rejectReason: looksLikeAmountMappingProblem(text) ? "amount_mapping" : "no_amount",
      categoryResolution: null
    };
  }

  const hasUnsafeExpense = localResult.expenses.some((expense) =>
    !Number.isFinite(Number(expense.amount)) || Number(expense.amount) <= 0 || !expense.currency || !expense.spent_at
  );
  if (hasUnsafeExpense) {
    return {
      accepted: false,
      rejectReason: "amount_mapping",
      categoryResolution: null
    };
  }

  const needsReview = localResult.expenses.some((expense) => expense.category_slug === "other" || expense.needs_review);
  return {
    accepted: true,
    rejectReason: null,
    categoryResolution: needsReview ? "needs_user_review" : "resolved"
  };
}

async function parseWithOpenAI({ text, apiKey, model, fetchImpl, now, defaultCurrency, timeZone }) {
  const systemPrompt = buildSystemPrompt(now, defaultCurrency, timeZone);
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

function buildSystemPrompt(now, defaultCurrency = "THB", timeZone = "Asia/Bangkok") {
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
    `Current timestamp: ${now.toISOString()}. User timezone for expense timestamps: ${timeZone}.`
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
    category_source: "parser",
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

function normalizeFastPathMode(value) {
  return ["off", "shadow", "enabled"].includes(value) ? value : "off";
}

function detectStopPatternReason(text) {
  const normalized = normalizeText(text);
  if (matchesAny(normalized, [
    "половину", "пополам", "на двоих", "на троих", "за девушку", "за друга",
    "за меня", "отдельно", "каждый по", "скинулись", "в долг", "вернул",
    "должен", "занял", "одолжил", "half", "split", "shared", "separately",
    "each paid", "for my girlfriend", "for girlfriend", "for my friend",
    "for me", "owe", "owed", "debt", "borrowed", "lent", "paid back",
    "payback", "refund"
  ])) {
    return "split_semantics";
  }

  if (matchesAny(normalized, [
    "не учитывать", "без бюджета", "вне бюджета", "не считать", "размажь",
    "раздели на", "рассрочка", "в месяц", "подписка на год", "за год",
    "предоплата", "аванс", "do not count", "don't count", "out of budget",
    "outside budget", "exclude from budget", "spread over", "split across",
    "installment", "instalment", "per month", "yearly subscription",
    "annual subscription", "prepaid", "advance payment"
  ]) || /(?<![\p{L}\p{N}])(?:на|over)\s+\d+\s+(?:месяц|месяца|месяцев|months)(?![\p{L}\p{N}])/iu.test(normalized)) {
    return "budget_semantics";
  }

  if (matchesAny(normalized, ["на дату", "due on"])
    || /(?<![\p{L}\p{N}])за\s+\d{1,2}\s+число(?![\p{L}\p{N}])/iu.test(normalized)
    || /(?<![\p{L}\p{N}])\d{1,2}-?го\s+числа(?![\p{L}\p{N}])/iu.test(normalized)
    || /(?<![\p{L}\p{N}])for the\s+\d{1,2}(?:st|nd|rd|th)?(?![\p{L}\p{N}])/iu.test(normalized)
    || /(?<![\p{L}\p{N}])on the\s+\d{1,2}(?:st|nd|rd|th)?(?![\p{L}\p{N}])/iu.test(normalized)
    || /\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?/u.test(normalized)
    || /\d{4}-\d{2}-\d{2}/u.test(normalized)) {
    return "explicit_date";
  }

  if (looksLikeAmountMappingProblem(normalized)) {
    return "amount_mapping";
  }

  return null;
}

function looksLikeAmountMappingProblem(text) {
  const normalized = normalizeText(text);
  return /\d+\s*[+xх]\s*\d+/iu.test(normalized)
    || /\d+\s+(?:за|for)\s+\d+/iu.test(normalized)
    || /\d+,\d{3}(?!\d)/u.test(normalized)
    || /(?<![\p{L}\p{N}])\d{1,2}(?:st|nd|rd|th)(?![\p{L}\p{N}])/iu.test(normalized);
}

function compareParseResults(localResult, llmResult) {
  const fields = [];
  const localExpenses = localResult?.expenses ?? [];
  const llmExpenses = llmResult?.expenses ?? [];
  if (localExpenses.length !== llmExpenses.length) fields.push("expense_count");

  const count = Math.min(localExpenses.length, llmExpenses.length);
  for (let index = 0; index < count; index += 1) {
    const local = localExpenses[index];
    const llm = llmExpenses[index];
    if (Number(local.amount) !== Number(llm.amount)) pushUnique(fields, "amount");
    if (local.currency !== llm.currency) pushUnique(fields, "currency");
    if (dateBucket(local.spent_at) !== dateBucket(llm.spent_at)) pushUnique(fields, "spent_at");
    if (local.category_slug !== llm.category_slug) pushUnique(fields, "category_slug");
  }
  return fields;
}

function dateBucket(value) {
  return String(value ?? "").slice(0, 10);
}

function pushUnique(values, value) {
  if (!values.includes(value)) values.push(value);
}

function matchesAny(text, phrases) {
  return phrases.some((phrase) => {
    const escaped = escapeRegExp(normalizeText(phrase)).replaceAll(/\\ /g, "\\s+");
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
  });
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
