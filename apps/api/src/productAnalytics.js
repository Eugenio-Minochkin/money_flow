const SOURCE_PATTERN = /^[a-z0-9_-]{1,64}$/;
const WEEKLY_REPORT_KEY = /^\d{4}-W\d{2}$/;
const MONTHLY_REPORT_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;
const NETWORK_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET"
]);

export const SINGLETON_ONBOARDING_EVENTS = new Set([
  "onboarding_started",
  "currency_selected",
  "budget_set",
  "onboarding_completed"
]);

export const MEANINGFUL_ACTIVITY_EVENTS = new Set([
  "expense_draft_created",
  "expense_draft_confirmed",
  "expense_saved",
  "dashboard_opened",
  "report_app_clicked",
  "feedback_sent",
  "currency_changed",
  "budget_changed",
  "planned_expense_created",
  "planned_expense_updated",
  "planned_expense_deleted"
]);

export function normalizeAcquisitionSource(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return SOURCE_PATTERN.test(normalized) ? normalized : "direct";
}

export function normalizeReportMarker(reportType, reportKey) {
  const type = String(reportType ?? "");
  const key = String(reportKey ?? "");
  const valid = type === "weekly"
    ? WEEKLY_REPORT_KEY.test(key)
    : type === "monthly" && MONTHLY_REPORT_KEY.test(key);
  return valid ? { reportType: type, reportKey: key } : null;
}

export function reportDeliveryErrorType(error) {
  const status = Number(error?.status ?? error?.statusCode);
  const message = String(error?.message ?? "").toLowerCase();
  if (status === 403 && /bot was blocked|user is deactivated|bot was kicked/.test(message)) {
    return "blocked";
  }
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599) return "telegram_5xx";
  if (NETWORK_ERROR_CODES.has(String(error?.code ?? "").toUpperCase())) return "network";
  return "unknown";
}
