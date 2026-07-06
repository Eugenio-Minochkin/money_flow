import { isIP } from "node:net";

export function createRateLimiter({ limit, windowMs, bucketTtlMs = windowMs * 2, cleanupIntervalMs = 0 }) {
  const buckets = new Map();
  let cleanupTimer = null;

  if (cleanupIntervalMs > 0) {
    cleanupTimer = setInterval(() => cleanupStaleBuckets(Date.now()), cleanupIntervalMs);
    cleanupTimer.unref?.();
  }

  function cleanupStaleBuckets(now = Date.now()) {
    let removed = 0;
    for (const [key, bucket] of buckets.entries()) {
      if (now - bucket.lastSeenAt > bucketTtlMs) {
        buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  return {
    check(key, now = Date.now()) {
      const bucket = buckets.get(key);
      if (!bucket || now >= bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: now + windowMs, lastSeenAt: now });
        return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
      }

      bucket.lastSeenAt = now;
      if (bucket.count >= limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
        };
      }

      bucket.count += 1;
      return { allowed: true, remaining: limit - bucket.count, retryAfterSeconds: 0 };
    },
    cleanupStaleBuckets,
    bucketCount() {
      return buckets.size;
    },
    stop() {
      if (cleanupTimer) clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  };
}

export function getRateLimitKey(req, { telegramUserId, trustedProxyIps = [] } = {}) {
  if (telegramUserId) return `tg:${telegramUserId}`;
  return `ip:${getClientIp(req, { trustedProxyIps })}`;
}

export function getClientIp(req, { trustedProxyIps = [] } = {}) {
  const remoteAddress = normalizeIp(req.socket?.remoteAddress) ?? "unknown";
  if (!isTrustedProxy(remoteAddress, trustedProxyIps)) return remoteAddress;

  const forwardedFor = firstForwardedIp(req.headers?.["x-forwarded-for"]);
  return forwardedFor ?? remoteAddress;
}

export function isTrustedProxy(remoteAddress, trustedProxyIps = []) {
  const normalizedRemote = normalizeIp(remoteAddress);
  if (!normalizedRemote) return false;
  return trustedProxyIps.map(normalizeIp).filter(Boolean).includes(normalizedRemote);
}

function firstForwardedIp(value) {
  const first = String(value ?? "").split(",")[0]?.trim();
  return normalizeIp(first);
}

function normalizeIp(value) {
  const ip = String(value ?? "").trim();
  if (!ip) return null;
  const unwrapped = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  const ipv4Mapped = unwrapped.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const normalized = ipv4Mapped ? ipv4Mapped[1] : unwrapped;
  return isIP(normalized) ? normalized : null;
}
