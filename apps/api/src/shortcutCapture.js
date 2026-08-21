import { createShortcutExpenseDraft } from "./expenseDraftService.js";
import { classifySmartSaveDraft } from "./smartSave.js";

export async function processShortcutCapture({ now = new Date(), ...input }) {
  const created = await createShortcutExpenseDraft(input);
  if (!created) return null;

  if (created.draft.status === "confirmed") {
    return savedResult(created, await input.repository.saveDraftAsExpense(created.draft.id, input.user.telegram_user_id), input.user);
  }

  const closedMonthKeys = await input.repository.listClosedReserveMonthsForTelegramUser(input.user.telegram_user_id);
  const classification = classifySmartSaveDraft(created.draft, {
    now,
    timeZone: input.user.timezone,
    closedMonthKeys
  });
  if (!classification.eligible) {
    return {
      state: "review",
      draft: created.draft,
      reason: classification.reason,
      summary: shortcutTerminalSummary("review", input.user.interface_language),
      replayed: created.replayed
    };
  }

  return savedResult(created, await input.repository.saveDraftAsExpense(created.draft.id, input.user.telegram_user_id), input.user);
}

function savedResult(created, saved, user) {
  const expense = saved.expenses[0];
  return {
    state: "saved",
    expense,
    draft: created.draft,
    dashboardSnapshot: saved.dashboardSnapshot ?? null,
    summary: shortcutTerminalSummary("saved", user.interface_language),
    replayed: created.replayed,
    alreadySaved: saved.alreadySaved
  };
}

export function shortcutTerminalSummary(state, language) {
  const russian = language === "ru";
  if (state === "saved") return russian ? "Занесено." : "Saved.";
  if (state === "review") return russian
    ? "Нужно проверить расход в Telegram — откройте Money Flow."
    : "Review this expense in Telegram — open Money Flow.";
  return russian
    ? "Не удалось занести расход. Добавьте его вручную в Telegram через Money Flow."
    : "Could not save the expense. Add it manually in Money Flow on Telegram.";
}
