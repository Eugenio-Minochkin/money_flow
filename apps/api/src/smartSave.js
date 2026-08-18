import { CATEGORIES } from "../../../packages/shared/src/categories.js";
import { SUPPORTED_CURRENCY_CODES } from "../../../packages/shared/src/currencies.js";
import { timeZoneMonthKey } from "../../../packages/shared/src/time.js";
import { draftNeedsCategoryChoice } from "./draftCategory.js";

const CATEGORY_SLUGS = new Set(CATEGORIES.map((category) => category.slug));
const ORDINARY_EXPENSE_IMPACTS = new Set(["regular", "large_oneoff"]);

export function classifySmartSaveDraft(draft, options = {}) {
  const items = Array.isArray(draft?.items) ? draft.items : [];
  if (items.length === 0) return rejected("no_items");
  if (items.length !== 1) return rejected("multiple_items");

  const item = items[0];
  if (item?.needs_review === true) return rejected("needs_review");
  if (draftNeedsCategoryChoice(item)) return rejected("category_required");
  if (!CATEGORY_SLUGS.has(item?.category_slug)) return rejected("invalid_category");

  const amount = Number(item?.amount);
  if (!Number.isFinite(amount) || amount <= 0) return rejected("invalid_amount");

  const currency = String(item?.currency ?? "").toUpperCase();
  if (!SUPPORTED_CURRENCY_CODES.includes(currency)) return rejected("invalid_currency");

  if (item?.spent_at == null || String(item.spent_at).trim() === "") return rejected("invalid_date");
  const spentAt = new Date(item.spent_at);
  if (Number.isNaN(spentAt.getTime())) return rejected("invalid_date");
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  if (spentAt.getTime() > now.getTime()) return rejected("future_date");

  const budgetImpact = item?.budget_impact ?? "regular";
  if (!ORDINARY_EXPENSE_IMPACTS.has(budgetImpact)) return rejected("non_expense_operation");

  const closedMonthKeys = options.closedMonthKeys instanceof Set
    ? options.closedMonthKeys
    : new Set(options.closedMonthKeys ?? []);
  const monthKey = timeZoneMonthKey(spentAt, options.timeZone ?? "Asia/Bangkok");
  if (closedMonthKeys.has(monthKey)) return rejected("closed_month");

  return { eligible: true, reason: null };
}

export function classifyExplicitAcceptanceDraft(draft, options = {}) {
  const items = Array.isArray(draft?.items) ? draft.items : [];
  if (items.length === 0) return rejected("no_items");
  for (const item of items) {
    if (!CATEGORY_SLUGS.has(item?.category_slug)) return rejected("category_required");

    const amount = Number(item?.amount);
    if (!Number.isFinite(amount) || amount <= 0) return rejected("invalid_amount");

    const currency = String(item?.currency ?? "").toUpperCase();
    if (!SUPPORTED_CURRENCY_CODES.includes(currency)) return rejected("invalid_currency");

    if (item?.spent_at == null || String(item.spent_at).trim() === "") return rejected("invalid_date");
    const spentAt = new Date(item.spent_at);
    if (Number.isNaN(spentAt.getTime())) return rejected("invalid_date");
    const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
    if (spentAt.getTime() > now.getTime()) return rejected("future_date");

    const budgetImpact = item?.budget_impact ?? "regular";
    if (!ORDINARY_EXPENSE_IMPACTS.has(budgetImpact)) return rejected("non_expense_operation");

    const closedMonthKeys = options.closedMonthKeys instanceof Set
      ? options.closedMonthKeys
      : new Set(options.closedMonthKeys ?? []);
    const monthKey = timeZoneMonthKey(spentAt, options.timeZone ?? "Asia/Bangkok");
    if (closedMonthKeys.has(monthKey)) return rejected("closed_month");
  }

  return { eligible: true, reason: null };
}

function rejected(reason) {
  return { eligible: false, reason };
}
