import { currencyRecognitionAliases, recognizeCurrencyText } from "../../../packages/shared/src/currencies.js";

const RU_UNITS = new Map([
  ["один", 1], ["одна", 1], ["одно", 1], ["два", 2], ["две", 2], ["три", 3], ["четыре", 4],
  ["пять", 5], ["шесть", 6], ["семь", 7], ["восемь", 8], ["девять", 9]
]);
const RU_TENS = new Map([
  ["двадцать", 20], ["тридцать", 30], ["сорок", 40], ["пятьдесят", 50],
  ["шестьдесят", 60], ["семьдесят", 70], ["восемьдесят", 80], ["девяносто", 90]
]);
const RU_JOINABLE_NUMBER_WORDS = new Set([
  "ноль", "один", "одна", "одно", "два", "две", "три", "четыре", "пять", "шесть", "семь", "семи", "восемь", "девять", "десять",
  "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать",
  "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто", "сто", "двести", "триста",
  "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот", "тысяча", "тысячи", "тысяч"
]);
const JOINABLE_EXACT_CURRENCY_ALIASES = currencyRecognitionAliases()
  .map((alias) => alias.toLowerCase().replaceAll("ё", "е"))
  .filter((alias) => /^\p{L}+$/u.test(alias) && recognizeCurrencyText(alias).kind === "exact")
  .sort((left, right) => right.length - left.length);

export function normalizeVoiceMoneyTranscript(value) {
  const text = splitJoinedNumberCurrencyToken(String(value ?? "").trim());
  const currency = recognizeCurrencyText(text);
  if (!text || currency.kind !== "exact") return text;

  const decimalMatches = [...text.matchAll(/(?<![\p{L}\p{N}])(\d{1,7})\s*([,.: -])\s*(\d{2})(?![\p{L}\p{N}])/gu)];
  if (decimalMatches.length === 1 && numericTokenCount(text) === 2) {
    const match = decimalMatches[0];
    if (hasAdjacentExactCurrency(text, match.index + match[0].length, currency.code)) {
      return `${text.slice(0, match.index)}${match[1]}.${match[3]}${text.slice(match.index + match[0].length)}`;
    }
  }

  const wordMatches = [...text.matchAll(/(?<![\p{L}])(один|одна|одно|два|две|три|четыре|пять|шесть|семь|восемь|девять)(?:\s+точка)?\s+(двадцать|тридцать|сорок|пятьдесят|шестьдесят|семьдесят|восемьдесят|девяносто)(?![\p{L}])/giu)];
  if (wordMatches.length !== 1 && numericTokenCount(text) === 0) return text;
  if (wordMatches.length === 1 && numericTokenCount(text) === 0) {
    const match = wordMatches[0];
    if (hasAdjacentExactCurrency(text, match.index + match[0].length, currency.code)) {
      const major = RU_UNITS.get(match[1].toLowerCase().replaceAll("ё", "е"));
      const minor = RU_TENS.get(match[2].toLowerCase().replaceAll("ё", "е"));
      if (major != null && minor != null) {
        return `${text.slice(0, match.index)}${major}.${String(minor).padStart(2, "0")}${text.slice(match.index + match[0].length)}`;
      }
    }
  }
  return text;
}

function splitJoinedNumberCurrencyToken(text) {
  if (numericTokenCount(text) !== 0) return text;
  const repairs = [];
  for (const match of text.matchAll(/(?<![\p{L}])\p{L}+(?![\p{L}])/gu)) {
    const token = match[0].toLowerCase().replaceAll("ё", "е");
    for (const currencyAlias of JOINABLE_EXACT_CURRENCY_ALIASES) {
      if (!token.endsWith(currencyAlias) || token === currencyAlias) continue;
      const numberWord = token.slice(0, -currencyAlias.length);
      if (RU_JOINABLE_NUMBER_WORDS.has(numberWord)) {
        repairs.push({ index: match.index, length: match[0].length, value: `${numberWord === "семи" ? "семь" : numberWord} ${currencyAlias}` });
      }
      break;
    }
  }
  if (repairs.length !== 1) return text;
  const repair = repairs[0];
  return `${text.slice(0, repair.index)}${repair.value}${text.slice(repair.index + repair.length)}`;
}

function hasAdjacentExactCurrency(text, end, currencyCode) {
  const suffix = text.slice(end).trim();
  const recognized = recognizeCurrencyText(suffix);
  return recognized.kind === "exact" && recognized.code === currencyCode;
}

function numericTokenCount(text) {
  return text.match(/\d+/gu)?.length ?? 0;
}
