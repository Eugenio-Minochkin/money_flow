import { localDateKey, localHour, normalizeTimeZone } from "../../../packages/shared/src/time.js";
import { plannedOccurrenceDateKeysForPeriod } from "./plannedOccurrenceDates.js";
import { isBotBlockedError } from "./releaseNotesService.js";
import { plannedPaymentReminderKeyboard } from "./telegramKeyboards.js";

const REMINDER_TYPE = "planned_payment";

export function createPlannedPaymentReminderService({
  repository,
  sendMessage,
  globalEnabled = false,
  sendHour = 21,
  miniAppUrl,
  now = () => new Date()
} = {}) {
  return {
    async runOnce() {
      const summary = { checked: 0, eligible: 0, sent: 0, failed: 0, blocked: 0, skipped: 0 };
      if (!globalEnabled) return summary;
      const current = now();
      const candidates = await repository.listPlannedPaymentReminderCandidates();
      for (const candidate of candidates) {
        summary.checked += 1;
        const outcomes = await evaluateAndSend(candidate, current);
        for (const outcome of outcomes) {
          summary[outcome] = (summary[outcome] ?? 0) + 1;
        }
      }
      return summary;
    }
  };

  async function evaluateAndSend(candidate, current) {
    if (!candidate.active) return ["skipped"];
    const normalized = normalizeTimeZone(candidate.timezone);
    const timeZone = normalized.timeZone;
    const localDate = localDateKey(current, timeZone);
    if (localHour(current, timeZone) < sendHour) return ["skipped"];

    if (normalized.fallback) {
      await safeEvent(repository, candidate.user_id, normalized.reason, {
        timezone_used: timeZone
      });
    }

    const paidOccurrences = new Set((candidate.paid_occurrence_dates ?? []).map(normalizeDate));
    const occurrences = eligibleOccurrences(candidate, localDate)
      .filter(({ occurrenceDate }) => !paidOccurrences.has(occurrenceDate));
    if (occurrences.length === 0) return ["skipped"];

    const outcomes = [];
    for (const occurrence of occurrences) {
      outcomes.push(await sendOccurrence(candidate, occurrence, current, localDate, timeZone));
    }
    return outcomes;
  }

  async function sendOccurrence(candidate, occurrence, current, localDate, timeZone) {
    const claimInput = {
      userId: candidate.user_id,
      plannedExpenseId: candidate.id,
      occurrenceDate: occurrence.occurrenceDate,
      localDate,
      timezoneUsed: timeZone
    };
    const claimed = await repository.claimPlannedPaymentReminder(claimInput);
    if (!claimed) return "skipped";

    await safeEvent(repository, candidate.user_id, "planned_payment_reminder_eligible", {
      local_date: localDate,
      recurrence: candidate.recurrence,
      source: "telegram"
    });

    try {
      const response = await sendMessage({
        chatId: Number(candidate.telegram_user_id),
        text: formatPlannedPaymentReminder(candidate, candidate.interface_language, {
          occurrenceDate: occurrence.occurrenceDate,
          localDate,
          deliveryReason: occurrence.deliveryReason
        }),
        replyMarkup: plannedPaymentReminderKeyboard(
          candidate.id,
          occurrence.occurrenceDate,
          miniAppUrl,
          candidate.telegram_user_id,
          candidate.interface_language
        )
      });
      const telegramMessageId = response?.result?.message_id ?? response?.message_id ?? null;
      await repository.recordPlannedPaymentReminderMessage({
        userId: candidate.user_id,
        plannedExpenseId: candidate.id,
        occurrenceDate: occurrence.occurrenceDate,
        localDate,
        timezoneUsed: timeZone,
        telegramChatId: Number(candidate.telegram_user_id),
        telegramMessageId,
        sentAt: current
      });
      await repository.recordDailyReminderDelivery({
        userId: candidate.user_id,
        localDate,
        timezoneUsed: timeZone,
        reminderType: REMINDER_TYPE,
        status: "sent",
        sentAt: current
      });
      await safeEvent(repository, candidate.user_id, "planned_payment_reminder_sent", {
        local_date: localDate,
        recurrence: candidate.recurrence,
        source: "telegram"
      });
      return "sent";
    } catch (error) {
      const blocked = isBotBlockedError(error);
      await safeEvent(repository, candidate.user_id, blocked
        ? "planned_payment_reminder_blocked_or_forbidden"
        : "planned_payment_reminder_send_failed", {
        local_date: localDate,
        recurrence: candidate.recurrence,
        outcome: blocked ? "blocked" : "failed"
      });
      if (blocked) {
        await repository.markUserBotBlocked(candidate.user_id);
        return "blocked";
      }
      await repository.releasePlannedPaymentReminderClaim({
        ...claimInput,
        previousLastSentLocalDate: occurrence.previousLastSentLocalDate,
        previousNextReminderLocalDate: occurrence.previousNextReminderLocalDate
      });
      return "failed";
    }
  }
}

