import { createShortcutExpenseDraft } from "./expenseDraftService.js";
import { classifySmartSaveDraft } from "./smartSave.js";

export async function processShortcutCapture({ now = new Date(), ...input }) {
  const created = await createShortcutExpenseDraft(input);
  if (!created) return null;

  if (created.draft.status === "confirmed") {
    return savedResult(created, await input.repository.saveDraftAsExpense(created.draft.id, input.user.telegram_user_id));
  }

  const closedMonthKeys = await input.repository.listClosedReserveMonthsForTelegramUser(input.user.telegram_user_id);
  const classification = classifySmartSaveDraft(created.draft, {
    now,
    timeZone: input.user.timezone,
    closedMonthKeys
  });
  if (!classification.eligible) {
    return {
      state: "review",
      draft: created.draft,
      reason: classification.reason,
      replayed: created.replayed
    };
  }

  return savedResult(created, await input.repository.saveDraftAsExpense(created.draft.id, input.user.telegram_user_id));
}

function savedResult(created, saved) {
  const expense = saved.expenses[0];
  return {
    state: "saved",
    expense,
    summary: formatShortcutSavedSummary(expense),
    replayed: created.replayed,
    alreadySaved: saved.alreadySaved
  };
}

export function formatShortcutSavedSummary(expense) {
  const description = String(expense?.description ?? "Expense").trim() || "Expense";
  const amount = Number(expense?.amount_original ?? expense?.amount ?? 0);
  const currency = String(expense?.currency_original ?? expense?.currency ?? "THB").toUpperCase();
  const formattedAmount = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(amount);
  return `✓ ${description} · ${formattedAmount} ${currency}`;
}
