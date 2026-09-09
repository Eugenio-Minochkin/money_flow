import { formatDraft } from "./telegramFormat.js";

export function hasMixedDraftCurrencies(items = []) {
  const currencies = new Set(items.map((item) => normalizeDraftCurrency(item?.currency)));
  return currencies.size > 1;
}

export async function renderDraftPreview({ repository, user, items = [], language }) {
  const baseCurrency = String(user?.base_currency ?? "THB").toUpperCase();
  const hasUnresolvedCurrency = items.some((item) => item?.currency == null && item?.review_reason === "currency_ambiguous");
  const preview = !hasUnresolvedCurrency && hasMixedDraftCurrencies(items)
    ? await repository.prepareDraftPreview(items, user)
    : undefined;
  const normalizedItems = items.map((item) => ({
    ...item,
    currency: normalizeDraftCurrency(item?.currency)
  }));

  return formatDraft(normalizedItems, { language, baseCurrency, preview });
}

function normalizeDraftCurrency(currency) {
  if (currency === null) return null;
  return String(currency ?? "THB").toUpperCase();
}
