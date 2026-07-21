const DEFAULT_THROTTLE_MS = 10 * 60_000;
const DEFAULT_MAX_MESSAGE_LENGTH = 900;
const THROTTLE_CLEANUP_MULTIPLIER = 2;
const SENSITIVE_KEY_PATTERN = /token|secret|password|authorization|cookie|initdata|hash|signature|env|headers|body/i;
const EXTRA_SAFE_KEYS = new Set(["chatId", "statusCode", "provider", "attempt"]);
const SAFE_CONTEXT_KEYS = new Set([
  "source",
  "route",
  "method",
  "jobName",
  "telegramUserId",
  "userId",
  "stage",
  "operation",
  "extra"
]);

export function createAdminAlertService({
  enabled = true,
  adminTelegramIds = new Set(),
  sendMessage,
  logger = console,
  throttleMs = DEFAULT_THROTTLE_MS,
  maxMessageLength = DEFAULT_MAX_MESSAGE_LENGTH,
  now = () => new Date()
} = {}) {
  const throttleWindowMs = positiveNumber(throttleMs, DEFAULT_THROTTLE_MS);
  const messageMaxLength = positiveNumber(maxMessageLength, DEFAULT_MAX_MESSAGE_LENGTH);
  const throttle = new Map();
  let sendingAlert = false;

  async function notifyAdminError(error, context = {}) {
    if (!enabled || !(adminTelegramIds instanceof Set) || adminTelegramIds.size === 0 || typeof sendMessage !== "function") {
      return { sent: false, skipped: true, reason: "disabled" };
    }
    if (sendingAlert) {
      logger.warn?.("[admin-alerts] admin alert skipped", {
        reason: "recursive_alert"
      });
      return { sent: false, skipped: true, reason: "recursive_alert" };
    }

    const current = now();
    cleanupThrottle(throttle, current, throttleWindowMs);
    const serialized = serializeAlertError(error);
    const safeContext = sanitizeAlertContext(context);
    const fingerprint = alertFingerprint(serialized, safeContext);
    const lastSentAt = throttle.get(fingerprint);
    if (lastSentAt && current.getTime() - lastSentAt.getTime() < throttleWindowMs) {
      return { sent: false, skipped: true, reason: "throttled", fingerprint };
    }

    const text = formatAdminAlertMessage(serialized, safeContext, {
      now: current,
      maxMessageLength: messageMaxLength
    });

    sendingAlert = true;
    let delivered = 0;
    try {
      for (const chatId of adminTelegramIds) {
        try {
          await sendMessage({ chatId, text, replyMarkup: null });
          delivered += 1;
          throttle.set(fingerprint, current);
        } catch (sendError) {
          logger.error?.("[admin-alerts] admin alert send failed", {
            chatId,
            errorName: serializeAlertError(sendError).name,
            message: serializeAlertError(sendError).message
          });
        }
      }
    } finally {
      sendingAlert = false;
    }

    return { sent: delivered > 0, delivered, fingerprint, text };
  }

  return {
    notifyAdminError,
    formatExample(error, context = {}) {
      return formatAdminAlertMessage(serializeAlertError(error), sanitizeAlertContext(context), {
        now: now(),
        maxMessageLength: messageMaxLength
      });
    },
    _clearThrottleForTests() {
      throttle.clear();
    }
  };
}

export function serializeAlertError(error) {
  if (error instanceof Error) {
    return {
      name: safeText(error.name || "Error", 80),
      message: safeText(redactSensitiveText(error.message || "(no message)"), 300)
    };
  }
  return {
    name: "NonError",
    message: safeText(redactSensitiveText(String(error)), 300)
  };
}

export function sanitizeAlertContext(context = {}) {
  if (!isPlainObject(context)) return {};
  const sanitized = {};
  for (const [key, value] of Object.entries(context)) {
    if (!SAFE_CONTEXT_KEYS.has(key) || isSensitiveKey(key)) continue;
    if (key === "extra") {
      const extra = sanitizeExtra(value);
      if (Object.keys(extra).length > 0) sanitized.extra = extra;
      continue;
    }
    if (isSafeScalar(value)) sanitized[key] = value;
  }
  return sanitized;
}

export function formatAdminAlertMessage(error, context = {}, { now = new Date(), maxMessageLength = DEFAULT_MAX_MESSAGE_LENGTH } = {}) {
  const lines = ["Money Flow error"];
  if (context.source) lines.push(`source: ${context.source}`);
  const route = routeLine(context);
  if (route) lines.push(`route: ${route}`);
  if (context.jobName) lines.push(`jobName: ${context.jobName}`);
  if (context.stage) lines.push(`stage: ${context.stage}`);
  if (context.operation) lines.push(`operation: ${context.operation}`);
  if (context.telegramUserId != null) lines.push(`telegramUserId: ${context.telegramUserId}`);
  if (context.userId != null) lines.push(`userId: ${context.userId}`);
  if (context.extra) {
    for (const [key, value] of Object.entries(context.extra)) {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push(`error: ${error.name}`);
  lines.push(`message: ${error.message}`);
  lines.push(`time: ${new Date(now).toISOString()}`);

  return truncateMessage(lines.join("\n"), positiveNumber(maxMessageLength, DEFAULT_MAX_MESSAGE_LENGTH));
}

function sanitizeExtra(value) {
  if (!isPlainObject(value)) return {};
  const sanitized = {};
  for (const [key, item] of Object.entries(value)) {
    if (!EXTRA_SAFE_KEYS.has(key)) continue;
    if (isSensitiveKey(key)) continue;
    if (isSafeScalar(item)) sanitized[key] = item;
  }
  return sanitized;
}

function redactSensitiveText(value) {
  return String(value ?? "")
    .replace(/\b(token|secret|password|initData|cookie|TELEGRAM_BOT_TOKEN|OPENAI_API_KEY)\s*=\s*("[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1=[redacted]")
    .replace(/\bauthorization\s*[:=]?\s*Bearer\s+("[^"]*"|'[^']*'|[^\s,;&]+)/gi, "authorization: Bearer [redacted]")
    .replace(/\bBearer\s+("[^"]*"|'[^']*'|[^\s,;&]+)/g, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "sk-[redacted]")
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{12,}\b/g, "[telegram-bot-token-redacted]");
}

function alertFingerprint(error, context) {
  return [
    normalizeFingerprintPart(context.source),
    normalizeFingerprintPart(context.route || context.jobName || context.operation),
    normalizeFingerprintPart(error.name),
    normalizeFingerprintPart(error.message)
  ].join("|");
}

function cleanupThrottle(throttle, now, throttleMs) {
  const cutoff = now.getTime() - throttleMs * THROTTLE_CLEANUP_MULTIPLIER;
  for (const [fingerprint, sentAt] of throttle.entries()) {
    if (sentAt.getTime() < cutoff) throttle.delete(fingerprint);
  }
}

function routeLine(context) {
  if (!context.route) return null;
  return context.method ? `${context.method} ${context.route}` : String(context.route);
}

function normalizeFingerprintPart(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateMessage(text, maxLength) {
  if (text.length <= maxLength) return text;
  if (maxLength <= 3) return ".".repeat(maxLength);
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function safeText(value, maxLength) {
  return truncateMessage(String(value ?? "").replace(/\s+/g, " ").trim(), maxLength);
}

function isSensitiveKey(key) {
  return SENSITIVE_KEY_PATTERN.test(String(key));
}

function isSafeScalar(value) {
  return ["string", "number", "boolean"].includes(typeof value) || value === null;
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
