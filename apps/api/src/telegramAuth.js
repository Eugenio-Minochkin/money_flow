import crypto from "node:crypto";

const DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60;

export function verifyTelegramInitData(initData, botToken, options = {}) {
  if (!initData || !botToken) return { ok: false, reason: "missing_data" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "missing_hash" };
  params.delete("hash");

  const checkString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = crypto.createHmac("sha256", secret).update(checkString).digest("hex");

  if (!safeEqual(hash, expected)) return { ok: false, reason: "invalid_hash" };

  const authDate = Number(params.get("auth_date"));
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  if (!Number.isFinite(authDate) || nowSeconds - authDate > maxAgeSeconds) {
    return { ok: false, reason: "expired" };
  }

  const user = JSON.parse(params.get("user") ?? "{}");
  if (!Number(user.id)) return { ok: false, reason: "missing_user" };
  return { ok: true, telegramUserId: Number(user.id) };
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left), "hex");
  const rightBuffer = Buffer.from(String(right), "hex");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
