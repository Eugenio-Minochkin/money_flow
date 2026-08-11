export function describeQuickCaptureSavedResult(expenses) {
  if (!Array.isArray(expenses) || expenses.length === 0) return { kind: "empty" };
  if (expenses.length === 1) return { kind: "single", expense: expenses[0] };
  return { kind: "multiple", count: expenses.length };
}
