import assert from "node:assert/strict";
import test from "node:test";

import { normalizeVoiceMoneyTranscript } from "../src/voiceMoneyNormalization.js";

test("normalizes an unambiguous currency-qualified spoken decimal", () => {
  for (const [input, expected] of [
    ["Такси 8,50 лари", "Такси 8.50 лари"],
    ["Такси 8.50 лари", "Такси 8.50 лари"],
    ["Такси 8-50 лари", "Такси 8.50 лари"],
    ["Такси 8:50 лари", "Такси 8.50 лари"],
    ["Такси 8 50 лари", "Такси 8.50 лари"],
    ["Такси восемь пятьдесят лари", "Такси 8.50 лари"],
    ["Taxi 8:50 dollars", "Taxi 8.50 dollars"]
  ]) {
    assert.equal(normalizeVoiceMoneyTranscript(input), expected, input);
  }
});

test("does not reinterpret time-like or multi-amount speech without one safe money shape", () => {
  for (const input of [
    "встреча в 8:50",
    "Такси 8:50 лари и кофе 3 лари",
    "5 сентября в 8:50 лари",
    "Такси 8-50 без валюты"
  ]) {
    assert.equal(normalizeVoiceMoneyTranscript(input), input, input);
  }
});
