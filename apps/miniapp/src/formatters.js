const money = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

export function moneyBase(value) {
  return `${money.format(Number(value ?? 0))} THB`;
}

export function moneyDisplay(value, currency = "USD") {
  if (value == null || Number.isNaN(Number(value))) return "";
  const prefix = currency === "USD" ? "~$" : "";
  const suffix = currency === "USD" ? "" : ` ${currency}`;
  return `${prefix}${money.format(Number(value))}${suffix}`;
}

export function moneyDisplaySigned(value, currency = "USD") {
  if (value == null || Number.isNaN(Number(value))) return "";
  const sign = Number(value) > 0 ? "+" : "";
  return `${sign}${moneyDisplay(value, currency)}`;
}

export function formatDate(value) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function formatDateOnly(value) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short"
  }).format(new Date(value));
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
