export function shouldRequestTelegramFullscreen(platform) {
  const normalized = String(platform ?? "").toLowerCase();
  return normalized === "ios" || normalized.startsWith("android");
}
