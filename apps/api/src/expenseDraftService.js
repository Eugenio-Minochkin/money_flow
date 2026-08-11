export class ExpenseTextNotRecognizedError extends Error {
  constructor() {
    super("amount_not_found");
    this.code = "amount_not_found";
  }
}

export class ShortcutRequestInProgressError extends Error {
  constructor() { super("shortcut_request_in_progress"); this.code = "shortcut_request_in_progress"; }
}

const shortcutInFlight = new Map();
const miniAppQuickCaptureInFlight = new Map();

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
  const key = `${tokenId}:${clientRequestId}`;
  if (shortcutInFlight.has(key)) return shortcutInFlight.get(key);
  const operation = createShortcutExpenseDraftOnce({ user, tokenId, clientRequestId, text, expenseParser, repository });
  shortcutInFlight.set(key, operation);
  try { return await operation; } finally { shortcutInFlight.delete(key); }
}

export async function createMiniAppQuickCaptureDraft({ user, clientRequestId, text, expenseParser, repository }) {
  const key = `${user.id}:${clientRequestId}`;
  if (miniAppQuickCaptureInFlight.has(key)) return miniAppQuickCaptureInFlight.get(key);
  const operation = createMiniAppQuickCaptureDraftOnce({ user, clientRequestId, text, expenseParser, repository });
  miniAppQuickCaptureInFlight.set(key, operation);
  try { return await operation; } finally { miniAppQuickCaptureInFlight.delete(key); }
}

async function createMiniAppQuickCaptureDraftOnce({ user, clientRequestId, text, expenseParser, repository }) {
  const claim = await repository.claimMiniAppQuickCaptureRequest(user.id, clientRequestId);
  if (!claim) return null;
  if (claim.state === "completed") return { draft: claim.draft, replayed: true };
  if (claim.state === "processing") {
    const completed = await repository.waitForMiniAppQuickCaptureRequest(user.id, clientRequestId);
    if (!completed) throw new ShortcutRequestInProgressError();
    return { draft: completed.draft, replayed: true };
  }
  let result;
  try {
    const items = await parseExpenseItems({ user, text, expenseParser });
    result = await repository.completeMiniAppQuickCaptureRequest({ userId: user.id, clientRequestId, claimVersion: claim.claimVersion, sourceText: text, items });
  } catch (error) {
    await repository.releaseMiniAppQuickCaptureRequest(user.id, clientRequestId, claim.claimVersion);
    throw error;
  }
  if (!result) return null;
  await repository.recordAppEvent?.(user.id, "quick_entry_draft_created", { source: "miniapp" });
  return { draft: result.draft, replayed: false };
}

async function createShortcutExpenseDraftOnce({ user, tokenId, clientRequestId, text, expenseParser, repository }) {
  const claim = await repository.claimShortcutRequest(tokenId, user.id, clientRequestId);
  if (!claim) return null;
  if (claim.state === "completed") return { draft: claim.draft, replayed: true };
  if (claim.state === "processing") {
    const completed = await repository.waitForShortcutRequest(tokenId, user.id, clientRequestId);
    if (!completed) throw new ShortcutRequestInProgressError();
    return { draft: completed.draft, replayed: true };
  }
  let result;
  try {
    const items = await parseExpenseItems({ user, text, expenseParser });
    result = await repository.completeShortcutRequest({ tokenId, userId: user.id, clientRequestId, claimVersion: claim.claimVersion, sourceText: text, items });
  } catch (error) {
    await repository.releaseShortcutRequest(tokenId, user.id, clientRequestId, claim.claimVersion);
    throw error;
  }
  if (!result) return null;
  await repository.recordAppEvent?.(user.id, "quick_entry_draft_created", { source: "ios_shortcut" });
  return { draft: result.draft, replayed: false };
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
