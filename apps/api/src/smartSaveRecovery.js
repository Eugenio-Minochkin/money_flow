import { CategoryRequiredError, DraftCanceledError, DraftNotFoundError } from "./repository.js";
import { classifySmartSaveDraft } from "./smartSave.js";

export async function previewSmartSaveRecovery({ telegramUserId, user, repository, now = new Date() }) {
  const owner = user ?? await repository.getUserByTelegramId(telegramUserId);
  if (!owner) return null;
  const [drafts, closedMonthKeys] = await Promise.all([
    repository.listUnresolvedDraftsForTelegramUser(telegramUserId),
    repository.listClosedReserveMonthsForTelegramUser(telegramUserId)
  ]);
  const safeDraftIds = [];
  const reviewDraftIds = [];
  for (const draft of drafts) {
    const classification = classifySmartSaveDraft(draft, {
      now,
      timeZone: owner.timezone,
      closedMonthKeys
    });
    (classification.eligible ? safeDraftIds : reviewDraftIds).push(draft.id);
  }
  return {
    totalUnresolved: drafts.length,
    safeCount: safeDraftIds.length,
    reviewCount: reviewDraftIds.length,
    safeDraftIds,
    reviewDraftIds,
    drafts
  };
}

export async function saveSmartSaveRecovery({ telegramUserId, draftIds, repository, now = new Date() }) {
  const user = await repository.getUserByTelegramId(telegramUserId);
  if (!user) return null;
  const uniqueDraftIds = [...new Set((Array.isArray(draftIds) ? draftIds : [])
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0))];
  const results = [];

  for (const draftId of uniqueDraftIds) {
    const draft = await repository.getDraftForTelegramUser(draftId, telegramUserId);
    if (!draft) {
      results.push({ draftId, state: "not_found" });
      continue;
    }
    const closedMonthKeys = await repository.listClosedReserveMonthsForTelegramUser(telegramUserId);
    const classification = classifySmartSaveDraft(draft, {
      now,
      timeZone: user.timezone,
      closedMonthKeys
    });
    if (!classification.eligible) {
      results.push({ draftId, state: "review", reason: classification.reason });
      continue;
    }
    try {
      const saved = await repository.saveDraftAsExpense(draftId, telegramUserId);
      results.push({
        draftId,
        state: saved.alreadySaved ? "already_saved" : "saved",
        expenses: saved.expenses
      });
    } catch (error) {
      if (error instanceof CategoryRequiredError) {
        results.push({ draftId, state: "review", reason: "category_required" });
      } else if (error?.code === "expense_source_month_closed") {
        results.push({ draftId, state: "review", reason: "closed_month" });
      } else if (error instanceof DraftCanceledError || error instanceof DraftNotFoundError) {
        results.push({ draftId, state: "not_found" });
      } else {
        results.push({ draftId, state: "error", reason: "save_failed" });
      }
    }
  }

  return {
    totalRequested: uniqueDraftIds.length,
    savedCount: results.filter((result) => result.state === "saved").length,
    alreadySavedCount: results.filter((result) => result.state === "already_saved").length,
    reviewCount: results.filter((result) => result.state === "review").length,
    results
  };
}
