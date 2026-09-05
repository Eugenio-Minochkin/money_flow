import { inferCategory, inferTags } from "./categories.js";
import { currencyRecognitionAliases, normalizeCurrency, recognizeCurrencyText } from "./currencies.js";
import { toZonedIso } from "./time.js";

const DEFAULT_MAX_LOCAL_AMOUNT = 1_000_000;

const SYMBOL_CURRENCIES = new Set(["$", "฿", "₽", "€", "₾", "¥", "₹"]);
const DATE_WORDS = [
  "сегодня",
  "вчера",
  "позавчера",
  "утром",
  "днем",
  "днём",
  "вечером",
  "ночью",
  "today",
  "yesterday",
  "day before yesterday"
];

export function parseExpenseText(text, options = {}) {
  const now = options.now ?? new Date();
  const defaultCurrency = normalizeCurrency(options.defaultCurrency, "THB");
  const timeZone = options.timeZone ?? "Asia/Bangkok";
  const maxLocalAmount = normalizeMaxLocalAmount(options.maxLocalAmount);
  const parts = splitExpenseParts(trimTrailingPunctuation(text));

  const expenses = [];
  for (const part of parts) {
    const normalizedPart = normalizePartAmountWords(part);
    const rejectReason = diagnosePartRejectReason(part, normalizedPart, maxLocalAmount, defaultCurrency);
    if (rejectReason) return rejectedParse(rejectReason);
    const parsed = parsePart(
      normalizedPart,
      now,
      defaultCurrency,
      timeZone,
      maxLocalAmount,
      parts.length > 1
    );
    if (!parsed) {
      return rejectedParse(parts.length > 1 ? "unsafe_split_or_mapping" : "unsupported_amount_shape");
    }
    expenses.push(parsed);
  }

  return {
    expenses,
    notes: expenses.length === 0 ? ["Не удалось найти сумму расхода."] : []
  };
}

function rejectedParse(rejectReason) {
  return {
    expenses: [],
    notes: [rejectReason === "no_amount_token"
      ? "Не удалось найти сумму расхода."
      : "Не удалось безопасно разобрать сумму расхода."],
    reject_reason: rejectReason
  };
}

function diagnosePartRejectReason(originalPart, normalizedPart, maxLocalAmount, defaultCurrency) {
  if (hasUnsafeAmountSyntax(normalizedPart)) return "unsafe_split_or_mapping";
  if (hasNumericAmountCandidate(originalPart) && containsRussianAmountWordSequence(originalPart)) {
    return "multiple_amounts_ambiguous";
  }

  const matches = findAmountMatches(normalizedPart);
  if (matches.some((match) => match.invalid)) return "unsupported_amount_shape";
  if (matches.length > 1) return "multiple_amounts_ambiguous";
  if (matches.length === 0) {
    return containsRussianNumberWord(originalPart) ? "unsupported_number_words" : "no_amount_token";
  }

  const match = matches[0];
  const amount = normalizeAmount(match.rawAmount, match.multiplier);
  if (!Number.isFinite(amount) || amount <= 0) return "unsupported_amount_shape";
  if (amount > maxLocalAmount) return "amount_over_limit";
  if (isSmallBareIntegerWithoutCurrency(normalizedPart, match)) return "small_bare_integer";
  if (resolveCurrency(normalizedPart, match, defaultCurrency).kind === "conflict") return "unsafe_split_or_mapping";
  return null;
}

function splitExpenseParts(text) {
  return splitExpensePartsForVoice(text);
}

