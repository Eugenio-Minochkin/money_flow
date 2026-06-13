export function shouldShowCurrentMonthBudgetOverride(currentMonthBudget, now = new Date()) {
  return Boolean(
    currentMonthBudget?.hasOverride
    && currentMonthBudget?.isPartialMonth
    && currentMonthBudget?.monthKey === localMonthKey(now)
  );
}

function localMonthKey(now) {
  const local = new Date(now.getTime() + 7 * 60 * 60_000);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}`;
}
