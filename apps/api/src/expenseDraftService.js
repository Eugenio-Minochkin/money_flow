export class ExpenseTextNotRecognizedError extends Error {
  constructor() {
    super("amount_not_found");
    this.code = "amount_not_found";
  }
}

export async function createExpenseDraftFromText({ user, text, source, expenseParser, repository, parserOptions = {}, onBeforePersist, onAfterPersist }) {
  const items = await parseExpenseItems({ user, text, expenseParser, parserOptions });
  onBeforePersist?.();
  let draft;
  try { draft = await repository.createDraft(user.id, text, items); } catch (error) { error.expenseDraftStage = "persist"; throw error; }
  onAfterPersist?.();
  if (source !== "telegram") await repository.recordAppEvent?.(user.id, "quick_entry_draft_created", { source });
  return { ...draft, items };
}

export async function createShortcutExpenseDraft({ user, tokenId, clientRequestId, text, expenseParser, repository }) {
  const result = await repository.createShortcutDraft({
    tokenId,
    userId: user.id,
    clientRequestId,
    sourceText: text,
    createItems: () => parseExpenseItems({ user, text, expenseParser })
  });
  if (!result) return null;
  if (!result.replayed) await repository.recordAppEvent?.(user.id, "quick_entry_draft_created", { source: "ios_shortcut" });
  return result;
}

async function parseExpenseItems({ user, text, expenseParser, parserOptions = {} }) {
  const parsed = await expenseParser.parse(text, {
    userId: user.id,
    defaultCurrency: user.base_currency ?? "THB",
    timeZone: user.timezone,
    ...parserOptions
  });
  const items = parsed?.expenses ?? [];
  if (items.length === 0) throw new ExpenseTextNotRecognizedError();
  return items;
}
