import test from "node:test";
import assert from "node:assert/strict";
import { applyMiniAppTheme } from "../src/themeBackground.js";

function themeHarness() {
  const calls = [];
  return {
    calls,
    documentElement: { dataset: {}, style: { backgroundColor: "" } },
    body: { dataset: {}, style: { backgroundColor: "" } },
    webApp: { setBackgroundColor: (color) => calls.push(color) }
  };
}

test("light theme synchronizes html body and Telegram WebView background", () => {
  const harness = themeHarness();
  const theme = applyMiniAppTheme("light", harness);

  assert.equal(theme, "light");
  assert.equal(harness.documentElement.dataset.theme, "light");
  assert.equal(harness.body.dataset.theme, "light");
  assert.equal(harness.documentElement.style.backgroundColor, "#f8f6f1");
  assert.equal(harness.body.style.backgroundColor, "#f8f6f1");
  assert.deepEqual(harness.calls, ["#f8f6f1"]);
});

test("dark theme uses the Money Flow dark surface and tolerates Telegram API absence", () => {
  const harness = themeHarness();
  delete harness.webApp;

  assert.equal(applyMiniAppTheme("dark", harness), "dark");
  assert.equal(harness.documentElement.style.backgroundColor, "#0a0f0f");
  assert.equal(harness.body.style.backgroundColor, "#0a0f0f");
});

test("unknown theme falls back to the light app background", () => {
  const harness = themeHarness();

  assert.equal(applyMiniAppTheme("system", harness), "light");
  assert.deepEqual(harness.calls, ["#f8f6f1"]);
});
