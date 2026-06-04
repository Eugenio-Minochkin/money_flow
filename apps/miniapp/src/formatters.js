const money = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
let baseCurrency = "THB";

export function setBaseCurrency(currency = "THB") {
  baseCurrency = currency || "THB";
}

export function moneyBase(value, currency = baseCurrency) {
  return `${money.format(Number(value ?? 0))} ${currency}`;
}

export function moneyDisplay(value, currency = "USD") {
  if (value == null || Number.isNaN(Number(value))) return "";
  const symbols = {
    USD: "$",
    EUR: "€",
    IDR: "Rp ",
    GEL: "₾",
    BYN: "Br ",
    RUB: ""
  };
  const prefix = symbols[currency] ? `~${symbols[currency]}` : "";
  const suffix = symbols[currency] ? "" : ` ${currency}`;
  return `${prefix}${money.format(Number(value))}${suffix}`;
}

export function moneyDisplaySigned(value, currency = "USD") {
  if (value == null || Number.isNaN(Number(value))) return "";
  const sign = Number(value) > 0 ? "+" : "";
  return `${sign}${moneyDisplay(value, currency)}`;
}

export function formatDate(value, language = "ru") {
  return new Intl.DateTimeFormat(localeFor(language), {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function formatDateOnly(value, language = "ru") {
  return new Intl.DateTimeFormat(localeFor(language), {
    day: "2-digit",
    month: "short"
  }).format(new Date(value));
}

function localeFor(language) {
  return language === "en" ? "en-US" : "ru-RU";
}

export function dateTimeLocal(value) {
  const date = new Date(value ?? Date.now());
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("\n", " ");
}
