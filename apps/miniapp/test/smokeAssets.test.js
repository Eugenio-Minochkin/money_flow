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

  assert.match(html, /id="dashboardCards"/);
  assert.match(css, /\.dashboard-card\s*{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.dashboard-card__amount\s*{[^}]*font-size:\s*clamp\(32px,\s*5vw,\s*40px\)/s);
  assert.match(css, /\.dashboard-card__line\s*{[^}]*white-space:\s*normal/s);
  assert.match(css, /\.dashboard-card__caption\s*{[^}]*white-space:\s*normal/s);
});

test("dashboard metric display currency uses the purple accent", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(html, /id="dashboardCards"/);
  assert.match(css, /\.dashboard-card__display\s*{[^}]*color:\s*var\(--usd\)/s);
  assert.match(css, /\.dashboard-card__label\s*{[^}]*color:\s*#6f6258/s);
  assert.match(css, /\.dashboard-card__value\s*{[^}]*color:\s*#11100f/s);
});

test("dashboard cards render through the shared renderer", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");
  const rendererExists = existsSync(join(miniAppRoot, "dashboardCards.js"));

  assert.equal(rendererExists, true);
  assert.match(html, /<section class="metrics-grid" id="dashboardCards"/);
  assert.doesNotMatch(html, /id="todayRemaining"/);
  assert.doesNotMatch(html, /id="weekRemaining"/);
  assert.doesNotMatch(html, /id="monthRemaining"/);
  assert.match(app, /import\s*{[^}]*renderDashboardCards[^}]*}\s*from "\.\/dashboardCards\.js"/);
  assert.match(app, /renderDashboardCards\(document\.querySelector\("#dashboardCards"\),/);
  assert.doesNotMatch(app, /setMetricLine\("#todayRemaining"/);
});

test("dashboard card renderer keeps remaining before limits and budgets", async () => {
  const renderer = await readFile(join(miniAppRoot, "dashboardCards.js"), "utf8");

  assert.match(renderer, /lines:\s*\[\s*remainingLine\(/s);
  assert.match(renderer, /remainingLine\([^]*budgetLine\(/);
  assert.match(renderer, /remainingLine\([^]*budgetLine\(/);
});

test("dashboard card titles use the approved visible typography", async () => {
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(css, /\.dashboard-card__title\s*{[^}]*color:\s*#4f453e[^}]*font-size:\s*22px[^}]*font-weight:\s*820/s);
});

test("dashboard cards match the rounded reference layout with stateful progress colors", async () => {
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");

  assert.match(css, /\.shell\s*{[^}]*width:\s*min\(100%,\s*812px\)/s);
  assert.match(css, /\.hero-metric\s*{[^}]*min-height:\s*346px[^}]*border-radius:\s*34px/s);
  assert.match(css, /\.hero-metric strong\s*{[^}]*font-size:\s*clamp\(58px,\s*10vw,\s*94px\)/s);
  assert.match(css, /\.metrics-grid\s*{[^}]*gap:\s*22px/s);
  assert.match(css, /\.dashboard-card\s*{[^}]*border-radius:\s*24px/s);
  assert.match(css, /\.dashboard-card\s*{[^}]*min-height:\s*214px/s);
  assert.match(css, /\.dashboard-card__amount\s*{[^}]*font-size:\s*clamp\(32px,\s*5vw,\s*40px\)/s);
  assert.match(css, /\.dashboard-card__progress\s*{[^}]*height:\s*9px/s);
  assert.match(css, /\.dashboard-card__progress-fill\[data-state="warn"\][^{]*{[^}]*background:\s*var\(--amber\)/s);
  assert.match(css, /\.dashboard-card__progress-fill\[data-state="danger"\][^{]*{[^}]*background:\s*var\(--red\)/s);
  assert.match(css, /\.dashboard-card__progress-fill\[data-state="good"\][^{]*{[^}]*background:\s*var\(--green\)/s);
  assert.match(app, /buildDashboardCards\(snapshot/);
  assert.match(app, /renderDashboardCards\(document\.querySelector\("#dashboardCards"\),/);
});

test("dashboard uses compact iPhone card sizing", async () => {
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(css, /@media \(max-width:\s*640px\)\s*{[^}]*\.shell\s*{[^}]*padding:\s*14px 16px 88px/s);
  assert.match(css, /@media \(max-width:\s*640px\)[^]*\.hero-metric\s*{[^}]*min-height:\s*218px[^}]*padding:\s*24px 26px/s);
  assert.match(css, /@media \(max-width:\s*640px\)[^]*\.dashboard-card,\s*\.dashboard-card--progress\s*{[^}]*min-height:\s*140px/s);
  assert.match(css, /@media \(max-width:\s*640px\)[^]*\.dashboard-card\s*{[^}]*gap:\s*5px[^}]*padding:\s*12px/s);
  assert.match(css, /@media \(max-width:\s*640px\)[^]*\.dashboard-card__amount\s*{[^}]*font-size:\s*clamp\(23px,\s*6\.5vw,\s*27px\)/s);
  assert.match(css, /@media \(max-width:\s*640px\)[^]*\.dashboard-card__progress\s*{[^}]*height:\s*6px/s);
});

test("dashboard card CSS does not rely on broad tag selectors", async () => {
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.doesNotMatch(css, /\.metric\s+(em|small|strong)\s*{/);
  assert.doesNotMatch(css, /\.metric-top\s+(span|b)\s*{/);
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
  assert.match(css, /\.dashboard-card\s*{[^}]*grid-template-rows:/s);
  assert.match(css, /body\[data-theme="dark"\]/);
  assert.match(css, /body\[data-theme="light"\]/);
});

test("settings keep interface theme switching hidden", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");

  assert.match(html, /id="interfaceThemeInput"[^>]+type="hidden"/);
  assert.doesNotMatch(html, /data-i18n="settings.interfaceTheme"/);
});
