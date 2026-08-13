const prefix = "mf:";
const debug = new URLSearchParams(window.location.search).get("debugStartup") === "1";

export function markStartup(name) {
  performance.mark(`${prefix}${name}`);
  if (name === "dashboard_response_received") {
    measure("mf:dashboard_request", "mf:dashboard_request_start", "mf:dashboard_response_received");
  }
  if (name === "dashboard_rendered") {
    measure("mf:dashboard_render", "mf:dashboard_response_received", "mf:dashboard_rendered");
  }
  if (name === "history_request_finish") {
    measure("mf:history_request", "mf:history_request_start", "mf:history_request_finish");
    publishDebugTimings();
  }
}

export function finishStartup() {
  measure("mf:telegram_sdk", "mf:html_start", "mf:telegram_sdk_available");
  measure("mf:app_bootstrap", "mf:telegram_sdk_available", "mf:app_evaluated");
  measure("mf:dashboard_total", "mf:html_start", "mf:dashboard_usable");
  publishDebugTimings();
}

function measure(name, start, end) {
  try {
    performance.measure(name, start, end);
  } catch {
    // Older or restricted WebViews may not retain every startup mark.
  }
}

function publishDebugTimings() {
  if (!debug) return;
  window.__moneyFlowStartupTimings = Object.fromEntries(
    performance.getEntriesByType("measure")
      .filter((entry) => entry.name.startsWith(prefix))
      .map((entry) => [entry.name.slice(prefix.length), Math.round(entry.duration * 10) / 10])
  );
}
