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
