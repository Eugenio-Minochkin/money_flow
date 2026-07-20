import { formatDraft } from "./telegramFormat.js";

export function hasMixedDraftCurrencies(items = []) {
  const currencies = new Set(items.map((item) => String(item?.currency ?? "THB").toUpperCase()));
  return currencies.size > 1;
}

export async function renderDraftPreview({ repository, user, items = [], language }) {
  const baseCurrency = String(user?.base_currency ?? "THB").toUpperCase();
  const preview = hasMixedDraftCurrencies(items)
    ? await repository.prepareDraftPreview(items, user)
    : undefined;

  return formatDraft(items, { language, baseCurrency, preview });
}
