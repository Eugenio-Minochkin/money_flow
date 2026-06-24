export function buildReserveSettingsView({
  reserve,
  reserveSummary,
  template,
  currency,
  isExpanded = false,
  t,
  moneyBase
}) {
  const hasReserve = Boolean(reserve);
  const isActive = reserve?.status === "active";
  const isDisabled = reserve?.status === "disabled";
  const recurrenceEnabled = template?.is_active === true;
  const amount = reserve?.reserve_amount;
  const title = (reserve?.title ?? "").trim();
  const meta = hasReserve
    ? [moneyBase(amount, currency), title].filter(Boolean).join(" · ")
    : "";

  return {
    isExpanded,
    hasReserve,
    isActive,
    isDisabled,
    title: t("reserve.settingsTitle"),
    meta,
    status: reserveStatus({ isActive, isDisabled, reserveSummary, t }),
    disabledNote: isDisabled ? t("reserve.disabledThisMonth") : "",
    showScope: isExpanded && recurrenceEnabled,
    showDisable: isExpanded && isActive
  };
}

function reserveStatus({ isActive, isDisabled, reserveSummary, t }) {
  if (isDisabled) return t("reserve.enableAgain");
  if (!isActive) return t("reserve.add");
  if (reserveSummary?.status === "used_up") return t("reserve.statusUsedUp");
  if (reserveSummary?.status === "partially_used") return t("reserve.statusAtRisk");
  return t("reserve.statusSaved");
}
