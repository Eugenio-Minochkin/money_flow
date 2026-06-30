import { parseExpenseText } from "./parser.js";
import { localDateKey, localMonthKey, normalizeTimeZone } from "./time.js";

const TOPUP_INTENT_PATTERNS = [
  /\b(add|increase)\b[\s\S]*\bbudget\b/iu,
  /\btop\s*up\b[\s\S]*\bbudget\b/iu,
  /\bbudget\b[\s\S]*\btop\s*up\b/iu,
  /\b(i\s+got|got|received|got\s+paid|bonus|refund|returned)\b/iu,
  /(?<![\p{L}\p{N}])добав(?:ь|ить|ил|ила|или)?(?![\p{L}\p{N}])[\s\S]*бюджет/iu,
  /(?<![\p{L}\p{N}])пополни(?:ть|л|ла|ли)?(?![\p{L}\p{N}])[\s\S]*бюджет/iu,
  /(?<![\p{L}\p{N}])пришл[аои]?(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])преми[яю](?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])вернул[аи]?(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])получил[аи]?(?![\p{L}\p{N}])/iu
];

const TRANSFER_OR_ACCOUNT_PATTERNS = [
  /\b(card|account|savings account|transfer(?:red)?|moved|withdrew|put)\b/iu,
  /(?<![\p{L}\p{N}])(?:счет|счёт|карт[ауые]?|накопительн\p{L}*|перев[её]л|переложил|снял|закинул)(?![\p{L}\p{N}])/iu
];

const TOPUP_WORDS_TO_REMOVE = [
  "add",
  "increase",
  "budget",
  "top up",
  "top-up",
  "my",
  "the",
  "this month",
  "to",
  "by",
  "i got",
  "got",
  "received",
  "got paid",
  "bonus",
  "refund",
  "returned",
  "they",
  "добавь",
  "добавить",
  "добавил",
  "добавила",
  "к бюджету",
  "в бюджет",
  "бюджет",
  "пополни",
  "пополнить",
  "на",
  "пришло",
  "пришла",
  "пришли",
  "премия",
  "вернули",
  "вернул",
  "вернула",
  "получил",
  "получила"
];

export function parseBudgetTopupText(text, options = {}) {
  const source = String(text ?? "").trim();
  if (!source) return { state: "not_recognized" };
  if (looksLikeTransferOrAccount(source)) return { state: "not_recognized" };
  if (!looksLikeBudgetTopup(source)) return { state: "not_recognized" };

  const timeZone = normalizeTimeZone(options.timeZone).timeZone;
  const parsed = parseExpenseText(sanitizeForMoneyParse(source), {
    now: options.now ?? new Date(),
    defaultCurrency: options.defaultCurrency ?? "THB",
    timeZone
  });
  const expense = parsed.expenses?.[0];
  if (parsed.expenses?.length !== 1 || !expense) {
    return { state: "failed", reason: "amount_not_found" };
  }

  const occurredAt = new Date(expense.spent_at);
  if (!Number.isFinite(occurredAt.getTime())) {
    return { state: "failed", reason: "date_invalid" };
  }

  return {
    state: "recognized",
    item: {
      amount: expense.amount,
      currency: expense.currency,
      note: topupNote(source),
      kind: topupKind(source),
      occurred_at: occurredAt.toISOString(),
      local_date: localDateKey(occurredAt, timeZone),
      month_key: localMonthKey(occurredAt, timeZone)
    }
  };
}

function looksLikeBudgetTopup(text) {
  return TOPUP_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

function looksLikeTransferOrAccount(text) {
  return TRANSFER_OR_ACCOUNT_PATTERNS.some((pattern) => pattern.test(text));
}

function topupKind(text) {
  if (/\b(bonus|salary|got\s+paid)\b|(?<![\p{L}\p{N}])преми[яю](?![\p{L}\p{N}])|(?<![\p{L}\p{N}])зарплат/iu.test(text)) return "income";
  if (/\b(refund|returned)\b|(?<![\p{L}\p{N}])вернул[аи]?(?![\p{L}\p{N}])/iu.test(text)) return "refund";
  return "other";
}

function sanitizeForMoneyParse(text) {
  return String(text ?? "")
    .replace(/\s+к\s+бюджет[ау]?(?![\p{L}\p{N}])/giu, " ")
    .replace(/\s+в\s+бюджет(?![\p{L}\p{N}])/giu, " ")
    .replace(/\s+to\s+(?:my\s+|the\s+)?budget\b/giu, " ")
    .replace(/\s+to\s+this\s+month'?s\s+budget\b/giu, " ");
}

function topupNote(text) {
  let note = String(text ?? "").toLowerCase().replaceAll("ё", "е");
  for (const word of TOPUP_WORDS_TO_REMOVE) {
    note = note.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, "giu"), " ");
  }
  note = note
    .replace(/[$฿₽€₾]?\s*\d[\d\s\u00a0.,]*[kк]?\s*[$฿₽€₾]?/giu, " ")
    .replace(/\b(baht|thb|usd|dollar|dollars|бат|бата|батов|доллар|долларов)\b/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return note || null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
