import test from "node:test";
import assert from "node:assert/strict";

import { CATEGORIES, categoryLabel, categoryName, inferCategory } from "../src/categories.js";

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

test("routes event tickets to entertainment and travel tickets to travel", () => {
  const events = [
    ["билет в кино", "entertainment"],
    ["билет в театр", "entertainment"],
    ["билет на концерт", "entertainment"],
    ["концертный билет", "entertainment"],
    ["museum ticket", "entertainment"]
  ];
  const travel = [
    ["авиабилет", "travel"],
    ["билет на самолет", "travel"],
    ["билет на самолёт", "travel"],
    ["flight ticket", "travel"],
    ["plane ticket", "travel"],
    ["flight to bangkok", "travel"]
  ];

  for (const [description, category] of events) {
    assert.equal(inferCategory(description), category, description);
  }
  for (const [description, category] of travel) {
    assert.equal(inferCategory(description), category, description);
  }
});

test("keeps a bare ambiguous ticket as other", () => {
  assert.equal(inferCategory("билет"), "other");
  assert.equal(inferCategory("ticket"), "other");
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

test("categoryLabel returns localized names for every slug without internal keys", () => {
  const slugs = CATEGORIES.map((category) => category.slug);
  assert.ok(slugs.length >= 13, "expected the full category taxonomy");

  for (const slug of slugs) {
    const ru = categoryLabel(slug, "ru");
    const en = categoryLabel(slug, "en");
    assert.ok(ru && typeof ru === "string", `ru label missing for ${slug}`);
    assert.ok(en && typeof en === "string", `en label missing for ${slug}`);
    assert.ok(!ru.includes("_"), `ru label leaked internal key: ${slug} -> ${ru}`);
    assert.ok(!en.includes("_"), `en label leaked internal key: ${slug} -> ${en}`);
  }

  assert.equal(categoryLabel("food_cafe", "en"), "Food & Cafés");
  assert.equal(categoryLabel("home", "en"), "Home");
  assert.equal(categoryLabel("gifts_help", "en"), "Gifts & Help");
  assert.equal(categoryLabel("food_cafe", "ru"), categoryName("food_cafe"));
});

test("categoryLabel falls back safely for unknown slugs and unsupported languages", () => {
  assert.equal(categoryLabel("food_cafe"), categoryName("food_cafe"));
  assert.equal(categoryLabel("food_cafe", "fr"), categoryName("food_cafe"));
  const fallback = categoryLabel("something_unexpected", "en");
  assert.ok(!fallback.includes("_"), "fallback must not leak underscores");
});
