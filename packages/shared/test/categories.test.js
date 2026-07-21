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

test("recognizes conservative Russian and English aliases", () => {
  const examples = [
    ["pad thai", "food_cafe"],
    ["продуктовый магазин", "groceries"],
    ["condo rent", "home"],
    ["замена масла", "transport"],
    ["dentist", "health"],
    ["боулдеринг", "sport_activities"],
    ["power bank", "gear"],
    ["guesthouse", "travel"],
    ["mobile top-up", "subscriptions"],
    ["репетитор", "education"],
    ["charity", "gifts_help"],
    ["museum", "entertainment"]
  ];

  for (const [description, category] of examples) {
    assert.equal(inferCategory(description), category, description);
  }
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
  assert.equal(inferCategory("powerbanking"), "other");
  assert.equal(inferCategory("museumify"), "other");
});

test("matches safe Cyrillic morphology stems", () => {
  const examples = [
    ["аптеку", "health"],
    ["аптеке", "health"],
    ["массажа", "health"],
    ["стоматолога", "health"],
    ["реабилитации", "health"],
    ["бензина", "transport"],
    ["парковку", "transport"],
    ["продуктов", "groceries"],
    ["ужина", "food_cafe"],
    ["аренду квартиры", "home"],
    ["тренировки", "sport_activities"],
    ["рюкзака", "gear"],
    ["отеля", "travel"],
    ["подписку", "subscriptions"],
    ["подарочный сертификат", "gifts_help"],
    ["выставки", "entertainment"]
  ];

  for (const [description, category] of examples) {
    assert.equal(inferCategory(description), category, description);
  }
});
