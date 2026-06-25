import { createHash } from "node:crypto";

import { localDateKey, localHour, localPeriodBounds, normalizeTimeZone } from "../../../packages/shared/src/time.js";
import { isBotBlockedError } from "./releaseNotesService.js";
import { dailyReminderKeyboard } from "./telegramKeyboards.js";

const REMINDER_TYPE = "daily_empty_day";

export function isInRollout(userId, featureName, percent) {
  const rolloutPercent = Math.max(0, Math.min(100, Number(percent ?? 0)));
  if (rolloutPercent <= 0) return false;
  if (rolloutPercent >= 100) return true;
  const hash = createHash("sha256").update(`${userId}:${featureName}`).digest();
  const bucket = hash.readUInt32BE(0) % 100;
  return bucket < rolloutPercent;
}

export function createDailyReminderService({
  repository,
  sendMessage,
  globalEnabled = false,
  rolloutPercent = 0,
  now = () => new Date()
} = {}) {
  return {
    async runOnce() {
      const summary = { checked: 0, eligible: 0, sent: 0, failed: 0, blocked: 0, skipped: 0 };
      if (!globalEnabled) return summary;
      const users = await repository.listDailyReminderCandidates();
      const current = now();
      for (const user of users) {
        summary.checked += 1;
        const outcome = await evaluateAndSend(user, current);
        summary[outcome] = (summary[outcome] ?? 0) + 1;
      }
      return summary;
    }
  };

  async function evaluateAndSend(user, current) {
    if (!isInRollout(user.id, REMINDER_TYPE, rolloutPercent)) return "skipped";
    if (current.getTime() - new Date(user.created_at).getTime() < 24 * 60 * 60_000) return "skipped";

    const normalized = normalizeTimeZone(user.timezone);
    const timeZone = normalized.timeZone;
    if (normalized.fallback) {
      await repository.recordAppEvent(user.id, normalized.reason, { timezoneUsed: timeZone, rawTimezone: user.timezone ?? null });
    }
    if (localHour(current, timeZone) < 22) return "skipped";

    const localDate = localDateKey(current, timeZone);
    const bounds = localPeriodBounds(current, "today", timeZone);
    if (await repository.hasConfirmedFinancialActivity(user.id, bounds)) return "skipped";
    if (await repository.hasNoSpendingMark(user.id, localDate)) return "skipped";
    if (await repository.hasDailyReminderDelivery(user.id, localDate, REMINDER_TYPE)) return "skipped";
    if (await repository.hasRecentDailyReminderDelivery(user.id, new Date(current.getTime() - 48 * 60 * 60_000), REMINDER_TYPE)) return "skipped";

    await repository.recordAppEvent(user.id, "daily_reminder_eligible", {
      local_date: localDate,
      timezone_used: timeZone,
      eligible_at: current.toISOString()
    });

    try {
      await sendMessage({
        chatId: Number(user.telegram_user_id),
        text: reminderText(user.interface_language),
        replyMarkup: dailyReminderKeyboard(user.interface_language)
      });
      await repository.recordDailyReminderDelivery({
        userId: user.id,
        localDate,
        timezoneUsed: timeZone,
        reminderType: REMINDER_TYPE,
        status: "sent",
        sentAt: current
      });
      await repository.recordAppEvent(user.id, "daily_reminder_sent", {
        local_date: localDate,
        timezone_used: timeZone,
        sent_at: current.toISOString()
      });
      return "sent";
    } catch (error) {
      const blocked = isBotBlockedError(error);
      const eventName = blocked ? "daily_reminder_blocked_or_forbidden" : "daily_reminder_send_failed";
      const status = blocked ? "blocked" : "failed";
      await repository.recordDailyReminderDelivery({
        userId: user.id,
        localDate,
        timezoneUsed: timeZone,
        reminderType: REMINDER_TYPE,
        status,
        sentAt: current,
        errorCode: error.status ? String(error.status) : error.code ?? "send_failed",
        errorMessage: error.message
      });
      await repository.recordAppEvent(user.id, eventName, {
        local_date: localDate,
        error_code: error.status ? String(error.status) : error.code ?? "send_failed",
        error_message: error.message
      });
      if (blocked) {
        await repository.markUserBotBlocked(user.id);
        return "blocked";
      }
      return "failed";
    }
  }
}

function reminderText(language) {
  if (language === "ru") {
    return "Привет 👋\nСегодня пока нет записей. Если были траты — можешь быстро добавить их сейчас.";
  }
  return "Hey 👋\nNo entries for today yet. If you had any spending, you can quickly add it now.";
}
