import { verifyTelegramInitData } from "./telegramAuth.js";

export function createApiSecurity({ telegramBotToken, requireTelegramInitData = false, telegramWebhookSecret }) {
  return {
    isValidTelegramWebhook(req) {
      if (!telegramWebhookSecret) return true;
      return req.headers["x-telegram-bot-api-secret-token"] === telegramWebhookSecret;
    },

    resolveTelegramUserId(req, url, body = {}) {
      const declaredId = Number(body.telegramUserId ?? url.searchParams.get("telegramUserId"));
      const initData = req.headers["x-telegram-init-data"];

      if (initData) {
        const auth = verifyTelegramInitData(initData, telegramBotToken);
        if (!auth.ok) return { error: auth.reason };
        if (declaredId && declaredId !== auth.telegramUserId) return { error: "telegram_user_mismatch" };
        return verifiedIdentity(auth);
      }

      if (requireTelegramInitData) return { error: "telegram_init_data_required" };
      if (!declaredId) return { error: "telegramUserId_required" };
      return { telegramUserId: declaredId };
    },

    resolveVerifiedTelegramUserId(req) {
      const initData = req.headers["x-telegram-init-data"];
      if (!initData) return { error: "telegram_init_data_required" };
      const auth = verifyTelegramInitData(initData, telegramBotToken);
      if (!auth.ok) return { error: auth.reason };
      return verifiedIdentity(auth);
    }
  };
}

function verifiedIdentity(auth) {
  return {
    telegramUserId: auth.telegramUserId,
    verified: true,
    profile: auth.profile,
    startParam: auth.startParam
  };
}
