export function shouldRateLimitRequest(req, url) {
  if (req.method === "POST" && url.pathname === "/telegram/webhook") return true;
  return url.pathname.startsWith("/api/");
}
