import test from "node:test";
import assert from "node:assert/strict";
import { shouldRequestTelegramFullscreen } from "../src/telegramPlatform.js";

test("Telegram mobile platforms may request fullscreen", () => {
  for (const platform of ["ios", "android", "android_x", "ANDROID"]) {
    assert.equal(shouldRequestTelegramFullscreen(platform), true, platform);
  }
});

test("Telegram desktop, web, and unknown platforms stay in the native shell", () => {
  for (const platform of ["tdesktop", "macos", "weba", "webk", "unigram", "unknown", "", null, undefined]) {
    assert.equal(shouldRequestTelegramFullscreen(platform), false, String(platform));
  }
});
