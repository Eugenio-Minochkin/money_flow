export function shouldShowCurrentMonthBudgetOverride(currentMonthBudget, now = new Date(), timeZone = "Asia/Bangkok") {
  return Boolean(
    currentMonthBudget?.hasOverride
    && currentMonthBudget?.isPartialMonth
    && currentMonthBudget?.monthKey === localMonthKey(now, timeZone)
  );
}

export const COMMON_TIMEZONES = [
  "Asia/Bangkok",
  "Europe/Moscow",
  "Asia/Tbilisi",
  "Asia/Yerevan",
  "Asia/Dubai",
  "Asia/Bali",
  "Europe/Warsaw",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles"
];

export function normalizeSettingsTimeZone(value) {
  return COMMON_TIMEZONES.includes(value) ? value : "Asia/Bangkok";
}

export function detectBrowserTimeZone(intl = Intl) {
  try {
    return normalizeSettingsTimeZone(intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return "Asia/Bangkok";
  }
}

function localMonthKey(now, timeZone = "Asia/Bangkok") {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit"
  }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}`;
}
