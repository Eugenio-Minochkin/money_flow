export function classifyExpenseEvidenceDuplicate(candidate, existingCandidates = []) {
  let possible = false;
  for (const existing of existingCandidates) {
    const amountAndCurrency = sameAmountAndCurrency(candidate, existing);
    if (!amountAndCurrency) continue;
    const dateMatch = sameDate(candidate.spentOn, existing.spentOn);
    const merchantMatch = similarMerchant(candidate.merchant, existing.merchant);
    const timeMatch = closeTime(candidate.spentAt, existing.spentAt);
    if (dateMatch && (merchantMatch || timeMatch)) {
      return { classification: "likely_duplicate", reasonCode: merchantMatch ? "amount_currency_date_merchant" : "amount_currency_date_time" };
    }
    if (dateMatch || merchantMatch) possible = true;
  }
  return possible
    ? { classification: "possible_duplicate", reasonCode: "amount_currency_date" }
    : { classification: "new", reasonCode: null };
}

function sameAmountAndCurrency(left, right) {
  return Number(left?.amount) === Number(right?.amount)
    && String(left?.currency ?? "").toUpperCase() === String(right?.currency ?? "").toUpperCase();
}

function sameDate(left, right) {
  return Boolean(left) && left === right;
}

function similarMerchant(left, right) {
  const leftTokens = merchantTokens(left);
  const rightTokens = merchantTokens(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) return false;
  const shared = leftTokens.filter((token) => rightTokens.includes(token)).length;
  return shared / Math.max(leftTokens.length, rightTokens.length) >= 0.5;
}

function merchantTokens(value) {
  return [...new Set(String(value ?? "").toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [])];
}

function closeTime(left, right) {
  const leftMinutes = minutesSinceMidnight(left);
  const rightMinutes = minutesSinceMidnight(right);
  return leftMinutes !== null && rightMinutes !== null && Math.abs(leftMinutes - rightMinutes) <= 20;
}

function minutesSinceMidnight(value) {
  if (!/^\d{2}:\d{2}$/.test(String(value ?? ""))) return null;
  const [hours, minutes] = value.split(":").map(Number);
  return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : null;
}
