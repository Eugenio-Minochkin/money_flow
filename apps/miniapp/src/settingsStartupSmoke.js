export function assertSettingsInitialized({ document, user, followBaseLabel }) {
  assertCurrencyControl(document.querySelector("#baseCurrencyInput"), user?.base_currency ?? "THB", "settings_base_currency_uninitialized");
  assertCurrencyControl(document.querySelector("#displayCurrencyInput"), user?.display_currency ?? "USD", "settings_display_currency_uninitialized");

  const followBase = document.querySelector("#displayCurrencyFollowsBaseLabel");
  if (!followBase || followBase.hidden || followBase.textContent?.trim() !== followBaseLabel) {
    throw new Error("settings_follow_base_label_uninitialized");
  }

  const timezone = document.querySelector("#timezonePickerButton")?.textContent?.trim();
  if (!timezone || !/^UTC[+−-]\d{2}:\d{2}\s+·\s+.+/.test(timezone)) {
    throw new Error("settings_timezone_uninitialized");
  }
}

function assertCurrencyControl(control, expectedValue, errorCode) {
  if (!control || !control.options?.length || control.value !== expectedValue) {
    throw new Error(errorCode);
  }
}
