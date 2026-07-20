import { formatDraft } from "./telegramFormat.js";

export function hasMixedDraftCurrencies(items = []) {
  const currencies = new Set(items.map((item) => normalizeDraftCurrency(item?.currency)));
  return currencies.size > 1;
}

export async function renderDraftPreview({ repository, user, items = [], language }) {
  const baseCurrency = String(user?.base_currency ?? "THB").toUpperCase();
  const preview = hasMixedDraftCurrencies(items)
    ? await repository.prepareDraftPreview(items, user)
    : undefined;
  const normalizedItems = items.map((item) => ({
    ...item,
    currency: normalizeDraftCurrency(item?.currency)
  }));

  return formatDraft(normalizedItems, { language, baseCurrency, preview });
}

function normalizeDraftCurrency(currency) {
  return String(currency ?? "THB").toUpperCase();
}
