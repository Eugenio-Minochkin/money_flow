import test from "node:test";
import assert from "node:assert/strict";

import { categoryName, inferCategory } from "../src/categories.js";

test("adds education category for learning expenses", () => {
  assert.equal(categoryName("education"), "Образование");
  assert.equal(inferCategory("English lesson"), "education");
  assert.equal(inferCategory("курс английского"), "education");
});

test("matches categories by whole token or exact phrase only", () => {
  assert.equal(inferCategory("coffee"), "food_cafe");
  assert.equal(inferCategory("big c"), "groceries");
  assert.equal(inferCategory("water bill"), "home");
  assert.equal(inferCategory("youtube premium"), "subscriptions");
  assert.equal(inferCategory("contact improv"), "sport_activities");
});

test("keeps deliberately ambiguous words as other", () => {
  assert.equal(inferCategory("tea"), "other");
  assert.equal(inferCategory("water"), "other");
  assert.equal(inferCategory("home"), "other");
  assert.equal(inferCategory("server"), "other");
  assert.equal(inferCategory("therapy"), "other");
  assert.equal(inferCategory("воду"), "other");
  assert.equal(inferCategory("чай"), "other");
  assert.equal(inferCategory("дом"), "other");
  assert.equal(inferCategory("сервер"), "other");
});

test("does not match keywords inside larger words", () => {
  assert.equal(inferCategory("angel"), "other");
  assert.equal(inferCategory("чайник"), "other");
});

test("matches safe Cyrillic morphology stems", () => {
  assert.equal(inferCategory("аптеку"), "health");
  assert.equal(inferCategory("аптеке"), "health");
  assert.equal(inferCategory("массажа"), "health");
  assert.equal(inferCategory("бензина"), "transport");
  assert.equal(inferCategory("продуктов"), "groceries");
  assert.equal(inferCategory("ужина"), "food_cafe");
});
