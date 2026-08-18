import { CategoryRequiredError, DraftCanceledError, DraftNotFoundError } from "./repository.js";
import { classifyExplicitAcceptanceDraft, classifySmartSaveDraft } from "./smartSave.js";

export async function previewSmartSaveRecovery({ telegramUserId, user, repository, now = new Date() }) {
  const owner = user ?? await repository.getUserByTelegramId(telegramUserId);
  if (!owner) return null;
  const [drafts, closedMonthKeys] = await Promise.all([
    repository.listUnresolvedDraftsForTelegramUser(telegramUserId),
    repository.listClosedReserveMonthsForTelegramUser(telegramUserId)
  ]);
  const safeDraftIds = [];
  const reviewDraftIds = [];
  const acceptDraftIds = [];
  const requiresInputDraftIds = [];
  for (const draft of drafts) {
    const classification = classifySmartSaveDraft(draft, {
      now,
      timeZone: owner.timezone,
      closedMonthKeys
    });
    (classification.eligible ? safeDraftIds : reviewDraftIds).push(draft.id);
    const acceptance = classifyExplicitAcceptanceDraft(draft, {
      now,
      timeZone: owner.timezone,
      closedMonthKeys
    });
    (acceptance.eligible ? acceptDraftIds : requiresInputDraftIds).push(draft.id);
  }
  const itemCountFor = (ids) => {
    const selected = new Set(ids.map(String));
    return drafts.reduce((sum, draft) => selected.has(String(draft.id)) ? sum + (draft.items?.length ?? 0) : sum, 0);
  };
  return {
    totalUnresolved: drafts.length,
    draftCount: drafts.length,
    itemCount: drafts.reduce((sum, draft) => sum + (draft.items?.length ?? 0), 0),
    safeCount: safeDraftIds.length,
    reviewCount: reviewDraftIds.length,
    safeDraftIds,
    reviewDraftIds,
    acceptDraftIds,
    acceptDraftCount: acceptDraftIds.length,
    acceptItemCount: itemCountFor(acceptDraftIds),
    requiresInputDraftIds,
    requiresInputDraftCount: requiresInputDraftIds.length,
    requiresInputItemCount: itemCountFor(requiresInputDraftIds),
    drafts
  };
}

export async function acceptReviewRecovery({ telegramUserId, draftIds, repository, now = new Date() }) {
  const user = await repository.getUserByTelegramId(telegramUserId);
  if (!user) return null;
  const uniqueDraftIds = normalizeDraftIds(draftIds);
  const results = [];

  for (const draftId of uniqueDraftIds) {
    try {
      const saved = await repository.confirmDraftWithExplicitAcceptance(draftId, telegramUserId, { now });
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
      } else if (explicitReviewReason(error?.code)) {
        results.push({ draftId, state: "review", reason: explicitReviewReason(error.code) });
      } else {
        results.push({ draftId, state: "error", reason: "save_failed" });
      }
    }
  }

  return recoveryResult(uniqueDraftIds, results);
}

export async function saveSmartSaveRecovery({ telegramUserId, draftIds, repository, now = new Date() }) {
  const user = await repository.getUserByTelegramId(telegramUserId);
  if (!user) return null;
  const uniqueDraftIds = normalizeDraftIds(draftIds);
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

  return recoveryResult(uniqueDraftIds, results);
}

function normalizeDraftIds(draftIds) {
  return [...new Set((Array.isArray(draftIds) ? draftIds : [])
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0))];
}

function recoveryResult(draftIds, results) {
  return {
    totalRequested: draftIds.length,
    savedCount: results.filter((result) => result.state === "saved").length,
    alreadySavedCount: results.filter((result) => result.state === "already_saved").length,
    reviewCount: results.filter((result) => result.state === "review").length,
    errorCount: results.filter((result) => result.state === "error").length,
    results
  };
}

function explicitReviewReason(code) {
  return ({
    expense_invalid_amount: "invalid_amount",
    expense_invalid_currency: "invalid_currency",
    expense_invalid_date: "invalid_date",
    expense_future_date: "future_date",
    expense_operation_not_supported: "non_expense_operation"
  })[code] ?? null;
}
