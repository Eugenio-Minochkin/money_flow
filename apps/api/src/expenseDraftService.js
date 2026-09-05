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
const telegramExpenseInFlight = new Map();

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

export async function createTelegramExpenseDraft({ user, chatId, messageId, text, expenseParser, repository, parserOptions = {}, onBeforePersist, onAfterPersist, claim: existingClaim = null }) {
  if (!Number.isSafeInteger(Number(messageId)) || typeof repository.claimTelegramExpenseCapture !== "function") {
    const draft = await createExpenseDraftFromText({ user, text, source: "telegram", expenseParser, repository, parserOptions, onBeforePersist, onAfterPersist });
    return { draft, replayed: false };
  }
  if (existingClaim?.state === "completed") return { draft: existingClaim.draft, replayed: true };
  if (existingClaim?.state === "processing") {
    const completed = await repository.waitForTelegramExpenseCapture(user.id, chatId, messageId);
    if (!completed || completed.state === "processing") throw new ShortcutRequestInProgressError();
    if (completed.state === "failed") throw new TelegramExpenseCaptureFailedError(completed.errorCode);
    return { draft: completed.draft, replayed: true };
  }
  if (existingClaim?.state === "failed") throw new TelegramExpenseCaptureFailedError(existingClaim.errorCode);
  const key = `${user.id}:${chatId}:${messageId}`;
  if (telegramExpenseInFlight.has(key)) {
    const shared = await telegramExpenseInFlight.get(key);
    return shared ? { ...shared, replayed: true } : shared;
  }
  const operation = createTelegramExpenseDraftOnce({ user, chatId, messageId, text, expenseParser, repository, parserOptions, onBeforePersist, onAfterPersist, existingClaim });
  telegramExpenseInFlight.set(key, operation);
  try { return await operation; } finally { telegramExpenseInFlight.delete(key); }
}

async function createTelegramExpenseDraftOnce({ user, chatId, messageId, text, expenseParser, repository, parserOptions, onBeforePersist, onAfterPersist, existingClaim }) {
  const claim = existingClaim ?? await repository.claimTelegramExpenseCapture(user.id, chatId, messageId);
  if (!claim) return null;
  if (claim.state === "completed") return { draft: claim.draft, replayed: true };
  if (claim.state === "failed") throw new TelegramExpenseCaptureFailedError(claim.errorCode);
  if (claim.state === "processing") {
    const completed = await repository.waitForTelegramExpenseCapture(user.id, chatId, messageId);
    if (!completed || completed.state === "processing") throw new ShortcutRequestInProgressError();
    if (completed.state === "failed") throw new TelegramExpenseCaptureFailedError(completed.errorCode);
    return { draft: completed.draft, replayed: true };
  }
  try {
    const items = await parseExpenseItems({ user, text, expenseParser, parserOptions: {
      ...parserOptions,
      requestKey: parserOptions.requestKey ?? `telegram:${user.id}:${chatId}:${messageId}`
    } });
    throwIfAborted(parserOptions.signal);
    onBeforePersist?.();
    const result = await repository.completeTelegramExpenseCapture({
      userId: user.id,
      chatId,
      messageId,
      claimVersion: claim.claimVersion,
      sourceText: text,
      items
    });
    onAfterPersist?.();
    return result ? { draft: result.draft, replayed: false } : null;
  } catch (error) {
    await repository.releaseTelegramExpenseCapture(user.id, chatId, messageId, claim.claimVersion);
    throw error;
  }
}

export class TelegramExpenseCaptureFailedError extends Error {
  constructor(code = "telegram_expense_capture_failed") {
    super(code);
    this.code = code;
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Telegram job aborted");
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
    const items = await parseExpenseItems({ user, text, expenseParser, parserOptions: {
      requestKey: `miniapp:${user.id}:${clientRequestId}`
    } });
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
    const items = await parseExpenseItems({ user, text, expenseParser, parserOptions: {
      requestKey: `shortcut:${tokenId}:${clientRequestId}`
    } });
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