function splitExpensePartsForVoice(text) {
  const source = String(text ?? "");
  const rawParts = [];
  const pattern = /((?<!\d)[,;]+|[,;]+(?!\d)|\n+|\s+и\s+|\s+and\s+)/giu;
  let lastIndex = 0;
  for (const match of source.matchAll(pattern)) {
    rawParts.push({
      text: trimTrailingPunctuation(source.slice(lastIndex, match.index).trim()),
      separator: match[0]
    });
    lastIndex = match.index + match[0].length;
  }
  rawParts.push({
    text: trimTrailingPunctuation(source.slice(lastIndex).trim()),
    separator: ""
  });

  const merged = [];
  for (const part of rawParts.filter((item) => item.text)) {
    const previous = merged.at(-1);
    if (previous
      && /[,;]/u.test(previous.separator)
      && !hasNumericAmountCandidate(previous.text)
      && startsWithAmountLike(part.text)) {
      previous.text = `${previous.text} ${part.text}`.trim();
      previous.separator = part.separator;
    } else if (previous
      && /[,;]/u.test(previous.separator)
      && hasNumericAmountCandidate(previous.text)
      && isCurrencyOnlyPart(part.text)) {
      previous.text = `${previous.text} ${part.text}`.trim();
      previous.separator = part.separator;
    } else {
      merged.push({ ...part });
    }
  }

  return merged.map((part) => trimTrailingPunctuation(part.text.trim())).filter(Boolean);
}

function parsePart(part, now, defaultCurrency, timeZone, maxLocalAmount, requireMeaningfulDescription = false) {
  if (hasUnsafeAmountSyntax(part)) return null;

  const amountMatches = findAmountMatches(part);
  if (amountMatches.length !== 1) return null;

  const amountMatch = amountMatches[0];
  if (amountMatch.invalid) return null;
  const amount = normalizeAmount(amountMatch.rawAmount, amountMatch.multiplier);
  if (!Number.isFinite(amount) || amount <= 0 || amount > maxLocalAmount) return null;

  const currencyResolution = resolveCurrency(part, amountMatch, defaultCurrency);
  if (currencyResolution.kind === "conflict") return null;

  if (isSmallBareIntegerWithoutCurrency(part, amountMatch)) return null;

  const spentAt = resolveRelativeDate(part, now);
  const budgetImpact = detectBudgetImpact(part);
  const cleanedDescription = cleanDescription(
    `${part.slice(0, amountMatch.start)} ${part.slice(amountMatch.end)}`
  );
  if (requireMeaningfulDescription && !cleanedDescription) return null;
  const description = cleanedDescription || "расход";
  const category = inferCategory(description);
  const needsReview = category === "other";

  const expense = {
    amount,
    currency: currencyResolution.kind === "ambiguous" ? null : currencyResolution.code,
    description,
    category_slug: category,
    category_source: "parser",
    tags: inferTags(description),
    spent_at: toZonedIso(spentAt, timeZone),
    confidence: needsReview ? 0.62 : 0.86,
    needs_review: needsReview || currencyResolution.kind === "ambiguous"
  };
  if (currencyResolution.kind === "ambiguous") {
    expense.currency_candidates = currencyResolution.candidates;
    expense.review_reason = "currency_ambiguous";
    expense.confidence = 0.5;
  }
  if (budgetImpact !== "regular") expense.budget_impact = budgetImpact;
  return expense;
}

function findAmountMatches(part) {
  const matches = [];
  const pattern = /([$฿₽€₾])?\s*(\d[\d\s\u00a0.,]*)([kк](?=$|[\s.,;:!?…$฿₽€₾]))?\s*([$฿₽€₾])?/giu;
  for (const match of part.matchAll(pattern)) {
    const rawAmount = match[2].trim();
    if (!rawAmount || !amountShapeIsSupported(rawAmount)) {
      return [{ invalid: true }];
    }
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      rawAmount,
      multiplier: match[3],
      leadingSymbol: match[1],
      trailingSymbol: match[4]
    });
  }
  return matches;
}

function amountShapeIsSupported(value) {
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return true;
  if (/^\d{1,3}(?:[\s\u00a0]\d{3})+$/.test(text)) return true;
  if (/^\d{1,3}\.\d{3}$/.test(text)) return true;
  if (/^\d+\.\d{1,2}$/.test(text)) return !/^\d{1,3}\.\d{3}$/.test(text);
  if (/^\d+,\d{1,2}$/.test(text)) return true;
  return false;
}

