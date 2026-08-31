import { SUPPORTED_CURRENCIES, currencyFlag } from "../../../packages/shared/src/currencies.js";

export const currencies = SUPPORTED_CURRENCIES.map((currency) => [
  currency.code,
  `${currencyFlag(currency.code)} ${currency.code} — ${currency.name.en} / ${currency.name.ru}`
]);

export function currencyOptions(selected, option, query = "") {
  const normalizedQuery = String(query).trim().toLocaleLowerCase();
  return currencies
    .filter(([code, label]) => code === selected || !normalizedQuery || `${code} ${label}`.toLocaleLowerCase().includes(normalizedQuery))
    .map(([code, label]) => option(code, selected, label))
    .join("");
}

export function currencyLabel(code) {
  return currencies.find(([value]) => value === code)?.[1] ?? code;
}
