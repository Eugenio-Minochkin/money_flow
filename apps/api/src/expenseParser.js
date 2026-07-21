import crypto from "node:crypto";

import { parseExpenseText } from "../../../packages/shared/src/parser.js";
import { SUPPORTED_CURRENCY_CODES, normalizeCurrency } from "../../../packages/shared/src/currencies.js";
import { CATEGORIES } from "../../../packages/shared/src/categories.js";
import { localDateKey } from "../../../packages/shared/src/time.js";
import { normalizeRolloutPercent } from "./parserRollout.js";

const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_LLM_TIMEOUT_MS = 20_000;
const LLM_TIMEOUT_ERROR_CODE = "expense_parser_llm_timeout";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const ALLOWED_CURRENCIES = new Set(SUPPORTED_CURRENCY_CODES);
const ALLOWED_CATEGORIES = new Set(CATEGORIES.map((category) => category.slug));
const CRITICAL_SHADOW_FIELDS = new Set(["expense_count", "amount", "currency", "spent_at", "budget_impact"]);
const REVIEWABLE_SHADOW_FIELDS = new Set(["category_slug", "needs_review"]);

export function createExpenseParser(options = {}) {
  const apiKey = options.apiKey;
  const model = options.model ?? DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const localParser = options.localParser ?? parseExpenseText;
  const now = options.now ?? (() => new Date());
  const fastPathMode = normalizeFastPathMode(options.fastPathMode);
  const localFirstRolloutPercent = normalizeRolloutPercent(options.localFirstRolloutPercent);
  const localFirstUserIds = new Set((options.localFirstUserIds ?? []).map((id) => String(id)));
  const parserTextHashSecret = options.parserTextHashSecret ?? "";
  const maxLocalAmount = options.maxLocalAmount;
  const llmTimeoutMs = Number.isInteger(options.llmTimeoutMs) && options.llmTimeoutMs > 0
    ? options.llmTimeoutMs
    : DEFAULT_LLM_TIMEOUT_MS;
  const performanceNow = options.performanceNow ?? (() => performance.now());

  return {
    model: apiKey ? model : "local-parser",

    async parse(text, parseOptions = {}) {
      const parserStartedAt = performanceNow();
      const defaultCurrency = normalizeCurrency(parseOptions.defaultCurrency, "THB");
      const timeZone = parseOptions.timeZone ?? "Asia/Bangkok";
      const shouldRunLocalFastPath = fastPathMode === "enabled" || fastPathMode === "shadow";
      const inRollout = fastPathMode === "enabled"
        ? isInLocalFirstRollout({
            userId: parseOptions.userId,
            percent: localFirstRolloutPercent,
            allowlist: localFirstUserIds,
            secret: parserTextHashSecret
          })
        : false;
      let localResult = null;
      let localFastPath = {
        accepted: false,
        rejectReason: null,
        categoryResolution: null
      };
      let localParserError = null;
      let localEvaluationCompleted = false;
      let localParseMs;
      let localEvaluateMs;
      const emitTrace = (metadata) => parseOptions.onLlmTrace?.({
        ...metadata,
        ...(Number.isFinite(localParseMs) ? { localParseMs } : {}),
        ...(Number.isFinite(localEvaluateMs) ? { localEvaluateMs } : {}),
        parserTotalMs: elapsedMs(performanceNow, parserStartedAt)
      });
      if (shouldRunLocalFastPath || !apiKey || !fetchImpl) {
        const localParseStartedAt = performanceNow();
        try {
          localResult = localParser(text, { now: now(), defaultCurrency, timeZone, maxLocalAmount });
        } catch (error) {
          localParserError = error;
          localFastPath = {
            accepted: false,
            rejectReason: "local_exception",
            categoryResolution: null
          };
        }
        localParseMs = elapsedMs(performanceNow, localParseStartedAt);
        if (!localParserError) {
          const localEvaluateStartedAt = performanceNow();
          try {
            localFastPath = evaluateLocalFastPath({ text, localResult });
            localEvaluationCompleted = true;
          } catch (error) {
            localParserError = error;
            localFastPath = {
              accepted: false,
              rejectReason: "local_exception",
              categoryResolution: null
            };
          }
          localEvaluateMs = elapsedMs(performanceNow, localEvaluateStartedAt);
        }
      }

      if (!apiKey || !fetchImpl) {
        if (localParserError) throw localParserError;
        emitTrace({
          parserEngine: "local-fallback",
          parserRoute: "local_no_api_key",
          ...localEvaluationTraceMetadata({ localEvaluationCompleted, localFastPath, localResult }),
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

      if (fastPathMode === "enabled" && inRollout && isLocalPrimaryAcceptance(localFastPath.localAcceptanceLevel)) {
        emitTrace({
          parserEngine: "local-fast-path",
          parserRoute: "local_primary",
          ...localEvaluationTraceMetadata({ localEvaluationCompleted, localFastPath, localResult }),
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
        const parsed = await parseWithOpenAI({
          text, apiKey, model, fetchImpl, now: now(), defaultCurrency, timeZone, performanceNow, llmTimeoutMs
        });
        const parserRoute = resolveLlmParserRoute({ fastPathMode, inRollout, localFastPath, localParserError });
        const shouldCompareShadow = (fastPathMode === "shadow" || parserRoute === "rollout_excluded")
          && isLocalPrimaryAcceptance(localFastPath.localAcceptanceLevel);
        const shadowFields = shouldCompareShadow
          ? compareParseResults(localResult, parsed.result, timeZone)
          : [];
        const criticalShadowDisagreement = shouldCompareShadow
          ? shadowFields.some((field) => CRITICAL_SHADOW_FIELDS.has(field))
          : null;
        const categoryOnlyShadowDisagreement = shouldCompareShadow
          ? shadowFields.length > 0 && shadowFields.every((field) => REVIEWABLE_SHADOW_FIELDS.has(field))
          : null;
        emitTrace({
          ...parsed.metadata,
          parserEngine: "llm",
          parserRoute,
          fallbackReason: fallbackReasonForRoute(parserRoute, localFastPath),
          ...localEvaluationTraceMetadata({ localEvaluationCompleted, localFastPath, localResult }),
          llmSkipped: false,
          fastPathMode,
          shadowDisagreement: shouldCompareShadow ? shadowFields.length > 0 : null,
          criticalShadowDisagreement,
          categoryOnlyShadowDisagreement,
          shadowDisagreementFields: shadowFields,
          ...localParserErrorMetadata(localParserError)
        });
        return parsed.result;
      } catch (error) {
        const fallbackReason = error?.code === LLM_TIMEOUT_ERROR_CODE
          ? LLM_TIMEOUT_ERROR_CODE
          : "llm_error";
        const llmTimingMetadata = Number.isFinite(error?.llmHttpMs)
          ? { llmHttpMs: error.llmHttpMs }
          : {};
        if (localFastPath.localAcceptanceLevel === "local_safe" && localResult) {
          emitTrace({
            ...llmTimingMetadata,
            parserEngine: "local-fallback",
            parserRoute: "llm_error_local_accepted_fallback",
            fallbackReason,
            ...localEvaluationTraceMetadata({ localEvaluationCompleted, localFastPath, localResult }),
            llmSkipped: false,
            fastPathMode,
            shadowDisagreement: null,
            shadowDisagreementFields: [],
            model: "local-parser",
            promptChars: String(text ?? "").length,
            responseChars: JSON.stringify(localResult).length
          });
          return localResult;
        }
        emitTrace({
          ...llmTimingMetadata,
          parserEngine: "llm",
          parserRoute: "llm_error",
          fallbackReason,
          ...localEvaluationTraceMetadata({ localEvaluationCompleted, localFastPath, localResult }),
          llmSkipped: false,
          fastPathMode,
          shadowDisagreement: null,
          shadowDisagreementFields: [],
          model,
          promptChars: String(text ?? "").length,
          responseChars: 0
        });
        throw error;
      }
    }
  };
}

export function isInLocalFirstRollout({ userId, percent = 0, allowlist = new Set(), secret = "" }) {
  const key = String(userId ?? "");
  if (key && allowlist.has(key)) return true;
  const rolloutPercent = normalizeRolloutPercent(percent);
  if (rolloutPercent <= 0 || !key || !secret) return false;
  if (rolloutPercent >= 100) return true;
  return rolloutBucket(key, secret) < rolloutPercent;
}

export function rolloutBucket(userId, secret) {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(`rollout:${userId}`)
    .digest("hex");
  return parseInt(digest.slice(0, 8), 16) % 100;
}

export function evaluateLocalFastPath({ text, localResult }) {
  const stopReason = detectStopPatternReason(text);
  if (stopReason) {
    return {
      accepted: false,
      rejectReason: stopReason,
      categoryResolution: null,
      localAcceptanceLevel: "local_rejected"
    };
  }

  if (!localResult?.expenses?.length) {
    return {
      accepted: false,
      rejectReason: localResult?.reject_reason
        ?? (looksLikeAmountMappingProblem(text) ? "unsafe_split_or_mapping" : "no_amount_token"),
      categoryResolution: null,
      localAcceptanceLevel: "local_rejected"
    };
  }

  const hasUnsafeExpense = localResult.expenses.some((expense) =>
    !Number.isFinite(Number(expense.amount)) || Number(expense.amount) <= 0 || !expense.currency || !expense.spent_at
  );
  if (hasUnsafeExpense) {
    return {
      accepted: false,
      rejectReason: "unsafe_split_or_mapping",
      categoryResolution: null,
      localAcceptanceLevel: "local_rejected"
    };
  }

  const needsReview = localResult.expenses.some((expense) => expense.category_slug === "other" || expense.needs_review);
  return {
    accepted: true,
    rejectReason: null,
    categoryResolution: needsReview ? "needs_user_review" : "resolved",
    localAcceptanceLevel: needsReview ? "local_reviewable" : "local_safe"
  };
}

function isLocalPrimaryAcceptance(level) {
  return level === "local_safe" || level === "local_reviewable";
}

async function parseWithOpenAI({
  text,
  apiKey,
  model,
  fetchImpl,
  now,
  defaultCurrency,
  timeZone,
  performanceNow,
  llmTimeoutMs
}) {
  const systemPrompt = buildSystemPrompt(now, defaultCurrency, timeZone);
  const llmHttpStartedAt = performanceNow();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), llmTimeoutMs);
  let response;
  let responseText;
  try {
    response = await fetchImpl(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      signal: controller.signal,
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
    responseText = await response.text();
  } catch (error) {
    const llmHttpMs = elapsedMs(performanceNow, llmHttpStartedAt);
    if (controller.signal.aborted) {
      const timeoutError = new Error("Expense parser LLM request timed out");
      timeoutError.code = LLM_TIMEOUT_ERROR_CODE;
      timeoutError.llmHttpMs = llmHttpMs;
      throw timeoutError;
    }
    error.llmHttpMs = llmHttpMs;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const llmHttpMs = elapsedMs(performanceNow, llmHttpStartedAt);

  if (!response.ok) {
    const error = new Error(`OpenAI Responses API failed with status ${response.status}`);
    error.llmHttpMs = llmHttpMs;
    throw error;
  }

  const decodeStartedAt = performanceNow();
  const body = JSON.parse(responseText);
  const outputText = extractOutputText(body);
  if (!outputText) throw new Error("OpenAI response did not include output text");
  const result = normalizeParseResult(JSON.parse(outputText), now, defaultCurrency);
  const llmDecodeNormalizeMs = elapsedMs(performanceNow, decodeStartedAt);
  return {
    result,
    metadata: {
      model,
      promptChars: systemPrompt.length + String(text ?? "").length,
      responseChars: outputText.length,
      llmHttpMs,
      llmDecodeNormalizeMs
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

function elapsedMs(performanceNow, startedAt) {
  return Math.max(0, performanceNow() - startedAt);
}

function hasLocalCandidate(result) {
  return Array.isArray(result?.expenses) && result.expenses.length > 0;
}

function localEvaluationTraceMetadata({ localEvaluationCompleted, localFastPath, localResult }) {
  if (!localEvaluationCompleted) {
    return localFastPath.rejectReason
      ? { localFastPathRejectReason: localFastPath.rejectReason }
      : {};
  }
  return {
    localFastPathAccepted: localFastPath.accepted,
    localFastPathRejectReason: localFastPath.rejectReason,
    categoryResolution: localFastPath.categoryResolution,
    localAcceptanceLevel: localFastPath.localAcceptanceLevel,
    localCandidate: hasLocalCandidate(localResult)
  };
}

function normalizeFastPathMode(value) {
  return ["off", "shadow", "enabled"].includes(value) ? value : "off";
}

function resolveLlmParserRoute({ fastPathMode, inRollout, localFastPath, localParserError }) {
  if (localParserError) return "local_exception_fallback";
  if (fastPathMode !== "enabled") return "llm_primary";
  if (!inRollout) return "rollout_excluded";
  if (!isLocalPrimaryAcceptance(localFastPath.localAcceptanceLevel)) return "local_rejected_fallback";
  return "llm_primary";
}

function fallbackReasonForRoute(parserRoute, localFastPath) {
  if (parserRoute === "local_rejected_fallback") return localFastPath.rejectReason;
  if (parserRoute === "local_exception_fallback") return "local_exception";
  return null;
}

function localParserErrorMetadata(error) {
  if (!error) return {};
  return {
    localParserErrorName: String(error.name || "Error").slice(0, 80)
  };
}

function detectStopPatternReason(text) {
  const normalized = normalizeText(text);
  if (matchesAny(normalized, [
    "переведи", "перевел", "перевела", "перевести",
    "перевод денег",
    "пополнение бюджета", "пополни бюджет", "пополнил бюджет", "пополнила бюджет",
    "положил в бюджет", "положила в бюджет", "положить в бюджет",
    "запланируй", "запланировал", "запланировала",
    "отложи", "отложил", "отложила", "резерв",
    "transfer", "top up the budget", "budget top up", "plan a payment", "planned payment", "set aside", "reserve"
  ])
    || /(?<![\p{L}\p{N}])send(?:\s+money)?\s+\d+(?![\p{L}\p{N}])/iu.test(normalized)
    || /(?<![\p{L}\p{N}])(?:перевод(?:а|у|ом|ы|ов)?|планов(?:ый|ая|ое|ую|ого|ому|ые|ых))(?![\p{L}\p{N}])/iu.test(normalized)
    || /(?<![\p{L}\p{N}])put\s+\d+(?:[\d\s.,]*)(?:\s+\w+)?\s+into\s+(?:the\s+)?budget(?![\p{L}\p{N}])/iu.test(normalized)) {
    return "unsupported_intent";
  }

  if (matchesAny(normalized, [
    "половину", "пополам", "на двоих", "на троих", "за девушку", "за друга",
    "за меня", "отдельно", "каждый по", "скинулись", "в долг", "вернул",
    "должен", "занял", "одолжил", "half", "split", "shared", "separately",
    "each paid", "for my girlfriend", "for girlfriend", "for my friend",
    "for me", "owe", "owed", "debt", "borrowed", "lent", "paid back",
    "payback", "refund"
  ]) || /(?<![\p{L}\p{N}])(?:возврат(?:а|у|ом|ы|ов)?|долг(?:а|у|ом|и|ов)?)(?![\p{L}\p{N}])/iu.test(normalized)) {
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
    || /(?<![\p{L}\p{N}.])\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?(?![\p{L}\p{N}.])/u.test(normalized)
    || /\d{4}-\d{2}-\d{2}/u.test(normalized)) {
    return "explicit_date";
  }

  if (looksLikeAmountMappingProblem(normalized)) {
    return "unsafe_split_or_mapping";
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

function compareParseResults(localResult, llmResult, timeZone) {
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
    if (dateBucket(local.spent_at, timeZone) !== dateBucket(llm.spent_at, timeZone)) pushUnique(fields, "spent_at");
    if ((local.budget_impact ?? "regular") !== (llm.budget_impact ?? "regular")) pushUnique(fields, "budget_impact");
    if (local.category_slug !== llm.category_slug) pushUnique(fields, "category_slug");
    if (Boolean(local.needs_review) !== Boolean(llm.needs_review)) pushUnique(fields, "needs_review");
  }
  return fields;
}

function dateBucket(value, timeZone) {
  return localDateKey(new Date(value), timeZone);
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
