import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { translations } from "../src/i18n.js";

const miniAppRoot = "apps/miniapp/src";

test("Mini App HTML references an existing module entry", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const match = html.match(/<script src="([^"]*app\.js[^"]*)" type="module"><\/script>/);

  assert.ok(match, "index.html should load app.js as a module");
  assert.equal(existsSync(join(miniAppRoot, match[1].split("?")[0].replace(/^\//, ""))), true);
});

test("Mini App keeps app.js and styles.css cache-busters in sync", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const appVersion = html.match(/\/app\.js\?v=([^"]+)/)?.[1];
  const cssVersion = html.match(/\/styles\.css\?v=([^"]+)/)?.[1];

  assert.ok(appVersion, "index.html should version app.js with a ?v= query");
  assert.ok(cssVersion, "index.html should version styles.css with a ?v= query");
  assert.equal(appVersion, cssVersion, "app.js and styles.css cache-busters must stay in sync");
  assert.equal(appVersion, "20260711-product-analytics-review-v16");
  assert.notEqual(appVersion, "20260626-dashboard-v12", "app.js must not keep the stale dashboard-v12 cache-buster");
});

test("Mini App renders onboarding state before dashboard and history", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(html, /id="onboardingState"/);
  assert.match(html, /data-i18n="onboarding\.continueInBot"/);
  assert.match(app, /if \(isOnboardingDashboardResponse\(data\)\)\s*{\s*renderOnboardingState\(data\.user\);\s*return data;/);
  assert.match(app, /const dashboard = await loadDashboard\(\);\s*if \(isOnboardingDashboardResponse\(dashboard\)\) return;/);
  assert.match(app, /buildDashboardRequestPath\(telegramUserId, window\.location\.search\)/);
  assert.match(css, /\.onboarding-state\.hidden\s*{[^}]*display:\s*none/s);
  for (const language of ["en", "ru"]) {
    assert.equal(typeof translations[language]["onboarding.continueInBot"], "string");
    assert.equal(typeof translations[language]["onboarding.openBot"], "string");
  }
});

test("settings tab contains account deletion danger zone after settings form", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const settingsTabIndex = html.indexOf('id="settingsTab"');
  const settingsTabEnd = html.indexOf("</main>", settingsTabIndex);
  const formStart = html.indexOf('id="settingsForm"', settingsTabIndex);
  const formEnd = html.indexOf("</form>", formStart);
  const deleteSection = html.indexOf('id="deleteAccountSection"', settingsTabIndex);

  assert.ok(settingsTabIndex >= 0);
  assert.ok(formStart > settingsTabIndex);
  assert.ok(formEnd > formStart);
  assert.ok(deleteSection > formEnd, "danger zone must follow the settings form");
  assert.ok(deleteSection < settingsTabEnd, "danger zone must remain inside the settings tab");
});

test("account deletion markup and app wire every required control", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");
  const controlIds = [
    "deleteAccountStartButton",
    "deleteAccountAdvanceButton",
    "deleteAccountCancelButton",
    "deleteAccountConfirmInput",
    "deleteAccountConfirmButton"
  ];

  for (const id of controlIds) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(app, new RegExp(`getElementById\\("${id}"\\)`));
  }
  for (const id of controlIds.filter((id) => id !== "deleteAccountConfirmInput")) {
    assert.match(app, new RegExp(`${id}[^]*addEventListener\\("click"`));
  }
  assert.match(app, /deleteAccountConfirmInput[^]*addEventListener\("input"/);
  assert.equal((html.match(/id="deleteAccountCancelButton"/g) ?? []).length, 1);
  assert.match(app, /deleteAccountCancelButton\?\.classList\.toggle\("hidden", stage === "start"\)/);
});

test("account deletion app uses all four endpoints with object bodies", async () => {
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");

  for (const endpoint of ["request", "advance", "cancel", "confirm"]) {
    assert.match(app, new RegExp(`/api/account-deletion/${endpoint}`));
  }
  assert.match(app, /body:\s*\{\s*source:\s*"miniapp"/);
  assert.match(app, /\/api\/account-deletion\/confirm",\s*\{ confirmationText \}/);
  assert.doesNotMatch(app, /body:\s*JSON\.stringify\(\{\s*source:\s*"miniapp"/);
});

test("account deletion has complete English and Russian visible copy", () => {
  const keys = [
    "settings.dangerZone",
    "settings.deleteDataTitle",
    "settings.deleteDataHint",
    "settings.deleteDataButton",
    "settings.deleteDataWarningTitle",
    "settings.deleteDataWarningBody",
    "settings.deleteDataUnderstand",
    "settings.deleteDataTypeDelete",
    "settings.deleteDataConfirmButton",
    "settings.deleteDataCancel",
    "settings.deleteDataDeletedTitle",
    "settings.deleteDataDeletedBody",
    "toast.accountDeletionRequested",
    "toast.accountDeletionCancelled",
    "toast.accountDeletionExpired",
    "toast.accountDeletionFailed"
  ];

  for (const language of ["en", "ru"]) {
    for (const key of keys) {
      assert.equal(typeof translations[language][key], "string", `${language}.${key} must exist`);
      assert.ok(translations[language][key].length > 0, `${language}.${key} must not be empty`);
    }
  }
  assert.equal(translations.en["settings.deleteDataConfirmButton"], "Delete permanently");
  assert.equal(translations.ru["settings.deleteDataConfirmButton"], "Удалить навсегда");
  assert.match(translations.en["settings.deleteDataWarningTitle"], /cannot be undone/i);
  assert.match(translations.en["settings.deleteDataWarningBody"], /Nothing is deleted[^]*DELETE/);
  assert.equal(
    translations.en["settings.deleteDataDeletedBody"],
    "Your Money Flow data has been deleted. To start again, send /start to the bot."
  );
  assert.equal(
    translations.ru["settings.deleteDataDeletedBody"],
    "Ваши данные Money Flow удалены. Чтобы начать заново, отправьте боту команду /start."
  );
});

test("account deletion enables permanent deletion only for exact DELETE", async () => {
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");

  assert.match(app, /deleteAccountConfirmButton\.disabled\s*=\s*deleteAccountConfirmInput\.value\s*!==\s*"DELETE"/);
  assert.match(app, /if \(confirmationText !== "DELETE"\) return;/);
});

test("app guards data access and disables actions after account deletion", async () => {
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");

  assert.match(app, /let accountDeleted = false;/);
  assert.match(app, /async function loadDashboard\(\)\s*{\s*if \(accountDeleted\) return;/);
  assert.match(app, /async function loadHistory\(\)\s*{\s*if \(accountDeleted\) return;/);
  assert.match(app, /async function saveSettings\(event\)\s*{[^]*?if \(accountDeleted\) return;[^]*?await api\("\/api\/settings"/);
  assert.match(app, /async function requestExpenseExport\(period\)\s*{\s*if \(accountDeleted\) return;/);
  assert.match(app, /function switchTab\(tab\)\s*{\s*if \(accountDeleted\) return;/);
  assert.match(app, /function renderDeletedState\(\)[^]*accountDeleted = true;/);
  assert.match(app, /\.bottom-tabs/);
  assert.match(app, /#settingsForm input, #settingsForm select, #settingsForm button/);
  assert.match(app, /#dashboardTab button, #planTab button, #historyTab button/);

  const confirmStart = app.indexOf("async function confirmAccountDeletion()");
  const confirmEnd = app.indexOf("function renderDeletedState()", confirmStart);
  const confirmBlock = app.slice(confirmStart, confirmEnd);
  assert.doesNotMatch(confirmBlock, /saveSettings|loadDashboard|loadHistory|renderSettings|requestExpenseExport/);
});

test("Mini App local module imports resolve to files", async () => {
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");
  const imports = [...app.matchAll(/from "\.\/([^"]+\.js)"/g)].map((match) => match[1]);

  assert.ok(imports.length > 0);
  for (const imported of imports) {
    assert.equal(existsSync(join(miniAppRoot, imported)), true, `${imported} should exist`);
  }
});

test("history period picker uses a fixed dates action and one calendar dialog", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");

  assert.match(html, /id="historyQuickPeriods"/);
  assert.match(html, /id="openHistoryDatePicker"/);
  assert.match(html, /id="historyDateSheet"[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.match(html, /id="historyCalendarGrid"/);
  assert.doesNotMatch(html, /id="historyFromDate"/);
  assert.doesNotMatch(html, /id="historyToDate"/);
  assert.doesNotMatch(html, /id="historyCustomRange"/);
  assert.doesNotMatch(html, /data-history-period="previous_month"/);
});

test("history date picker wires draft interactions without removed date inputs", async () => {
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");

  assert.match(app, /#openHistoryDatePicker/);
  assert.match(app, /data-calendar-date/);
  assert.match(app, /#closeHistoryDatePicker/);
  assert.match(app, /#historyDateBackdrop/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(app, /closeHistoryDatePicker/);
  assert.doesNotMatch(app, /#historyFromDate/);
  assert.doesNotMatch(app, /#historyToDate/);
  assert.doesNotMatch(app, /#historyCustomRange/);
});

test("history period picker CSS isolates horizontal scroll and respects safe areas", async () => {
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(css, /\.history-period-row\s*{[^}]*min-width:\s*0/s);
  assert.match(css, /\.history-filter-chips\s*{[^}]*min-width:\s*0[^}]*overflow-x:\s*auto/s);
  assert.match(css, /\.history-date-action\s*{[^}]*flex:\s*0 0 auto/s);
  assert.match(css, /\.history-date-sheet\s*{[^}]*position:\s*fixed[^}]*bottom:\s*0/s);
  assert.match(css, /\.history-date-sheet\s*{[^}]*env\(safe-area-inset-bottom\)/s);
  assert.doesNotMatch(css, /\.history-custom-range\s*{/);
});

test("Mini App has a documented local preview server", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const readme = await readFile("README.md", "utf8");

  assert.equal(packageJson.scripts["dev:miniapp"], "node apps/miniapp/dev-server.cjs");
  assert.equal(existsSync("apps/miniapp/dev-server.cjs"), true);
  assert.match(readme, /npm\.cmd run dev:miniapp/);
  assert.match(readme, /http:\/\/localhost:3000\/\?telegramUserId=100001/);
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
  assert.match(css, /\.dashboard-card__face--back\s*{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.dashboard-card__amount\s*{[^}]*font-size:\s*clamp\(32px,\s*5vw,\s*40px\)/s);
  assert.match(css, /\.dashboard-card__line\s*{[^}]*white-space:\s*normal/s);
  assert.match(css, /\.dashboard-card__caption\s*{[^}]*white-space:\s*normal/s);
});

test("dashboard tooltip backs never scroll internally and use compact copy type", async () => {
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(css, /\.dashboard-card__face--back\s*{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.hero-metric__face--back\s*{[^}]*overflow:\s*hidden/s);

  const cardBackText = css.match(/\.dashboard-card__back-text\s*{[^}]*}/s)?.[0] ?? "";
  const heroBackText = css.match(/\.hero-metric__back-text\s*{[^}]*}/s)?.[0] ?? "";
  assert.ok(cardBackText, ".dashboard-card__back-text rule should exist");
  assert.ok(heroBackText, ".hero-metric__back-text rule should exist");

  assert.doesNotMatch(cardBackText, /overflow-y:\s*auto/);
  assert.doesNotMatch(heroBackText, /overflow-y:\s*auto/);
  assert.match(cardBackText, /font-size:\s*clamp\(12px,\s*2\.8vw,\s*14px\)/);
  assert.match(heroBackText, /font-size:\s*clamp\(15px,\s*3\.6vw,\s*18px\)/);
  assert.match(cardBackText, /font-weight:\s*650/);
  assert.match(heroBackText, /font-weight:\s*650/);
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
  assert.match(css, /@media \(max-width:\s*640px\)[^]*\.hero-metric\s*{[^}]*min-height:\s*218px/s);
  assert.match(css, /@media \(max-width:\s*640px\)[^]*\.hero-metric__face--front\s*{[^}]*padding:\s*24px 26px/s);
  assert.match(css, /@media \(max-width:\s*640px\)[^]*\.dashboard-card,[^}]*\.dashboard-card__face--back\s*{[^}]*min-height:\s*140px/s);
  assert.match(css, /@media \(max-width:\s*640px\)[^]*\.dashboard-card__face--front\s*{[^}]*gap:\s*5px[^}]*padding:\s*12px/s);
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
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(html, /<body data-theme="light">/);
  assert.doesNotMatch(html, /class="quick-actions"/);
  assert.doesNotMatch(html, /id="themeToggleButton"/);
  assert.doesNotMatch(html, /id="heroStatus"/);
  assert.doesNotMatch(app, /#heroStatus/);
  assert.ok(html.indexOf('id="dashboardInboxBlock"') < html.indexOf('id="monthlyForecast"'));
  assert.match(html, /class="bottom-tabs"/);
  assert.match(css, /\.bottom-tabs\s*{/);
  assert.match(css, /\.dashboard-card__face--front\s*{[^}]*grid-template-rows:/s);
  assert.match(css, /body\[data-theme="dark"\]/);
  assert.match(css, /body\[data-theme="light"\]/);
});

test("dashboard keeps card tooltips and makes the hero an accessible disclosure", async () => {
  const renderer = await readFile(join(miniAppRoot, "dashboardCards.js"), "utf8");
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");

  assert.match(renderer, /data-flip-toggle/);
  assert.match(renderer, /data-flip-card/);
  assert.match(renderer, /dashboard-card__flip-inner/);
  assert.match(renderer, /dashboard-card__face--front/);
  assert.match(renderer, /dashboard-card__face--back/);
  assert.match(renderer, /role="note"/);
  assert.doesNotMatch(renderer, /dashboard-card__tooltip/);
  assert.match(renderer, /aria-expanded="false"/);
  assert.match(renderer, /aria-controls=/);
  assert.match(html, /class="hero-metric"[^>]*data-state="good"/);
  assert.match(html, /hero-metric__ribbon/);
  assert.match(html, /id="heroTooltip"/);
  assert.match(html, /id="heroTooltipText"/);
  assert.match(html, /id="heroDetailsToggle"/);
  assert.match(html, /class="hero-metric__details-toggle"[^]*aria-controls="heroTooltip"/);
  assert.match(app, /bindDashboardTooltips/);
  assert.match(app, /bindHeroDetails/);
  assert.match(app, /renderHeroDetails/);
  assert.match(app, /FLIP_SELECTOR\s*=\s*"\[data-flip-card\]"/);
  assert.match(app, /FLIP_TOGGLE_SELECTOR\s*=\s*"\[data-flip-toggle\]"/);
  assert.match(app, /is-flipped/);
  assert.match(app, /closeDashboardTooltips/);
  assert.doesNotMatch(app, /dashboard-card__tooltip:not\(\[hidden\]\)/);
  assert.doesNotMatch(app, /querySelectorAll\("\.dashboard-card\[data-dashboard-card\]"\)/);
  assert.match(css, /\.dashboard-card__flip-inner\s*{/);
  assert.match(css, /\.hero-metric__ribbon\s*{/);
  assert.match(css, /\.hero-metric__details-toggle\s*{/);
  assert.match(css, /transform-style:\s*preserve-3d/);
  assert.match(css, /prefers-reduced-motion:\s*reduce[^]*\.hero-metric__flip-inner/s);
  assert.doesNotMatch(app, /heroStatus/);
});

test("planned summary uses stacked paid and remaining rows", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");

  assert.match(html, /class="planned-summary-rows"/);
  assert.match(app, /plannedSummaryRowHtml\("Оплачено",\s*paid\)/);
  assert.match(app, /plannedSummaryRowHtml\("Осталось",\s*remaining\)/);
  assert.match(css, /\.planned-summary-row\s*{[^}]*grid-template-columns:\s*86px minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.planned-summary-row__amount\s*{[^}]*color:\s*var\(--ink\)/s);
});

test("planned disable uses the focused helper and prefers the server-owned month summary", async () => {
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");

  assert.match(app, /import\s*{[^}]*runPlannedDisable[^}]*}\s*from "\.\/plannedDisable\.js"/s);
  assert.match(app, /dashboardState\?\.plannedMonthSummary\s*\?\?\s*calculatePlannedMonthSummary\(items\)/);
  assert.match(app, /runPlannedDisable\(\{[^]*?confirm:\s*window\.confirm[^]*?disableRequest:[^]*?method:\s*"DELETE"[^]*?loadDashboard[^]*?showResult:\s*showToast/s);
  assert.match(app, /runPlannedDisable\(\{[^]*?language:\s*currentLanguage,[^]*?createTranslator,/s);
});

test("planned archive is accessible, lazy, and separate from dashboard loading", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");

  assert.match(html, /id="plannedArchiveToggle"[^>]+aria-expanded="false"[^>]+aria-controls="plannedArchiveContent"/);
  assert.match(html, /id="plannedArchiveStatus"[^>]+role="status"/);
  assert.match(app, /createPlannedArchiveState\(\)/);
  assert.match(app, /\/api\/planned-expenses\/archive\?telegramUserId=/);
  assert.match(app, /async function refreshArchiveAfterDisable\(\)/);
  const dashboardBlock = app.slice(app.indexOf("async function loadDashboard()"), app.indexOf("function renderOnboardingState"));
  assert.doesNotMatch(dashboardBlock, /planned-expenses\/archive|refreshPlannedArchive/);
  assert.match(css, /\.planned-archive\s*{/);
  assert.match(css, /@media \(max-width: 430px\)[^]*\.planned-archive \.button-row button[^]*width:\s*100%/s);
});

test("planned recreate uses an explicit form mode and the dedicated source endpoint", async () => {
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");

  assert.match(app, /import\s*{[^}]*runPlannedRecreate[^}]*}\s*from "\.\/plannedRecreate\.js"/s);
  assert.match(app, /function renderPlannedForm\(item = {}, \{ mode = "create", sourcePlannedExpenseId = null } = {}\)/);
  assert.match(app, /renderPlannedForm\(item, \{ mode: "edit" }\)/);
  assert.match(app, /renderPlannedForm\(item, \{ mode: "recreate", sourcePlannedExpenseId: item\.id }\)/);
  assert.match(app, /name="planned-starts_on" type="date" value="\$\{startsOn}" min="\$\{startsOn}" required/);
  assert.match(app, /`\/api\/planned-expenses\/\$\{sourcePlannedExpenseId}\/recreate`[^]*method:\s*"POST"[^]*startsOn:\s*input\("planned-starts_on"\)\.value/s);
  assert.match(app, /plannedId:\s*mode === "edit" \? item\.id : null/);
  assert.doesNotMatch(app, /plannedId:\s*sourcePlannedExpenseId|sourcePlannedExpenseId:\s*plannedId/);
});

test("toast preserves planned disable result paragraphs", async () => {
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(css, /\.toast\s*{[^}]*white-space:\s*pre-line/s);
});

test("settings expose interface theme as a visible select", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");

  assert.match(html, /<select id="interfaceThemeInput" name="interfaceTheme">/);
  assert.match(html, /<option value="light" data-i18n="settings.themeLight"/);
  assert.match(html, /<option value="dark" data-i18n="settings.themeDark"/);
  assert.match(html, /data-i18n="settings.interfaceTheme"/);
});

test("settings expose lightweight timezone controls", async () => {
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");

  assert.match(html, /id="timezoneInput"/);
  assert.match(html, /id="detectTimezoneButton"/);
  assert.match(html, /data-i18n="settings.timezone"/);
});

test("settings are grouped into four focused sections with evening reminder", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const settingsStart = html.indexOf('id="settingsTab"');
  const settingsEnd = html.indexOf("</main>", settingsStart);
  const settingsHtml = html.slice(settingsStart, settingsEnd);

  assert.equal((settingsHtml.match(/class="settings-section"/g) ?? []).length, 4);
  assert.match(settingsHtml, /data-i18n="settings.sectionBudget"/);
  assert.match(settingsHtml, /data-i18n="settings.sectionCurrencies"/);
  assert.match(settingsHtml, /data-i18n="settings.sectionNotifications"/);
  assert.match(settingsHtml, /data-i18n="settings.sectionInterface"/);
  assert.match(settingsHtml, /id="dailyReminderInput"[^>]+name="dailyEntryReminderEnabled"/);
  assert.doesNotMatch(settingsHtml, /budgetAdviceInput/);
});

test("reserve settings live in Plan instead of Settings", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const planStart = html.indexOf('id="planTab"');
  const settingsStart = html.indexOf('id="settingsTab"');
  const planHtml = html.slice(planStart, settingsStart);
  const settingsHtml = html.slice(settingsStart, html.indexOf("</main>", settingsStart));

  assert.match(planHtml, /id="reserveSettingsBlock"/);
  assert.match(planHtml, /id="reserveForm"/);
  assert.ok(planHtml.indexOf('id="reserveSettingsBlock"') < planHtml.indexOf('id="plannedExpenses"'));
  assert.doesNotMatch(settingsHtml, /id="reserveSettingsBlock"/);
  assert.doesNotMatch(settingsHtml, /id="reserveForm"/);
});

test("currency selectors use stable markers and language selector has no flag", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(html, /id="baseCurrencyMark"/);
  assert.match(html, /id="displayCurrencyMark"/);
  assert.doesNotMatch(html, /interfaceLanguageFlag/);
  assert.doesNotMatch(html, /flag-icon/);
  assert.doesNotMatch(html, /data-currency/);
  assert.doesNotMatch(html, /data-language/);
  assert.match(app, /updateSettingsDecorations/);
  assert.match(app, /CURRENCY_MARKS/);
  assert.doesNotMatch(app, /updateCurrencyFlags/);
  assert.match(css, /\.currency-mark/);
  assert.match(css, /\.currency-code-fallback/);
  assert.doesNotMatch(css, /data-currency/);
  assert.doesNotMatch(css, /data-language/);
});

test("settings exposes expense export actions that send only period", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");

  assert.match(html, /id="expenseExportBlock"/);
  assert.match(html, /data-export-period="month"/);
  assert.match(html, /data-export-period="all"/);
  assert.match(app, /requestExpenseExport/);
  assert.match(app, /\/api\/exports\/expenses/);
  assert.match(app, /body:\s*\{\s*period\s*\}/);
  assert.doesNotMatch(app, /body:\s*\{\s*telegramUserId,\s*period\s*\}/);
});