export function formatPlannedPaymentReminder(candidate, language = "ru", { deliveryReason = "due_today" } = {}) {
  const amount = new Intl.NumberFormat(language === "ru" ? "ru-RU" : "en-US", {
    minimumFractionDigits: ["USD", "EUR", "GEL"].includes(candidate.currency) ? 2 : 0,
    maximumFractionDigits: ["USD", "EUR", "GEL"].includes(candidate.currency) ? 2 : 0
  }).format(Number(candidate.amount));
  const item = `${escapeHtml(candidate.description)} — ${amount} ${escapeHtml(candidate.currency)}`;
  if (deliveryReason === "snoozed") {
    return language === "ru"
      ? `📅 <b>Плановая оплата</b>\n\n${item}\nВы просили напомнить об этой оплате сегодня. Уже оплатили?`
      : `📅 <b>Planned payment</b>\n\n${item}\nYou asked to be reminded about this payment today. Have you paid it?`;
  }
  return language === "ru"
    ? `📅 <b>Плановая оплата</b>\n\n${item}\nОплата запланирована на сегодня. Уже оплатили?`
    : `📅 <b>Payment planned for today</b>\n\n${item}\nHave you paid it?`;
}

function eligibleOccurrences(candidate, localDate) {
  const states = Array.isArray(candidate.reminder_states) ? candidate.reminder_states : [];
  const occurrences = states
    .filter((state) =>
      state.status === "active"
      && normalizeDate(state.next_reminder_local_date) === localDate
      && normalizeDate(state.last_sent_local_date) !== localDate)
    .map((state) => ({
      occurrenceDate: normalizeDate(state.occurrence_date),
      deliveryReason: "snoozed",
      previousLastSentLocalDate: normalizeDate(state.last_sent_local_date),
      previousNextReminderLocalDate: normalizeDate(state.next_reminder_local_date)
    }));

  const dueToday = plannedOccurrenceDateKeysForPeriod(candidate, localDate.slice(0, 7)).includes(localDate);
  const dueState = states.find((item) => normalizeDate(item.occurrence_date) === localDate);
  if (dueToday
    && !dueState?.last_sent_local_date
    && !occurrences.some(({ occurrenceDate }) => occurrenceDate === localDate)) {
    occurrences.push({
      occurrenceDate: localDate,
      deliveryReason: "due_today",
      previousLastSentLocalDate: normalizeDate(dueState?.last_sent_local_date),
      previousNextReminderLocalDate: normalizeDate(dueState?.next_reminder_local_date)
    });
  }
  return occurrences.sort((left, right) => left.occurrenceDate.localeCompare(right.occurrenceDate));
}

function normalizeDate(value) {
  return value == null ? null : String(value).slice(0, 10);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function safeEvent(repository, userId, eventName, metadata) {
  try {
    await repository.recordAppEvent?.(userId, eventName, metadata);
  } catch {
    // Analytics is best-effort and cannot block reminder delivery.
  }
}