function normalizeAmount(value, multiplier) {
  const text = String(value).trim();
  let numericText;
  if (/^\d{1,3}(?:[\s\u00a0]\d{3})+$/.test(text)) {
    numericText = text.replaceAll(/[\s\u00a0]/g, "");
  } else if (/^\d{1,3}\.\d{3}$/.test(text)) {
    numericText = text.replace(".", "");
  } else {
    numericText = text.replace(",", ".");
  }
  const numeric = Number(numericText);
  return multiplier ? numeric * 1000 : numeric;
}

function normalizeMaxLocalAmount(value) {
  const number = Number(value ?? DEFAULT_MAX_LOCAL_AMOUNT);
  return Number.isFinite(number) && number > 0 ? number : DEFAULT_MAX_LOCAL_AMOUNT;
}

function trimTrailingPunctuation(value) {
  return String(value ?? "").trim().replace(/[.!?…]+$/u, "").trim();
}

function hasNumericAmountCandidate(part) {
  return findAmountMatches(part).some((match) => !match.invalid);
}

function startsWithAmountLike(part) {
  const text = String(part ?? "").trim();
  if (/^\d/u.test(text)) return true;
  const tokens = tokenizeWords(text);
  const parsed = parseRussianNumberSequence(tokens, 0);
  return Boolean(parsed && isCurrencyAlias(tokens[parsed.nextIndex]));
}

function normalizePartAmountWords(part) {
  if (hasNumericAmountCandidate(part)) return part;
  const tokens = tokenizeWords(part);
  const output = [];
  for (let index = 0; index < tokens.length;) {
    if (!isRussianNumberWord(tokens[index])) {
      output.push(tokens[index]);
      index += 1;
      continue;
    }

    const end = contiguousRussianNumberEnd(tokens, index);
    const parsed = parseRussianNumberSequence(tokens, index, end);
    if (parsed && russianNumberSpanLooksLikeAmount(tokens, index, parsed.nextIndex)) {
      output.push(String(parsed.value));
      index = parsed.nextIndex;
    } else {
      output.push(...tokens.slice(index, end));
      index = end;
    }
  }
  return output.join(" ");
}

