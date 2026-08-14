import { createMiniAppQuickCaptureDraft } from "./expenseDraftService.js";
import { classifySmartSaveDraft } from "./smartSave.js";

export function isQuickCaptureAutoSaveEligible(items, options = {}) {
  return classifySmartSaveDraft({ items }, options).eligible;
}

export async function processMiniAppQuickCapture({ user, clientRequestId, text, expenseParser, repository }) {
  const result = await createMiniAppQuickCaptureDraft({ user, clientRequestId, text, expenseParser, repository });
  if (!result) return null;
  const closedMonthKeys = typeof repository.listClosedReserveMonthsForTelegramUser === "function"
    ? await repository.listClosedReserveMonthsForTelegramUser(user.telegram_user_id)
    : [];
  if (!classifySmartSaveDraft(result.draft, {
    timeZone: user.timezone,
    closedMonthKeys
  }).eligible) return result;
  const saved = await repository.saveDraftAsExpense(result.draft.id, user.telegram_user_id);
  return { saved, replayed: result.replayed };
}
