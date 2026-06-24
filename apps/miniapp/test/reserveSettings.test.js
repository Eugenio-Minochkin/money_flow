import test from "node:test";
import assert from "node:assert/strict";
import { buildReserveSettingsView } from "../src/reserveSettings.js";

const t = (key) => ({
  "reserve.settingsTitle": "Budget reserve",
  "reserve.add": "Add",
  "reserve.enableAgain": "Enable again",
  "reserve.disabledThisMonth": "Reserve disabled this month",
  "reserve.statusSaved": "Saved",
  "reserve.statusAtRisk": "At risk",
  "reserve.statusUsedUp": "Used up"
})[key] ?? key;

const moneyBase = (value, currency = "THB") => `${Math.round(Number(value))} ${currency}`;

test("builds a collapsed add row when there is no reserve", () => {
  const view = buildReserveSettingsView({ reserve: null, reserveSummary: null, currency: "THB", t, moneyBase });

  assert.equal(view.isExpanded, false);
  assert.equal(view.title, "Budget reserve");
  assert.equal(view.meta, "");
  assert.equal(view.status, "Add");
  assert.equal(view.showScope, false);
  assert.equal(view.showDisable, false);
});

test("builds a collapsed active reserve row with amount, title, and status", () => {
  const view = buildReserveSettingsView({
    reserve: { status: "active", reserve_amount: "4000", title: "Trip" },
    reserveSummary: { status: "partially_used" },
    template: { is_active: true },
    currency: "THB",
    t,
    moneyBase
  });

  assert.equal(view.isExpanded, false);
  assert.equal(view.meta, "4000 THB · Trip");
  assert.equal(view.status, "At risk");
  assert.equal(view.showScope, false);
  assert.equal(view.showDisable, false);
});

test("shows scope and disable controls only in expanded active recurring settings", () => {
  const view = buildReserveSettingsView({
    reserve: { status: "active", reserve_amount: "4000", title: "Trip" },
    reserveSummary: { status: "saved" },
    template: { is_active: true },
    currency: "THB",
    isExpanded: true,
    t,
    moneyBase
  });

  assert.equal(view.isExpanded, true);
  assert.equal(view.showScope, true);
  assert.equal(view.showDisable, true);
});

test("keeps disabled reserve compact with an enable action", () => {
  const view = buildReserveSettingsView({
    reserve: { status: "disabled", reserve_amount: "1000", title: "Test" },
    reserveSummary: null,
    currency: "THB",
    t,
    moneyBase
  });

  assert.equal(view.isExpanded, false);
  assert.equal(view.meta, "1000 THB · Test");
  assert.equal(view.status, "Enable again");
  assert.equal(view.disabledNote, "Reserve disabled this month");
  assert.equal(view.showScope, false);
});
