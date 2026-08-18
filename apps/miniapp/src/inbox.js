export function inboxDraftTotal(draft) {
  return (draft.items ?? []).reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
}

export function inboxDraftDescription(draft) {
  return (draft.items ?? [])
    .map((item) => item.description)
    .filter(Boolean)
    .join(", ") || draft.source_text || "Черновик";
}

export function updateFirstInboxItemCategory(draft, categorySlug) {
  const items = draft.items ?? [];
  return items.map((item, index) => index === 0
    ? { ...item, category_slug: categorySlug, needs_review: false, confidence: 0.9 }
    : { ...item });
}

export function shouldShowInboxOnDashboard(drafts) {
  return Array.isArray(drafts) && drafts.length > 0;
}

export function inboxSummaryPreview(drafts, language = "en", formatMoney = (amount, currency) => `${amount} ${currency}`) {
  const firstItem = drafts?.[0]?.items?.[0];
  if (!firstItem) return "";
  const description = firstItem.description || drafts[0].source_text || (language === "ru" ? "Черновик" : "Draft");
  const currency = firstItem.currency ?? firstItem.currency_original ?? "THB";
  const preview = `${description} · ${formatMoney(Number(firstItem.amount ?? 0), currency)}`;
  const remaining = drafts.length - 1;
  if (remaining <= 0) return preview;
  return `${preview} · ${language === "ru" ? `+ ещё ${remaining}` : `+ ${remaining} more`}`;
}

export function inboxCountLabel(count, language = "en") {
  const total = Math.max(0, Number(count) || 0);
  if (language === "ru") {
    const lastTwo = total % 100;
    const lastOne = total % 10;
    const word = lastOne === 1 && lastTwo !== 11
      ? "трату"
      : lastOne >= 2 && lastOne <= 4 && (lastTwo < 12 || lastTwo > 14)
        ? "траты"
        : "трат";
    return `Нужно проверить ${total} ${word}`;
  }
  return `Review ${total} ${total === 1 ? "expense" : "expenses"}`;
}

export function smartSaveRecoveryTitle(count, language = "en") {
  const total = Math.max(0, Number(count) || 0);
  if (language === "ru") {
    const lastTwo = total % 100;
    const lastOne = total % 10;
    const word = lastOne === 1 && lastTwo !== 11
      ? "расход"
      : lastOne >= 2 && lastOne <= 4 && (lastTwo < 12 || lastTwo > 14)
        ? "расхода"
        : "расходов";
    return `Нужно разобрать ${total} ${word}`;
  }
  return `Review ${total} ${total === 1 ? "expense" : "expenses"}`;
}

export function smartSaveRecoverySummary(preview, language = "en") {
  const safe = Math.max(0, Number(preview?.safeCount) || 0);
  const review = Math.max(0, Number(preview?.reviewCount) || 0);
  return language === "ru"
    ? `${safe} можно сохранить сразу · ${review} нужно уточнить`
    : `${safe} can be saved now · ${review} need review`;
}

export function smartSaveRecoveryPrimaryAction(count, language = "en") {
  const total = Math.max(0, Number(count) || 0);
  return language === "ru" ? `Сохранить ${total} понятных` : `Save ${total} clear`;
}

export function smartSaveRecoveryReviewAction(count, language = "en") {
  const total = Math.max(0, Number(count) || 0);
  return language === "ru" ? `Разобрать ${total}` : `Review ${total}`;
}

export function reviewAcceptanceTitle(preview, language = "en") {
  const total = Math.max(0, Number(preview?.itemCount) || 0);
  if (language === "ru") return `Нужно разобрать ${total} ${russianExpenseWord(total)}`;
  return `Review ${total} ${total === 1 ? "expense" : "expenses"}`;
}

export function reviewAcceptanceSummary(preview, language = "en") {
  const accepted = Math.max(0, Number(preview?.acceptItemCount) || 0);
  const required = Math.max(0, Number(preview?.requiresInputItemCount) || 0);
  if (language === "ru") {
    if (!required) return `${accepted} можно сохранить как есть`;
    if (!accepted) return `${required} требуют исправления`;
    return `${accepted} можно сохранить как есть · ${required} требуют исправления`;
  }
  if (!required) return `${accepted} can be saved as is`;
  if (!accepted) return `${required} need changes`;
  return `${accepted} can be saved as is · ${required} need changes`;
}

export function reviewAcceptancePrimaryAction(count, language = "en") {
  const total = Math.max(0, Number(count) || 0);
  return language === "ru" ? `Сохранить ${total} как есть` : `Save ${total} as is`;
}

export function reviewAcceptanceReviewAction(preview, language = "en") {
  const required = Math.max(0, Number(preview?.requiresInputItemCount) || 0);
  const total = required || Math.max(0, Number(preview?.itemCount) || 0);
  return language === "ru" ? `Разобрать ${total}` : `Review ${total}`;
}

export function reviewAcceptanceConfirmMessage(count, language = "en") {
  const total = Math.max(0, Number(count) || 0);
  if (language === "ru") {
    return `Сохранить эти расходы как есть?\n\nСуммы, даты и текущие категории будут приняты.\nКатегории, в которых бот сомневался, можно будет исправить позже в Истории.\n\nСохранить ${total}`;
  }
  return `Save these expenses as is?\n\nAmounts, dates, and current categories will be accepted.\nCategories the bot was unsure about can be changed later in History.\n\nSave ${total}`;
}

export function reviewAcceptanceErrorMessage(error, language = "en") {
  const code = error?.body?.error ?? error?.code ?? error?.message ?? "";
  const network = /failed to fetch|networkerror|network request failed/i.test(String(code));
  const messages = language === "ru" ? {
    category_required: "Нужно выбрать категорию",
    expense_source_month_closed: "Этот месяц уже закрыт",
    expense_invalid_amount: "Проверьте сумму расхода",
    expense_invalid_currency: "Выберите поддерживаемую валюту",
    expense_invalid_date: "Проверьте дату расхода",
    expense_future_date: "Дата расхода не может быть в будущем",
    expense_operation_not_supported: "Эту операцию нельзя сохранить как обычный расход"
  } : {
    category_required: "Choose a category",
    expense_source_month_closed: "This month is already closed",
    expense_invalid_amount: "Check the expense amount",
    expense_invalid_currency: "Choose a supported currency",
    expense_invalid_date: "Check the expense date",
    expense_future_date: "The expense date cannot be in the future",
    expense_operation_not_supported: "This operation cannot be saved as a regular expense"
  };
  if (messages[code]) return messages[code];
  if (network) return language === "ru" ? "Не удалось сохранить. Попробуйте ещё раз" : "Could not save. Please try again";
  return language === "ru" ? "Не удалось сохранить. Попробуйте ещё раз" : "Could not save. Please try again";
}

function russianExpenseWord(total) {
  const lastTwo = total % 100;
  const lastOne = total % 10;
  if (lastOne === 1 && lastTwo !== 11) return "трату";
  if (lastOne >= 2 && lastOne <= 4 && (lastTwo < 12 || lastTwo > 14)) return "траты";
  return "трат";
}