function tokenizeWords(value) {
  return String(value ?? "")
    .replace(/[.,;:!?…]+$/u, "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

const RU_UNITS = new Map([
  ["один", 1], ["одна", 1], ["одно", 1],
  ["два", 2], ["две", 2],
  ["три", 3], ["четыре", 4], ["пять", 5], ["шесть", 6], ["семь", 7], ["восемь", 8], ["девять", 9]
]);
const RU_TEENS = new Map([
  ["десять", 10], ["одиннадцать", 11], ["двенадцать", 12], ["тринадцать", 13], ["четырнадцать", 14],
  ["пятнадцать", 15], ["шестнадцать", 16], ["семнадцать", 17], ["восемнадцать", 18], ["девятнадцать", 19]
]);
const RU_TENS = new Map([
  ["двадцать", 20], ["тридцать", 30], ["сорок", 40], ["пятьдесят", 50], ["шестьдесят", 60],
  ["семьдесят", 70], ["восемьдесят", 80], ["девяносто", 90]
]);
const RU_HUNDREDS = new Map([
  ["сто", 100], ["двести", 200], ["триста", 300], ["четыреста", 400], ["пятьсот", 500],
  ["шестьсот", 600], ["семьсот", 700], ["восемьсот", 800], ["девятьсот", 900]
]);
const RU_THOUSANDS = new Set(["тысяча", "тысячи", "тысяч"]);

function isRussianNumberWord(token) {
  const normalized = normalizeWordToken(token);
  return RU_UNITS.has(normalized)
    || RU_TEENS.has(normalized)
    || RU_TENS.has(normalized)
    || RU_HUNDREDS.has(normalized)
    || RU_THOUSANDS.has(normalized);
}

function contiguousRussianNumberEnd(tokens, start) {
  let index = start;
  while (index < tokens.length && isRussianNumberWord(tokens[index])) index += 1;
  return index;
}

function parseRussianNumberSequence(tokens, start, forcedEnd = null) {
  const end = forcedEnd ?? contiguousRussianNumberEnd(tokens, start);
  let index = start;
  let total = 0;

  const thousandIndex = findRussianThousandsIndex(tokens, index, end);
  if (thousandIndex >= 0) {
    const thousands = thousandIndex === index
      ? { value: 1, nextIndex: index }
      : parseRussianUnderThousand(tokens, index, thousandIndex);
    if (!thousands || thousands.nextIndex !== thousandIndex) return null;
    total += thousands.value * 1000;
    index = thousandIndex + 1;
  }

  if (index < end) {
    const remainder = parseRussianUnderThousand(tokens, index, end);
    if (!remainder || remainder.nextIndex !== end) return null;
    total += remainder.value;
    index = remainder.nextIndex;
  }

  if (index !== end || total <= 0 || total > 999_999) return null;
  return { value: total, nextIndex: end };
}

function isCurrencyOnlyPart(value) {
  const tokens = tokenizeWords(value);
  return tokens.length === 1 && isCurrencyAlias(tokens[0]);
}

function findRussianThousandsIndex(tokens, start, end) {
  for (let index = start; index < end; index += 1) {
    if (RU_THOUSANDS.has(normalizeWordToken(tokens[index]))) return index;
  }
  return -1;
}

function parseRussianUnderThousand(tokens, start, end) {
  let index = start;
  let value = 0;
  if (index < end && RU_HUNDREDS.has(normalizeWordToken(tokens[index]))) {
    value += RU_HUNDREDS.get(normalizeWordToken(tokens[index]));
    index += 1;
  }
  if (index < end && RU_TEENS.has(normalizeWordToken(tokens[index]))) {
    value += RU_TEENS.get(normalizeWordToken(tokens[index]));
    index += 1;
  } else {
    if (index < end && RU_TENS.has(normalizeWordToken(tokens[index]))) {
      value += RU_TENS.get(normalizeWordToken(tokens[index]));
      index += 1;
    }
    if (index < end && RU_UNITS.has(normalizeWordToken(tokens[index]))) {
      value += RU_UNITS.get(normalizeWordToken(tokens[index]));
      index += 1;
    }
  }
  return value > 0 ? { value, nextIndex: index } : null;
}

function containsRussianNumberWord(value) {
  return tokenizeWords(value).some((token) => isRussianNumberWord(token));
}

function containsRussianAmountWordSequence(value) {
  const tokens = tokenizeWords(value);
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isRussianNumberWord(tokens[index])) continue;
    const end = contiguousRussianNumberEnd(tokens, index);
    const parsed = parseRussianNumberSequence(tokens, index, end);
    if (parsed && russianNumberSpanLooksLikeAmount(tokens, index, parsed.nextIndex)) return true;
    index = end - 1;
  }
  return false;
}

function russianNumberSpanLooksLikeAmount(tokens, start, end) {
  if (isCurrencyAlias(tokens[end])) return true;
  if (end === tokens.length && start > 0 && !isRussianNumberWord(tokens[start - 1])) return true;
  if (["за", "for"].includes(normalizeWordToken(tokens[end]))) return true;
  return false;
}

export function isCurrencyAlias(token) {
  return recognizeCurrencyText(normalizeCurrencyToken(token)).kind !== "none";
}

function normalizeWordToken(token) {
  return String(token ?? "").toLowerCase().replaceAll("ё", "е").replace(/[.,;:!?…]+$/u, "");
}

function hasUnsafeAmountSyntax(part) {
  return /\d+\s*[+xх]\s*\d+/iu.test(part)
    || /\d+\s+(?:за|for)\s+\d+/iu.test(part)
    || /\d+[,]\d{3}(?!\d)/u.test(part)
    || /\d+[.,]\d+[.,]\d+/u.test(part);
}

