export function parseAdminTelegramIds(value) {
  const text = String(value ?? "").trim();
  if (!text) return new Set();

  const unwrapped = text.startsWith("[") && text.endsWith("]")
    ? text.slice(1, -1)
    : text;

  return new Set(unwrapped
    .split(/[\s,;]+/)
    .map((token) => token.trim().replace(/^(["'])(.*)\1$/, "$2"))
    .filter((token) => /^\d+$/.test(token))
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0));
}

export function isAdminTelegramId(telegramUserId, adminTelegramIds) {
  if (!(adminTelegramIds instanceof Set)) return false;
  const token = String(telegramUserId ?? "").trim();
  if (!/^\d+$/.test(token)) return false;
  const id = Number(token);
  return Number.isSafeInteger(id) && id > 0 && adminTelegramIds.has(id);
}

export function normalizeBotCommand(text) {
  if (text == null) return null;
  const trimmed = String(text).trim();
  const match = trimmed.match(/^(\/[a-z0-9_]+)(?:@[a-z0-9_]+)?$/i);
  return match ? match[1] : trimmed;
}

export function parseBotCommand(text) {
  if (text == null) return { command: null, payload: null };
  const trimmed = String(text).trim();
  const start = trimmed.match(/^\/start(?:@[a-z0-9_]+)?(?:\s+([^\s]+))?$/i);
  if (start) {
    return { command: "/start", payload: start[1] ?? null };
  }
  return { command: normalizeBotCommand(trimmed), payload: null };
}
