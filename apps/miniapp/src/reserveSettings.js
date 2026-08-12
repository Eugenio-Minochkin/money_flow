export function buildReserveSettingsView({
  reserve,
  reserveSummary,
  template,
  currency,
  displayAmount,
  displayCurrency,
  isExpanded = false,
  t,
  moneyBase,
  moneyDisplay
}) {
  const hasReserve = Boolean(reserve);
  const isActive = reserve?.status === "active";
  const isDisabled = reserve?.status === "disabled";
  const recurrenceEnabled = template?.is_active === true;
  const amount = reserve?.reserve_amount;
  const title = (reserve?.title ?? "").trim();
  const display = isActive && displayCurrency && displayCurrency !== currency
    ? moneyDisplay?.(displayAmount, displayCurrency)
    : "";
  const meta = hasReserve
    ? [title, moneyBase(amount, currency), display].filter(Boolean).join(" · ")
    : t("reserve.notSet");

  return {
    isExpanded,
    hasReserve,
    isActive,
    isDisabled,
    title: t("reserve.settingsTitle"),
    meta,
    description: hasReserve
      ? t(recurrenceEnabled ? "reserve.everyMonth" : "reserve.thisMonth")
      : t("reserve.explanation"),
    status: reserveStatus({ isActive, isDisabled, t }),
    disabledNote: isDisabled ? t("reserve.disabledThisMonth") : "",
    showScope: isExpanded && recurrenceEnabled,
    showDisable: isExpanded && isActive
  };
}

function reserveStatus({ isActive, isDisabled, t }) {
  if (isDisabled) return t("reserve.enableAgain");
  if (!isActive) return t("reserve.add");
  return t("actions.edit");
}