function resolveCurrency(part, amountMatch, defaultCurrency) {
  const candidates = [];
  for (const symbol of [amountMatch.leadingSymbol, amountMatch.trailingSymbol].filter(Boolean)) {
    candidates.push(recognizeCurrencyText(symbol).code);
  }
  const recognition = recognizeCurrencyText(part);
  if (recognition.kind === "ambiguous") return recognition;
  if (recognition.kind === "conflict") return recognition;
  if (recognition.kind === "exact") candidates.push(recognition.code);
  const unique = [...new Set(candidates.filter(Boolean))];
  if (unique.length > 1) return { kind: "conflict" };
  return { kind: "exact", code: unique[0] ?? defaultCurrency };
}

function normalizeCurrencyToken(token) {
  return String(token ?? "").toLowerCase().replaceAll("ё", "е").replace(/[.,;:!?]+$/u, "");
}

function isSmallBareIntegerWithoutCurrency(part, amountMatch) {
  if (amountMatch.leadingSymbol || amountMatch.trailingSymbol) return false;
  if (!/^\d+$/.test(amountMatch.rawAmount)) return false;
  const amount = Number(amountMatch.rawAmount);
  if (!Number.isInteger(amount) || amount >= 10) return false;
  return part.slice(0, amountMatch.start).trim() === ""
    && cleanDescription(part.slice(amountMatch.end)) !== "";
}

function cleanDescription(value) {
  let text = String(value ?? "").toLowerCase().replaceAll("ё", "е");
  for (const word of DATE_WORDS) {
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, "giu"), " ");
  }
  for (const token of currencyRecognitionAliases()) {
    if (SYMBOL_CURRENCIES.has(token)) continue;
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(token)}(?![\\p{L}\\p{N}])`, "giu"), " ");
  }
  return text
    .replace(/\b(large|big)\s+one[-\s]?off\s+(purchase|expense)?\b/giu, " ")
    .replace(/\b(крупн(?:ая|ую|ое|ый)|больш(?:ая|ую|ое|ой))\s+разов(?:ая|ую|ое|ой)?\s+(покупк[аиу]?|трат[ау])?\b/giu, " ")
    .replace(/\bразов(?:ая|ую|ое|ой)\s+(крупн(?:ая|ую|ое|ый)|больш(?:ая|ую|ое|ой))\s+(покупк[аиу]?|трат[ау])?\b/giu, " ")
    .replace(/^(?:bought|buy|spent|spend|add|paid|pay)\s+/iu, "")
    .replace(/^(?:for|on)\s+/iu, "")
    .replace(/\s+(?:for|on)\s*$/iu, "")
    .replace(/^(?:купил|купила|взял|взяла|потратил|потратила|потратился|потратилась|оплатил|оплатила|запиши|добавь|записать|потратить)\s+/iu, "")
    .replace(/^(?:за|на|по)\s+/iu, "")
    .replace(/\s+(?:за|на|по)\s*$/iu, "")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function detectBudgetImpact(part) {
  return /(крупн(?:ая|ую|ое|ый)|больш(?:ая|ую|ое|ой))\s+разов(?:ая|ую|ое|ой)?(?:\s+(покупк[аиу]?|трат[ау]))?/iu.test(part)
    || /разов(?:ая|ую|ое|ой)\s+(крупн(?:ая|ую|ое|ый)|больш(?:ая|ую|ое|ой))(?:\s+(покупк[аиу]?|трат[ау]))?/iu.test(part)
    || /\b(large|big)\s+one[-\s]?off\s+(purchase|expense)?\b/iu.test(part)
    ? "large_oneoff"
    : "regular";
}

function resolveRelativeDate(part, now) {
  const lowered = String(part ?? "").toLowerCase().replaceAll("ё", "е");
  const daysOffset = /(?<![\p{L}\p{N}])(позавчера|day before yesterday)(?![\p{L}\p{N}])/iu.test(lowered)
    ? -2
    : /(?<![\p{L}\p{N}])(вчера|yesterday)(?![\p{L}\p{N}])/iu.test(lowered)
      ? -1
      : 0;
  if (!daysOffset) return now;
  return new Date(now.getTime() + daysOffset * 24 * 60 * 60_000);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
