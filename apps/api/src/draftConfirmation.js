import { formatSavedSummary } from "./telegramFormat.js";

export async function confirmDraftForApi({
  repository,
  draftId,
  telegramUserId,
  language,
  token,
  miniAppUrl,
  updateDraftMessageToSaved,
  savedSummaryKeyboard,
  telegramClient,
  logger = console
}) {
  const result = await repository.saveDraftAsExpense(draftId, telegramUserId);
  const draft = await repository.getDraftForTelegramUser(draftId, telegramUserId);
  if (draft?.tg_chat_id && draft?.tg_message_id) {
    const total = result.expenses.reduce((sum, expense) => sum + Number(expense.amount_base), 0);
    const text = formatSavedSummary(total, result.dashboardSnapshot, { language, expenses: result.expenses });
    await updateDraftMessageToSaved({
      token,
      draft,
      text,
      replyMarkup: savedSummaryKeyboard(miniAppUrl, telegramUserId, language),
      telegramClient
    }).catch((error) => logger.error("[server] confirm message update failed", error.message));
  }
  return {
    statusCode: 200,
    body: {
      expenses: result.expenses,
      dashboardSnapshot: result.dashboardSnapshot,
      alreadySaved: result.alreadySaved
    }
  };
}
