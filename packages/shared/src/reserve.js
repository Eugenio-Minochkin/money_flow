export function validateReserveCapacity({
  budgetAmount,
  plannedAmount = 0,
  reserveAmount = 0
}) {
  const freeBudget = roundMoney(Number(budgetAmount) - Number(plannedAmount));
  return {
    valid: Number(reserveAmount) >= 0 && Number(reserveAmount) <= freeBudget,
    freeBudget
  };
}

export function calculateReserveState({
  budgetAmount,
  plannedAmount = 0,
  reserveAmount = 0,
  regularSpentAmount = 0
}) {
  const reserve = Math.max(Number(reserveAmount), 0);
  const availableRegular = roundMoney(Number(budgetAmount) - Number(plannedAmount) - reserve);
  const savedAmount = roundMoney(clamp(availableRegular + reserve - Number(regularSpentAmount), 0, reserve));
  const eatenAmount = roundMoney(reserve - savedAmount);
  const overBudgetAmount = roundMoney(Math.max(0, Number(regularSpentAmount) - (availableRegular + reserve)));
  const status = overBudgetAmount > 0
    ? "used_up_and_over_budget"
    : savedAmount === reserve
      ? "saved"
      : savedAmount > 0
        ? "partially_used"
        : "used_up";

  return { availableRegular, savedAmount, eatenAmount, overBudgetAmount, status };
}

export function calculateReserveForecast({
  dayOfMonth,
  daysInMonth,
  regularSpentAmount,
  budgetAmount,
  plannedAmount = 0,
  reserveAmount = 0
}) {
  if (Number(dayOfMonth) <= 4) {
    return {
      status: "early",
      forecastRegularSpentAmount: null,
      savedAmount: null,
      eatenAmount: null,
      overBudgetAmount: null
    };
  }

  const forecastRegularSpentAmount = roundMoney(
    (Number(regularSpentAmount) / Number(dayOfMonth)) * Number(daysInMonth)
  );
  return {
    forecastRegularSpentAmount,
    ...calculateReserveState({
      budgetAmount,
      plannedAmount,
      reserveAmount,
      regularSpentAmount: forecastRegularSpentAmount
    })
  };
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
