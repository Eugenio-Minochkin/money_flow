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

test("remaining card caption can wrap independently from metric values", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(html, /class="metric-caption"[^>]+data-i18n="dashboard.afterExpensesAndPlanned"/);
  assert.match(css, /\.metric-value-note\s*{[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.metric-caption\s*{[^}]*white-space:\s*normal/s);
});

test("dashboard uses refactored action-first layout with bottom navigation", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(html, /class="quick-actions"/);
  assert.match(html, /id="reviewInboxButton"/);
  assert.match(html, /class="bottom-tabs"/);
  assert.match(css, /\.bottom-tabs\s*{/);
  assert.match(css, /body\[data-theme="dark"\]/);
  assert.match(css, /body\[data-theme="light"\]/);
});

test("settings expose interface theme without duplicating dashboard structure", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");

  assert.match(html, /id="interfaceThemeInput"/);
  assert.match(html, /data-i18n="settings.interfaceTheme"/);
});
