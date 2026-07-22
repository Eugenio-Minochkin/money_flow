export function buildPlannedDisableConfirmation(item, { translate }) {
  return translate("plannedDisable.confirmation", {
    name: String(item?.description ?? "")
  });
}

export function buildPlannedDisableResult(item, impact, { language, translate, formatMoney }) {
  const paidCount = Number(impact?.paidOccurrencesKept ?? 0);
  const unpaidCount = Number(impact?.unpaidOccurrencesRemoved ?? 0);
  const currency = String(impact?.currency ?? "THB").toUpperCase();
  const paidAmount = formatImpactMoney(impact?.paidAmountKept, currency, language, formatMoney);
  const unpaidAmount = formatImpactMoney(impact?.unpaidAmountRemoved, currency, language, formatMoney);

  return [
    translate("plannedDisable.resultTitle", { name: String(item?.description ?? "") }),
    "",
    translate(pluralKey("paid", paidCount, language), { count: paidCount, amount: paidAmount }),
    translate(pluralKey("unpaid", unpaidCount, language), { count: unpaidCount, amount: unpaidAmount }),
    "",
    translate("plannedDisable.monthUpdated"),
    translate("plannedDisable.dayUnchanged")
  ].join("\n");
}

export async function runPlannedDisable({
  button,
  item,
  confirm,
  disableRequest,
  loadDashboard,
  showResult,
  language,
  translate,
  formatMoney
}) {
  if (button.disabled || button.busy === true || button.dataset?.busy === "true") return { status: "busy" };
  if (!confirm(buildPlannedDisableConfirmation(item, { translate }))) return { status: "cancelled" };

  button.disabled = true;
  button.busy = true;
  if (button.dataset) button.dataset.busy = "true";
  try {
    const result = await disableRequest(item.id);
    await loadDashboard();
    showResult(buildPlannedDisableResult(item, result.impact, { language, translate, formatMoney }));
    return { status: "disabled", result };
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.busy = false;
      if (button.dataset) delete button.dataset.busy;
    }
  }
}

function formatImpactMoney(amount, currency, language, formatMoney) {
  const options = language === "en"
    ? { locale: "en-US", prefix: `${currency} `, suffix: "" }
    : { locale: "ru-RU" };
  return formatMoney(amount, currency, options).replaceAll(/\u00a0|\u202f/g, " ");
}

function pluralKey(kind, count, language) {
  if (language !== "ru") return `plannedDisable.${kind}${count === 1 ? "One" : "Many"}`;
  const absolute = Math.abs(count);
  const lastTwo = absolute % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return `plannedDisable.${kind}Many`;
  const last = absolute % 10;
  if (last === 1) return `plannedDisable.${kind}One`;
  if (last >= 2 && last <= 4) return `plannedDisable.${kind}Few`;
  return `plannedDisable.${kind}Many`;
}
