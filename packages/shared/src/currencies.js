const ACTIVE_FIAT_CURRENCY_CODES = [
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD",
  "CAD", "CDF", "CHF", "CLP", "CNY", "COP", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "FOK", "GBP", "GEL", "GGP", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD",
  "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "IMP", "INR", "IQD", "IRR", "ISK", "JEP", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KID", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "LYD",
  "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF",
  "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SLL", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TVD", "TWD", "TZS", "UAH", "UGX", "USD", "UYU", "UZS", "VES", "VND", "VUV", "WST", "XAF", "XCD", "XCG", "XOF", "XPF", "YER", "ZAR", "ZMW", "ZWG"
];

const CURRENCY_FLAGS = {
  AED: "🇦🇪", AMD: "🇦🇲", ARS: "🇦🇷", AUD: "🇦🇺", AZN: "🇦🇿", BAM: "🇧🇦", BDT: "🇧🇩", BGN: "🇧🇬", BHD: "🇧🇭", BND: "🇧🇳", BOB: "🇧🇴", BRL: "🇧🇷", BYN: "🇧🇾", CAD: "🇨🇦", CHF: "🇨🇭", CLP: "🇨🇱", CNY: "🇨🇳", COP: "🇨🇴", CZK: "🇨🇿", DKK: "🇩🇰", EGP: "🇪🇬", EUR: "🇪🇺", GBP: "🇬🇧", GEL: "🇬🇪", HKD: "🇭🇰", HUF: "🇭🇺", IDR: "🇮🇩", ILS: "🇮🇱", INR: "🇮🇳", ISK: "🇮🇸", JOD: "🇯🇴", JPY: "🇯🇵", KES: "🇰🇪", KHR: "🇰🇭", KRW: "🇰🇷", KWD: "🇰🇼", LAK: "🇱🇦", LKR: "🇱🇰", MAD: "🇲🇦", MKD: "🇲🇰", MMK: "🇲🇲", MOP: "🇲🇴", MXN: "🇲🇽", MYR: "🇲🇾", NOK: "🇳🇴", NPR: "🇳🇵", NZD: "🇳🇿", OMR: "🇴🇲", PEN: "🇵🇪", PHP: "🇵🇭", PKR: "🇵🇰", PLN: "🇵🇱", PYG: "🇵🇾", QAR: "🇶🇦", RON: "🇷🇴", RSD: "🇷🇸", RUB: "🇷🇺", SAR: "🇸🇦", SEK: "🇸🇪", SGD: "🇸🇬", THB: "🇹🇭", TRY: "🇹🇷", TWD: "🇹🇼", TZS: "🇹🇿", UAH: "🇺🇦", UGX: "🇺🇬", USD: "🇺🇸", UYU: "🇺🇾", VND: "🇻🇳", ZAR: "🇿🇦"
};

const LEGACY_EMERGENCY_THB_RATES = {
  THB: 1,
  USD: 32.65,
  RUB: 32.65 / 71.8,
  IDR: 32.65 / 16200,
  EUR: 32.65 / 0.88,
  BYN: 32.65 / 3.25,
  GEL: 32.65 / 2.7
};

const EXACT_CURRENCY_ALIASES = new Map([
  ["baht", "THB"], ["бат", "THB"], ["бата", "THB"], ["батов", "THB"], ["бахт", "THB"], ["บาท", "THB"], ["฿", "THB"],
  ["$", "USD"], ["dollar", "USD"], ["dollars", "USD"], ["доллар", "USD"], ["доллара", "USD"], ["долларов", "USD"], ["бакс", "USD"],
  ["руб", "RUB"], ["рубль", "RUB"], ["рубля", "RUB"], ["рублей", "RUB"], ["бел.руб", "BYN"], ["₽", "RUB"],
  ["euro", "EUR"], ["euros", "EUR"], ["евро", "EUR"], ["€", "EUR"],
  ["rupiah", "IDR"], ["лари", "GEL"], ["₾", "GEL"],
  ["australian dollar", "AUD"], ["australian dollars", "AUD"], ["австралийский доллар", "AUD"], ["австралийских долларов", "AUD"],
  ["indian rupee", "INR"], ["indian rupees", "INR"], ["индийская рупия", "INR"], ["индийских рупий", "INR"],
  ["indonesian rupiah", "IDR"], ["индонезийская рупия", "IDR"], ["индонезийских рупий", "IDR"],
  ["uae dirham", "AED"], ["uae dirhams", "AED"], ["emirati dirham", "AED"], ["emirati dirhams", "AED"], ["эмиратский дирхам", "AED"], ["эмиратских дирхамов", "AED"],
  ["japanese yen", "JPY"], ["японская иена", "JPY"], ["японских иен", "JPY"], ["¥", "JPY"], ["₹", "INR"]
]);

