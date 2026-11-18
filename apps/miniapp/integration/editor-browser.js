import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";

let browser;
let dist;
test.before(async () => {
  dist = await mkdtemp(join(tmpdir(), "money-flow-browser-"));
  execFileSync(process.execPath, ["apps/miniapp/build.mjs", "--outdir", dist]);
  browser = await chromium.launch({ channel: "chrome" });
});
test.after(async () => {
  await browser?.close();
  if (dist) await rm(dist, { recursive: true, force: true });
});

const spentAt = "2026-10-31T12:30:45.678Z";
const expense = { id: 1, amount_original: 200, currency_original: "USD", amount_base: 200,
  description: "Monitor", budget_impact: "large_oneoff", category_slug: "electronics", tags: [], spent_at: spentAt };
const draft = { id: 7, version: 1, status: "inbox", items: [
  { amount: 100, currency: null, currency_candidates: ["ARS", "MXN"], review_reason: "currency_ambiguous",
    needs_review: true, description: "Coffee", category_slug: "food_cafe", category_source: "parser", spent_at: spentAt }
] };

async function openApp(t, { query = "", device = "America/New_York", profile = "Asia/Bangkok", api } = {}) {
  const page = await browser.newPage({ timezoneId: device, viewport: { width: 390, height: 844 } });
  t.after(() => page.close());
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.clock.setFixedTime(new Date("2026-11-01T03:30:00Z"));
  const user = { base_currency: "USD", display_currency: "USD", timezone: profile, interface_language: "en" };
  const routes = {
    "/api/dashboard": { user, snapshot: { month: 200, monthlyBudget: 1000, display: { currency: "USD" } } },
    "/api/expenses": { expenses: [expense] },
    "/api/drafts/recovery-preview": { drafts: [], totalUnresolved: 0 },
    "/api/drafts/7": { draft },
    "/api/drafts/7/confirm": { expenses: [] },
    "/api/expenses/1": { expense },
    "/api/startup-timing": {},
    "/api/quick-access/events": {}
  };
  await page.route("**/*", async route => {
    const path = new URL(route.request().url()).pathname;
    if (["/", "/app.js", "/styles.css"].includes(path)) {
      return route.fulfill({ path: join(dist, path === "/" ? "index.html" : path.slice(1)) });
    }
    if (path === "/js/telegram-web-app.js") return route.fulfill({ contentType: "text/javascript", body: "" });
    if (api && await api(path, route)) return;
    if (Object.hasOwn(routes, path)) return route.fulfill({ json: routes[path] });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("http://localhost/?telegramUserId=1&" + query);
  await page.locator("#openQuickEntryButton").waitFor();
  return page;
}

test("full draft editor requires an explicit candidate before confirming pesos", async t => {
  const page = await openApp(t, { query: "draftId=7" });
  const currency = page.locator("[name=draft-0-currency]");
  await currency.waitFor({ state: "attached" });
  assert.equal(await currency.inputValue(), "");
  assert.deepEqual(await currency.locator("option").evaluateAll(nodes => nodes.map(n => n.value)), ["", "ARS", "MXN"]);
  const writes = [];
  page.on("request", request => { if (request.method() === "PATCH") writes.push(request.postDataJSON()); });
  await page.locator("#confirmDraftButton").click();
  assert.equal(await currency.evaluate(el => el.validity.valueMissing), true);
  await currency.selectOption("MXN");
  const confirmation = page.waitForRequest("**/api/drafts/7/confirm");
  await page.locator("#confirmDraftButton").click();
  await confirmation;
  assert.deepEqual(writes.map(body => body.items[0].currency), ["MXN"]);
});

test("quick review offers the same explicit currency choice", async t => {
  const page = await openApp(t, { api: async (path, route) => {
    if (path !== "/api/quick-entry") return false;
    await route.fulfill({ json: { draft } });
    return true;
  } });
  await page.locator("#openQuickEntryButton").click();
  await page.locator("#quickEntryText").fill("coffee 100 pesos");
  await page.locator("#quickEntrySubmit").click();
  await page.locator("#quickCaptureReviewSubmit").waitFor();
  const currency = page.locator("#quickCaptureReview select[name$='-currency']");
  assert.equal(await currency.count(), 1);
  assert.equal(await currency.inputValue(), "");
  assert.deepEqual(await currency.locator("option").evaluateAll(nodes => nodes.map(n => n.value)), ["", "ARS", "MXN"]);
  await currency.selectOption("ARS");
  const patch = page.waitForRequest(request => request.method() === "PATCH");
  await page.locator("#quickCaptureReviewSubmit").click();
  assert.equal((await patch).postDataJSON().items[0].currency, "ARS");
});

test("reopening Quick Capture after a lost response replays one operation; a new entry gets a new key", async t => {
  const keys = [];
  const page = await openApp(t, { api: async (path, route) => {
    if (path !== "/api/quick-entry") return false;
    keys.push(route.request().postDataJSON().clientRequestId);
    if (keys.length === 1) await route.abort("failed");
    else await route.fulfill({ json: { saved: { expenses: [expense] } } });
    return true;
  } });
  const open = page.locator("#openQuickEntryButton");
  const submit = page.locator("#quickEntrySubmit");
  await open.click();
  await page.locator("#quickEntryText").fill("coffee 20 USD");
  await submit.click();
  await page.locator("#quickEntryStatus").getByText(/reach the server/).waitFor();
  await page.locator("#quickEntryBackdrop").click({ position: { x: 10, y: 10 } });
  await open.click();
  await page.locator("#quickEntryText").fill("coffee 20 USD ");
  await submit.click();
  await page.locator("#quickEntrySheet").waitFor({ state: "hidden" });
  assert.equal(keys[0], keys[1]);
  await page.locator("#toast").waitFor({ state: "hidden", timeout: 10_000 });
  await open.click();
  await page.locator("#quickEntryText").fill("coffee 20 USD");
  await submit.click();
  await page.locator("#quickEntrySheet").waitFor({ state: "hidden" });
  assert.notEqual(keys[2], keys[1]);
});

test("history description edits preserve impact and the exact instant with a different device timezone", async t => {
  const page = await openApp(t, { query: "view=history" });
  await page.locator("#historyList [data-edit-expense]").click();
  await page.locator("[name=expense-description]").fill("Edited monitor");
  const patch = page.waitForRequest(request => request.method() === "PATCH");
  await page.locator("#expenseForm button[type=submit]").click();
  const item = (await patch).postDataJSON().expense;
  assert.equal(item.budget_impact, "large_oneoff");
  assert.equal(item.spent_at, spentAt);
});

test("retrying a review after the confirm response is lost recovers the saved receipt", async t => {
  let confirmed = false;
  const versions = [];
  const page = await openApp(t, { api: async (path, route) => {
    if (path === "/api/quick-entry") await route.fulfill({ json: { draft } });
    else if (path === "/api/drafts/7" && route.request().method() === "PATCH") {
      if (confirmed) await route.fulfill({ status: 409, json: { error: "draft_already_confirmed" } });
      else await route.fulfill({ json: { draft: { ...draft, version: 2, items: route.request().postDataJSON().items } } });
    } else if (path === "/api/drafts/7/confirm") {
      versions.push(route.request().postDataJSON().expectedVersion);
      if (confirmed) await route.fulfill({ json: { expenses: [expense], alreadySaved: true } });
      else { confirmed = true; await route.abort("failed"); }
    } else return false;
    return true;
  } });
  await page.locator("#openQuickEntryButton").click();
  await page.locator("#quickEntryText").fill("coffee 100 pesos");
  await page.locator("#quickEntrySubmit").click();
  await page.locator("#quickCaptureReview select[name$='-currency']").selectOption("MXN");
  await page.locator("#quickCaptureReviewSubmit").click();
  await page.locator("#quickCaptureReviewStatus:not(:empty)").waitFor();
  await page.locator("#quickCaptureReviewSubmit").click();
  await page.locator("#quickEntrySheet").waitFor({ state: "hidden" });
  assert.deepEqual(versions, [2, 2]);
});

test("edited wall time uses the profile timezone across a month boundary", async t => {
  const page = await openApp(t, { query: "view=history" });
  await page.locator("#historyList [data-edit-expense]").click();
  await page.locator("#expenseForm summary").click();
  await page.locator("[name=expense-spent_at]").fill("2026-11-01T00:15");
  const patch = page.waitForRequest(request => request.method() === "PATCH");
  await page.locator("#expenseForm button[type=submit]").click();
  assert.equal((await patch).postDataJSON().expense.spent_at, "2026-10-31T17:15:00.000Z");
});

test("dashboard uses the profile day for one-off payments while the device is still in October", async t => {
  const page = await openApp(t, { api: async (path, route) => {
    if (path !== "/api/dashboard") return false;
    await route.fulfill({ json: { user: { timezone: "Asia/Bangkok", interface_language: "en", base_currency: "USD" },
      snapshot: { month: 0, display: {} }, plannedExpenses: [{ id: 9, amount: 20, currency: "USD",
        description: "Rent", recurrence: "one_off", due_date: "2026-11-01", category_slug: "home" }] } });
    return true;
  } });
  await page.locator("#safeToSpend").waitFor();
  assert.equal(await page.locator("#plannedNotice [data-occurrence-date='2026-11-01']").count(), 1);
});
