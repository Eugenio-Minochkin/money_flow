export function createTelegramJobDeliveryState() {
  return { terminalResponseDelivered: false, financialResultCommitted: false, committedResult: null };
}

export function markTelegramJobTerminalResponse(state) {
  if (state) state.terminalResponseDelivered = true;
  return state;
}

export function retainTelegramJobCommittedResult(state, result) {
  if (state && result) {
    state.financialResultCommitted = true;
    state.committedResult = result;
  }
  return state;
}

export function markTelegramJobFinancialResultCommitted(state) {
  if (state) state.financialResultCommitted = true;
  return state;
}

export function shouldNotifyTelegramJobFailure(state) {
  return state?.terminalResponseDelivered !== true;
}
