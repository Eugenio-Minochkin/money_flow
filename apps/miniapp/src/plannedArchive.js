export function createPlannedArchiveState() {
  return {
    expanded: false,
    status: "idle",
    items: [],
    stale: false,
    error: null,
    inFlight: null
  };
}

export async function expandPlannedArchive(state, { load }) {
  state.expanded = true;
  if (state.status === "loaded" && !state.stale) return state.items;
  if (state.inFlight) return state.inFlight;
  state.status = "loading";
  state.error = null;
  state.inFlight = Promise.resolve(load()).then((items) => {
    state.items = Array.isArray(items) ? items : [];
    state.status = "loaded";
    state.stale = false;
    return state.items;
  }).catch((error) => {
    state.status = "error";
    state.error = error;
    throw error;
  }).finally(() => {
    state.inFlight = null;
  });
  return state.inFlight;
}

export function collapsePlannedArchive(state) {
  state.expanded = false;
  return state.items;
}

export function invalidatePlannedArchive(state) {
  if (state.status === "loaded") state.stale = true;
  return state.expanded && state.status !== "idle";
}

export function archivePaymentCountKey(count, language = "ru") {
  if (language !== "ru") return count === 1 ? "plan.archivePaymentOne" : "plan.archivePaymentMany";
  const absolute = Math.abs(Number(count) || 0);
  const lastTwo = absolute % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return "plan.archivePaymentMany";
  const last = absolute % 10;
  if (last === 1) return "plan.archivePaymentOne";
  if (last >= 2 && last <= 4) return "plan.archivePaymentFew";
  return "plan.archivePaymentMany";
}

export function buildArchivedPlanView(item, { language = "ru", translate }) {
  const paidCount = Number(item?.paid_count ?? 0);
  const disabledAt = item?.disabled_at ?? null;
  return {
    id: item?.id,
    title: String(item?.description ?? ""),
    disabledAt,
    disabledLabel: disabledAt ? String(disabledAt) : translate("plan.archiveDateUnavailable"),
    paymentLabel: translate(archivePaymentCountKey(paidCount, language), { count: paidCount }),
    paidCount,
    paidAmountBase: Number(item?.paid_amount_base ?? 0),
    displayPaidAmount: Number(item?.display?.paid_amount ?? 0)
  };
}
