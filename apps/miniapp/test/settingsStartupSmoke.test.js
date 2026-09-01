import test from "node:test";
import assert from "node:assert/strict";
import { assertSettingsInitialized } from "../src/settingsStartupSmoke.js";

function documentWith(controls) {
  return { querySelector: (selector) => controls[selector] ?? null };
}

test("Settings startup smoke accepts persisted currencies, localized follow-base label and timezone label", () => {
  const document = documentWith({
    "#baseCurrencyInput": { value: "THB", options: [{ value: "THB" }] },
    "#displayCurrencyInput": { value: "USD", options: [{ value: "USD" }] },
    "#displayCurrencyFollowsBaseLabel": { textContent: "Такая же, как базовая", hidden: false },
    "#timezonePickerButton": { textContent: "UTC+07:00 · Bangkok" }
  });

  assert.doesNotThrow(() => assertSettingsInitialized({
    document,
    user: { base_currency: "THB", display_currency: "USD" },
    followBaseLabel: "Такая же, как базовая"
  }));
});

test("Settings startup smoke rejects an empty timezone label", () => {
  const document = documentWith({
    "#baseCurrencyInput": { value: "THB", options: [{ value: "THB" }] },
    "#displayCurrencyInput": { value: "USD", options: [{ value: "USD" }] },
    "#displayCurrencyFollowsBaseLabel": { textContent: "Такая же, как базовая", hidden: false },
    "#timezonePickerButton": { textContent: "" }
  });

  assert.throws(() => assertSettingsInitialized({
    document,
    user: { base_currency: "THB", display_currency: "USD" },
    followBaseLabel: "Такая же, как базовая"
  }), /settings_timezone_uninitialized/);
});
