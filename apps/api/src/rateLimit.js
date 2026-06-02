export function createRateLimiter({ limit, windowMs }) {
  const buckets = new Map();

  return {
    check(key, now = Date.now()) {
      const bucket = buckets.get(key);
      if (!bucket || now >= bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
      }

      if (bucket.count >= limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
        };
      }

      bucket.count += 1;
      return { allowed: true, remaining: limit - bucket.count, retryAfterSeconds: 0 };
    }
  };
}
