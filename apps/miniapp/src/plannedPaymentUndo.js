export function buildPlannedPaymentUndoConfirmation(occurrenceDate, { translate, formatOccurrenceDate }) {
  return translate("plannedPaymentUndo.confirmation", {
    date: formatOccurrenceDate(occurrenceDate)
  });
}

export function paidPlannedPaymentUndoOccurrences(item) {
  const dates = new Set(Array.isArray(item?.paid_occurrence_dates) ? item.paid_occurrence_dates : []);
  if (item?.paid_occurrences && typeof item.paid_occurrences === "object") {
    for (const [occurrenceDate, payment] of Object.entries(item.paid_occurrences)) {
      if (payment?.expense_id) dates.add(occurrenceDate);
    }
  }
  return [...dates]
    .map((value) => String(value).slice(0, 10))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
    .sort();
}

export async function runPlannedPaymentUndo({
  button,
  item,
  occurrenceDate,
  confirm,
  undoRequest,
  loadDashboard,
  loadHistory,
  showToast,
  showError,
  translate,
  formatOccurrenceDate
}) {
  if (button.disabled || button.busy === true || button.dataset?.busy === "true") return { status: "busy" };
  if (!confirm(buildPlannedPaymentUndoConfirmation(occurrenceDate, { translate, formatOccurrenceDate }))) {
    return { status: "cancelled" };
  }

  button.disabled = true;
  button.busy = true;
  if (button.dataset) button.dataset.busy = "true";
  try {
    const result = await undoRequest(item.id, occurrenceDate);
    await Promise.allSettled([loadDashboard(), loadHistory()]);
    const status = result?.status === "already_unpaid" ? "already_unpaid" : "undone";
    showToast(translate(status === "already_unpaid" ? "toast.plannedPaymentAlreadyUndone" : "toast.plannedPaymentUndone"));
    return { status, result };
  } catch (error) {
    const code = String(error?.body?.error ?? error?.message ?? "");
    const messageKey = code === "planned_payment_undo_blocked"
      ? "toast.plannedPaymentUndoBlocked"
      : code === "planned_payment_inconsistent"
        ? "toast.plannedPaymentUndoInconsistent"
        : "toast.plannedPaymentUndoFailed";
    if (typeof showError === "function") showError(translate(messageKey));
    return { status: "error", error };
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.busy = false;
      if (button.dataset) delete button.dataset.busy;
    }
  }
}
