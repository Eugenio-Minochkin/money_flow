const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres"]);

export function isDevMode(env = process.env) {
  return env.NODE_ENV !== "production";
}

export function assertDevDatabase(env = process.env) {
  if (!isDevMode(env)) {
    throw new Error("dev reset and sandbox endpoints are disabled in production");
  }
  if (isProductionDatabaseUrl(env.DATABASE_URL)) {
    throw new Error("dev reset refused production-like DATABASE_URL");
  }
}

export function isProductionDatabaseUrl(databaseUrl) {
  if (!databaseUrl) return false;
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return true;
  }
  const host = parsed.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host)) return false;
  if (host.endsWith(".local") || host.endsWith(".test")) return false;
  return true;
}
