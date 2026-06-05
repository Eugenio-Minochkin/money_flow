import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const miniAppRoot = "apps/miniapp/src";

test("Mini App HTML references an existing module entry", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const match = html.match(/<script src="([^"]*app\.js[^"]*)" type="module"><\/script>/);

  assert.ok(match, "index.html should load app.js as a module");
  assert.equal(existsSync(join(miniAppRoot, match[1].split("?")[0].replace(/^\//, ""))), true);
});

test("Mini App local module imports resolve to files", async () => {
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");
  const imports = [...app.matchAll(/from "\.\/([^"]+\.js)"/g)].map((match) => match[1]);

  assert.ok(imports.length > 0);
  for (const imported of imports) {
    assert.equal(existsSync(join(miniAppRoot, imported)), true, `${imported} should exist`);
  }
});

test("settings keep fallback exchange rate hidden from users", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");

  assert.match(html, /id="usdThbRateInput"[^>]+type="hidden"/);
  assert.doesNotMatch(html, /data-i18n="settings.exchangeFallback"/);
});

test("dashboard metric text can wrap instead of causing horizontal overflow", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(html, /class="metric-caption"[^>]+data-i18n="dashboard.afterExpensesAndPlanned"/);
  assert.match(css, /\.metric\s*{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.metric strong\s*{[^}]*font-size:\s*clamp\(20px,\s*5vw,\s*28px\)/s);
  assert.match(css, /\.metric-value-note\s*{[^}]*white-space:\s*normal/s);
  assert.match(css, /\.metric-caption\s*{[^}]*white-space:\s*normal/s);
});

test("dashboard metric display currency uses the purple accent", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(html, /class="display-currency"[^>]+id="freeRemainingDisplay"/);
  assert.match(css, /\.metric em\s*{[^}]*color:\s*#6f6258[^}]*font-style:\s*normal/s);
  assert.match(css, /\.metric \.display-currency\s*{[^}]*color:\s*var\(--usd\)/s);
  assert.match(css, /\.metric em b,\s*\.metric small b\s*{[^}]*color:\s*#11100f/s);
});

test("dashboard card secondary lines prioritize remaining before limits", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");

  assert.ok(html.indexOf('id="todayRemaining"') < html.indexOf('id="todayDisplay"'));
  assert.ok(html.indexOf('id="weekRemaining"') < html.indexOf('id="weekDisplay"'));
  assert.ok(html.indexOf('id="monthRemaining"') < html.indexOf('id="monthDisplay"'));
  assert.match(app, /setMetricLine\("#todayRemaining",\s*t\("dashboard\.remainingPrefix"\)/);
  assert.doesNotMatch(app, /setMetricLine\("#todayRemaining",\s*t\("dashboard\.leftTodayPrefix"\)/);
});

test("dashboard card titles use the approved visible typography", async () => {
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(css, /\.metric-top span\s*{[^}]*color:\s*#4f453e[^}]*font-size:\s*17px[^}]*font-weight:\s*820/s);
});

test("dashboard uses compact header, inbox before month plan, and bottom navigation", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(html, /<body data-theme="light">/);
  assert.doesNotMatch(html, /class="quick-actions"/);
  assert.doesNotMatch(html, /id="themeToggleButton"/);
  assert.match(html, /id="heroStatus"/);
  assert.ok(html.indexOf('id="dashboardInboxBlock"') < html.indexOf('class="plan-summary"'));
  assert.match(html, /class="bottom-tabs"/);
  assert.match(css, /\.bottom-tabs\s*{/);
  assert.match(css, /\.metric\s*{[^}]*grid-template-rows:/s);
  assert.match(css, /body\[data-theme="dark"\]/);
  assert.match(css, /body\[data-theme="light"\]/);
});

test("settings keep interface theme switching hidden", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");

  assert.match(html, /id="interfaceThemeInput"[^>]+type="hidden"/);
  assert.doesNotMatch(html, /data-i18n="settings.interfaceTheme"/);
});
