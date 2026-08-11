import { draftNeedsCategoryChoice } from "./draftCategory.js";
import { createMiniAppQuickCaptureDraft } from "./expenseDraftService.js";

export function isQuickCaptureAutoSaveEligible(items) {
  return Array.isArray(items)
    && items.length === 1
    && items[0]?.needs_review !== true
    && !draftNeedsCategoryChoice(items[0]);
}

export async function processMiniAppQuickCapture({ user, clientRequestId, text, expenseParser, repository }) {
  const result = await createMiniAppQuickCaptureDraft({ user, clientRequestId, text, expenseParser, repository });
  if (!result) return null;
  if (!isQuickCaptureAutoSaveEligible(result.draft.items)) return result;
  const saved = await repository.saveDraftAsExpense(result.draft.id, user.telegram_user_id);
  return { saved, replayed: result.replayed };
}
