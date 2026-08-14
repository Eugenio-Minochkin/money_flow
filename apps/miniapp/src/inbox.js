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
