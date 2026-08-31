export function createTelegramJobDeliveryState() {
  return { terminalResponseDelivered: false };
}

export function markTelegramJobTerminalResponse(state) {
  if (state) state.terminalResponseDelivered = true;
  return state;
}

export function shouldNotifyTelegramJobFailure(state) {
  return state?.terminalResponseDelivered !== true;
}