const AMBIGUOUS_CURRENCY_ALIASES = new Map([
  ["rupee", ["INR", "NPR", "LKR", "PKR", "BDT"]], ["rupees", ["INR", "NPR", "LKR", "PKR", "BDT"]], ["рупия", ["INR", "IDR", "NPR", "LKR", "PKR", "BDT"]], ["рупий", ["INR", "IDR", "NPR", "LKR", "PKR", "BDT"]],
  ["dirham", ["AED", "MAD"]], ["dirhams", ["AED", "MAD"]], ["дирхам", ["AED", "MAD"]], ["дирхамов", ["AED", "MAD"]],
  ["peso", ["ARS", "CLP", "COP", "MXN", "UYU"]], ["pesos", ["ARS", "CLP", "COP", "MXN", "UYU"]], ["песо", ["ARS", "CLP", "COP", "MXN", "UYU"]],
  ["dinar", ["BHD", "DZD", "IQD", "JOD", "KWD", "LYD", "RSD", "TND"]], ["dinars", ["BHD", "DZD", "IQD", "JOD", "KWD", "LYD", "RSD", "TND"]], ["динар", ["BHD", "DZD", "IQD", "JOD", "KWD", "LYD", "RSD", "TND"]], ["динаров", ["BHD", "DZD", "IQD", "JOD", "KWD", "LYD", "RSD", "TND"]],
  ["franc", ["CHF", "XAF", "XOF", "XPF"]], ["francs", ["CHF", "XAF", "XOF", "XPF"]], ["франк", ["CHF", "XAF", "XOF", "XPF"]], ["франков", ["CHF", "XAF", "XOF", "XPF"]],
  ["krona", ["CZK", "ISK", "NOK", "SEK"]], ["krone", ["DKK", "NOK"]], ["crown", ["CZK", "DKK", "ISK", "NOK", "SEK"]],
  ["shilling", ["KES", "TZS", "UGX"]], ["shillings", ["KES", "TZS", "UGX"]], ["шиллинг", ["KES", "TZS", "UGX"]], ["шиллингов", ["KES", "TZS", "UGX"]]
]);

function normalizeAlias(value) {
  return String(value ?? "").toLowerCase().replaceAll("ё", "е").replace(/[.,;:!?…]+$/u, "").trim();
}

export function currencyRecognitionAliases() {
  return [...new Set([...SUPPORTED_CURRENCY_CODES.map((code) => code.toLowerCase()), ...EXACT_CURRENCY_ALIASES.keys(), ...AMBIGUOUS_CURRENCY_ALIASES.keys()])];
}

export function recognizeCurrencyText(value) {
  const raw = String(value ?? "");
  const normalized = ` ${normalizeAlias(raw)} `;
  const exactMatches = [];
  const matchedAliases = [];
  for (const [alias, code] of [...EXACT_CURRENCY_ALIASES].sort(([left], [right]) => right.length - left.length)) {
    if (!normalized.includes(` ${alias} `)) continue;
    if (matchedAliases.some((matched) => ` ${matched} `.includes(` ${alias} `))) continue;
    matchedAliases.push(alias);
    exactMatches.push(code);
  }
  const tokens = raw.match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const token of tokens) {
    const code = token.toUpperCase();
    if (SUPPORTED_CURRENCY_CODE_SET.has(code) && (token === code || !["all", "top"].includes(token.toLowerCase()))) {
      exactMatches.push(code);
    }
  }
  const exactCodes = [...new Set(exactMatches)];
  if (exactCodes.length === 1) return { kind: "exact", code: exactCodes[0] };
  if (exactCodes.length > 1) return { kind: "conflict" };

  const candidates = [];
  for (const [alias, codes] of AMBIGUOUS_CURRENCY_ALIASES) {
    if (normalized.includes(` ${alias} `)) candidates.push(...codes);
  }
  const uniqueCandidates = [...new Set(candidates)];
  return uniqueCandidates.length > 0
    ? { kind: "ambiguous", candidates: uniqueCandidates }
    : { kind: "none" };
}

function displayName(code, locale) {
  try {
    return new Intl.DisplayNames([locale], { type: "currency" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export const SUPPORTED_CURRENCIES = ACTIVE_FIAT_CURRENCY_CODES.map((code) => ({
  code,
  flag: CURRENCY_FLAGS[code] ?? "",
  name: { en: displayName(code, "en"), ru: displayName(code, "ru") }
}));

export const SUPPORTED_CURRENCY_CODES = SUPPORTED_CURRENCIES.map((currency) => currency.code);
const SUPPORTED_CURRENCY_CODE_SET = new Set(SUPPORTED_CURRENCY_CODES);

export function isSupportedCurrency(value) {
  return SUPPORTED_CURRENCY_CODE_SET.has(String(value ?? "").trim().toUpperCase());
}

export function findCurrency(value) {
  const code = String(value ?? "").trim().toUpperCase();
  return SUPPORTED_CURRENCIES.find((currency) => currency.code === code) ?? null;
}

export function currencySearchText(value) {
  const currency = findCurrency(value);
  if (!currency) return "";
  return [currency.code, currency.name.en, currency.name.ru].join(" ").toLowerCase();
}

export function normalizeCurrency(value, fallback = "THB") {
  const currency = String(value || fallback).trim().toUpperCase();
  return isSupportedCurrency(currency) ? currency : fallback;
}

export function currencyFlag(code) {
  return findCurrency(code)?.flag ?? "";
}

export function currencyLabel(code) {
  const currency = findCurrency(code);
  return currency ? `${currency.flag} ${currency.code}`.trim() : code;
}

// Retained temporarily for legacy callers; Task 4 moves this adapter concern out of the catalogue module.
export function fallbackThbRate(code) {
  return LEGACY_EMERGENCY_THB_RATES[String(code ?? "").toUpperCase()] ?? null;
}
