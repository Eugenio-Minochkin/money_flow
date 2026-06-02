export const SUPPORTED_CURRENCIES = [
  { code: "THB", flag: "🇹🇭", name: "Thai baht", fallbackThbRate: 1 },
  { code: "USD", flag: "🇺🇸", name: "US dollar", fallbackThbRate: 32.65 },
  { code: "RUB", flag: "🇷🇺", name: "Russian ruble", fallbackThbRate: 32.65 / 71.8 },
  { code: "IDR", flag: "🇮🇩", name: "Indonesian rupiah", fallbackThbRate: 32.65 / 16200 },
  { code: "EUR", flag: "🇪🇺", name: "Euro", fallbackThbRate: 32.65 / 0.88 },
  { code: "BYN", flag: "🇧🇾", name: "Belarusian ruble", fallbackThbRate: 32.65 / 3.25 },
  { code: "GEL", flag: "🇬🇪", name: "Georgian lari", fallbackThbRate: 32.65 / 2.7 }
];

export const SUPPORTED_CURRENCY_CODES = SUPPORTED_CURRENCIES.map((currency) => currency.code);

export function normalizeCurrency(value, fallback = "THB") {
  const currency = String(value || fallback).toUpperCase();
  return SUPPORTED_CURRENCY_CODES.includes(currency) ? currency : fallback;
}

export function currencyFlag(code) {
  return SUPPORTED_CURRENCIES.find((currency) => currency.code === code)?.flag ?? "";
}

export function currencyLabel(code) {
  const currency = SUPPORTED_CURRENCIES.find((item) => item.code === code);
  return currency ? `${currency.flag} ${currency.code}` : code;
}

export function fallbackThbRate(code) {
  return SUPPORTED_CURRENCIES.find((currency) => currency.code === code)?.fallbackThbRate ?? 1;
}
