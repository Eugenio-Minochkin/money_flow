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
  assert.equal(appVersion, "20260814-bundle-v5");
  assert.notEqual(appVersion, "20260626-dashboard-v12", "app.js must not keep the stale dashboard-v12 cache-buster");
});

test("Mini App acknowledges Telegram before evaluating the module and measures usable Dashboard", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");
  const startupTiming = await readFile(join(miniAppRoot, "startupTiming.js"), "utf8");
  const telegramSdk = html.indexOf("telegram-web-app.js");
  const ready = html.indexOf("WebApp.ready");
  const appModule = html.indexOf('<script src="/app.js?v=');

  assert.ok(telegramSdk >= 0 && ready > telegramSdk && appModule > ready);
  assert.match(html, /performance\.mark\("mf:html_start"\)/);
  assert.match(html, /performance\.mark\("mf:telegram_sdk_available"\)/);
  assert.match(app, /markStartup\("app_evaluated"\)/);
  assert.match(app, /markStartup\("dashboard_request_start"\)/);
  assert.match(app, /markStartup\("dashboard_response_received"\)/);
  assert.match(app, /markStartup\("dashboard_rendered"\)/);
  assert.match(app, /markStartup\("dashboard_usable"\)/);
  assert.doesNotMatch(app, /webApp\.ready\(\)/);
  assert.doesNotMatch(app, /webApp\.expand\(\)/);
  for (const measure of ["telegram_sdk", "app_bootstrap", "dashboard_request", "dashboard_render", "dashboard_total", "history_request"]) {
    assert.match(startupTiming, new RegExp(`mf:${measure}`));
  }
});

test("Mini App starts CSS and module fetches before the blocking Telegram SDK", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const telegramSdk = html.indexOf('<script src="https://telegram.org/js/telegram-web-app.js"');
  const preconnect = html.indexOf('<link rel="preconnect" href="https://telegram.org"');
  const stylesheet = html.indexOf('<link rel="stylesheet" href="/styles.css?v=20260814-bundle-v5"');
  const modulePreload = html.indexOf('<link rel="modulepreload" href="/app.js?v=20260814-bundle-v5"');
  const appExecution = html.indexOf('<script src="/app.js?v=20260814-bundle-v5" type="module">');

  assert.ok(preconnect >= 0 && preconnect < telegramSdk);
  assert.ok(stylesheet >= 0 && stylesheet < telegramSdk);
  assert.ok(modulePreload >= 0 && modulePreload < telegramSdk);
  assert.ok(appExecution > telegramSdk, "app.js must still execute after Telegram bootstrap");
});

test("Mini App reports privacy-safe startup timings after Dashboard becomes usable", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const startup = await readFile(new URL("../src/startupTiming.js", import.meta.url), "utf8");
  const loadBlock = app.slice(app.indexOf("async function load()"), app.indexOf("async function loadDashboard()"));

  assert.match(loadBlock, /const startupTimings = finishStartup\(\)/);
  assert.match(loadBlock, /void reportStartupTimings\(startupTimings\)/);
  assert.match(app, /api\("\/api\/startup-timing"/);
  assert.match(startup, /navigation_ttfb/);
  assert.match(startup, /telegram_sdk_resource/);
  assert.match(startup, /app_entry_resource/);
  assert.match(startup, /styles_resource/);
  assert.doesNotMatch(startup, /telegramUserId|initData/);
});

test("ordinary Mini App startup leaves History out of the Dashboard critical path", async () => {
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");
  const loadBlock = app.slice(app.indexOf("async function load()"), app.indexOf("async function loadDashboard()"));
  const switchBlock = app.slice(app.indexOf("function switchTab("), app.indexOf("function setupTabPager"));

  assert.doesNotMatch(loadBlock, /await loadHistory\(\)/);
  assert.match(loadBlock, /await ensureHistoryLoaded\(\)/);
  assert.doesNotMatch(loadBlock, /requestAnimationFrame\([^]*?ensureHistoryLoaded\(\)/);
  assert.match(loadBlock, /requestAnimationFrame\([^]*?loadDashboardInbox\(\)/);
  assert.match(switchBlock, /if \(tab === "history"\) void ensureHistoryLoaded\(\)\.catch\(showError\)/);
  assert.match(app, /markStartup\("history_request_start"\)/);
  assert.match(app, /markStartup\("history_request_finish"\)/);
});

test("fullscreen keeps the hero content below Telegram controls and disables vertical swipes", async () => {
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(app, /function syncFullscreenControlSafeArea\(\)/);
  assert.match(app, /webApp\.onEvent\?\.\("fullscreenChanged",\s*syncFullscreenControlSafeArea\)/);
  assert.match(app, /webApp\.onEvent\?\.\("contentSafeAreaChanged",\s*syncFullscreenControlSafeArea\)/);
  assert.match(app, /webApp\.onEvent\?\.\("safeAreaChanged",\s*syncFullscreenControlSafeArea\)/);
  assert.match(app, /const extraTop = Math\.max\(0, desiredTop - contentTop\);/);
  assert.match(app, /WebApp\?\.disableVerticalSwipes\?\.\(\)/);
  assert.match(app, /webApp\.onEvent\?\.\("fullscreenChanged",\s*disableTelegramVerticalSwipes\)/);
  assert.match(css, /\.hero-metric__summary\s*{[^}]*min-height:\s*calc\(140px \+ var\(--tg-fullscreen-control-extra-top, 0px\)\)[^}]*padding:\s*calc\(22px \+ var\(--tg-fullscreen-control-extra-top, 0px\)\) 16px 14px/s);
  assert.match(css, /#historyTab,\s*#planTab,\s*#settingsTab\s*{[^}]*padding-top:\s*var\(--tg-fullscreen-control-extra-top, 0px\)/s);
  assert.doesNotMatch(css, /#dashboardTab[^}]*padding-top:\s*var\(--tg-fullscreen-control-extra-top/s);
  assert.match(css, /body\s*{[^}]*overscroll-behavior-y:\s*none/s);
});

test("Mini App keeps the root scrolling surface and Telegram background in theme sync", async () => {
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(app, /applyMiniAppTheme\(currentTheme/);
  assert.match(app, /webApp\.onEvent\?\.\("themeChanged",\s*syncMiniAppThemeBackground\)/);
  assert.match(css, /html,\s*body\s*{[^}]*background:\s*var\(--bg\)/s);
  assert.match(css, /html\s*{[^}]*min-height:\s*100%/s);
  assert.match(css, /body\s*{[^}]*min-height:\s*100dvh/s);
});

test("Quick Entry stays visible and busy while recognition is pending", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");

  assert.match(html, /id="quickEntryStatus"[^>]+aria-live="polite"/);
  assert.match(html, /id="quickEntrySubmit"/);
  assert.match(app, /function setQuickEntryPending\(pending\)/);
  assert.match(app, /setQuickEntryPending\(true\);[\s\S]*?await api\("\/api\/quick-entry"/);
  assert.match(app, /catch \(error\)\s*{[\s\S]*?quickEntryStatus\.textContent = quickEntryErrorMessage\(error\)/);
  assert.match(app, /finally\s*{\s*setQuickEntryPending\(false\);\s*}/);
  assert.match(app, /if \(quickEntryStatus && pending\) quickEntryStatus\.textContent = t\("quickEntry\.recognizing"\);/);
  for (const language of ["en", "ru"]) {
    assert.equal(typeof translations[language]["quickEntry.recognizing"], "string");
    assert.equal(typeof translations[language]["quickEntry.error.amountNotFound"], "string");
    assert.equal(typeof translations[language]["quickEntry.error.network"], "string");
    assert.equal(typeof translations[language]["quickEntry.error.generic"], "string");
  }
});

test("Quick Capture saves safe entries with undo and keeps review in the sheet", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");

  assert.match(html, /id="quickCaptureReview"/);
  assert.match(html, /id="quickCaptureReviewStatus"[^>]+aria-live="polite"/);
  assert.match(app, /if \(data\.saved\) \{\s*renderQuickCaptureSaved\(data\.saved\.expenses\);/);
  assert.match(app, /renderQuickCaptureReview\(data\.draft\)/);
  assert.match(app, /async function undoQuickCapture\(expense\)/);
  assert.match(app, /api\(`\/api\/expenses\/\$\{expense\.id\}`, \{ method: "DELETE"/);
  assert.match(app, /expectedVersion: quickCaptureDraft\.version/);
  assert.match(app, /quickCaptureReviewStatus\.textContent = t\("quickEntry\.reviewSaveFailed"\)/);
  assert.match(app, /api\(`\/api\/drafts\/\$\{draftState\.id\}\/confirm`/);
});

test("Shortcut setup copies its key without rendering the raw credential", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");

  assert.match(html, /id="setupQuickAccessButton"/);
  assert.match(html, /id="quickAccessSetupState"/);
  assert.doesNotMatch(html, /quickAccessTokenValue|quickAccessTokenReveal|copyQuickAccessTokenButton/);
  assert.match(app, /advanceShortcutSetup\(/);
  assert.match(app, /preparationId: quickAccessPreparationId/);
  assert.doesNotMatch(app, /api\("\/api\/quick-access-tokens", \{ method: "DELETE"/);
  assert.match(app, /let quickAccessTokenBusy = false/);
  assert.match(app, /if \(quickAccessTokenBusy\) return/);
  assert.match(app, /setQuickAccessTokenBusy\(true\)/);
  assert.match(app, /if \(quickAccessTokenBusy \|\| !navigator\.clipboard\?\.writeText\)/);
  assert.match(app, /function showQuickAccessSetupState\(\)/);
  for (const language of ["en", "ru"]) {
    assert.equal(typeof translations[language]["quickAccess.setup"], "string");
    assert.equal(typeof translations[language]["quickAccess.keyCopied"], "string");
    assert.equal(typeof translations[language]["quickAccess.keyPrepared"], "string");
  }
});

test("interactive tab pager uses transforms without conflicting with forms or sheets", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(html, /id="tabPager"/);
  assert.equal((html.match(/class="tab-page(?: hidden)?"/g) ?? []).length, 4);
  assert.match(app, /from "\.\/tabPager\.js"/);
  assert.match(app, /let cancelTabPager = \(\) => \{\};/);
  assert.match(app, /function switchTab\(tab, \{ fromPager = false \} = \{\}\)/);
  assert.match(app, /if \(!fromPager\) cancelTabPager\(\);/);
  assert.match(app, /function installTabSwipeNavigation\(\)/);
  assert.match(app, /document\.addEventListener\("touchstart",/);
  assert.match(app, /document\.addEventListener\("touchmove",/);
  assert.match(app, /document\.addEventListener\("touchend",/);
  assert.match(app, /event\.preventDefault\(\)/);
  assert.match(app, /translate3d/);
  assert.match(app, /input, textarea, select/);
  assert.match(app, /isTabSwipeBlocked\(\)/);
  assert.match(app, /accountDeleted \|\| !bottomTabs \|\| bottomTabs\.classList\.contains\("hidden"\)/);
  assert.match(app, /switchTab\(TAB_ORDER\[result\.nextIndex\], \{ fromPager: true \}\)/);
  assert.match(app, /HapticFeedback\?\.selectionChanged\?\.\(\)/);
  assert.match(css, /\.tab-page\.is-pager-neighbor\s*{[^}]*position:\s*absolute/s);
  assert.match(css, /\.tab-pager\s*{[^}]*touch-action:\s*pan-y/s);
  assert.match(css, /\.tab-pager\.is-animating[^}]*transition:\s*transform/s);
});

test("hero geometry leaves responsive space before its facts card", async () => {
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(css, /\.hero-metric__summary\s*{[^}]*min-height:\s*calc\(140px \+ var\(--tg-fullscreen-control-extra-top, 0px\)\)/s);
  assert.match(css, /\.hero-metric__facts\s*{[^}]*margin:\s*0 12px/s);
  assert.doesNotMatch(css, /\.hero-metric__facts\s*{[^}]*margin:\s*-\d+px/s);
});

test("compact hero is the production layout without exploration switches", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.doesNotMatch(app, /heroVariant|heroPreview|renderHeroPreview/);
  assert.doesNotMatch(css, /data-layout|hero-preview/);
  assert.match(css, /\.hero-metric__summary\s*{[^}]*display:\s*flex[^}]*align-items:\s*center/s);
  assert.match(css, /\.hero-metric__ribbon\s*{[^}]*width:\s*clamp\(326px,\s*96vw,\s*380px\)[^}]*height:\s*210px/s);
});

test("future planned row has no orphan top divider", async () => {
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(css, /#plannedNotice\s*>\s*\.planned-due-row:first-child\s*{[^}]*border-top:\s*0/s);
});

test("Shortcut unavailable state hides the setup CTA until an install URL exists", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");

  assert.match(html, /class="button-row hidden" id="quickAccessSetupActions"/);
  assert.match(html, /class="settings-hint" id="quickAccessUnavailableState"/);
  assert.match(app, /quickAccessSetupActions/);
  assert.match(app, /classList\.toggle\("hidden",\s*!quickAccessShortcutUrl\)/);
  assert.equal(translations.ru["quickAccess.installUnavailable"], "Shortcut пока недоступен — готовим установку.");
  assert.equal(translations.en["quickAccess.installUnavailable"], "Shortcut is not available yet — we’re preparing installation.");
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

test("settings uses autosave controls without the old global submit or dirty state", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");
  const settingsStart = html.indexOf('id="settingsForm"');
  const settingsEnd = html.indexOf("</form>", settingsStart);
  const settingsMarkup = html.slice(settingsStart, settingsEnd);

  assert.doesNotMatch(settingsMarkup, /type="submit"/);
  assert.doesNotMatch(settingsMarkup, /settingsDirtyState|settings-dirty-state/);
  assert.doesNotMatch(app, /addEventListener\("submit", saveSettings\)/);
  assert.match(app, /#settingsForm"\)\?\.addEventListener\("submit", \(event\) => event\.preventDefault\(\)\)/);
  assert.match(app, /createSettingsSaveQueue/);
  assert.match(app, /scheduleSettingsAutosave/);
});

test("regular monthly budget is confirmed separately from autosave", async () => {
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");
  const handlerStart = app.indexOf("async function saveMonthlyBudget");
  const handlerEnd = app.indexOf("async function requestExpenseExport", handlerStart);
  const handler = app.slice(handlerStart, handlerEnd);

  assert.ok(handlerStart >= 0);
  assert.match(handler, /commitMonthlyBudgetChange/);
  assert.match(handler, /settingsSaveQueue\.enqueue/);
  assert.match(handler, /window\.confirm/);
  assert.match(app, /#budgetInput"\)\?\.addEventListener\("keydown"[^]*event\.key !== "Enter"[^]*event\.currentTarget\.blur\(\)/);
});

test("account deletion is collapsed by default and resets when closed", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(html, /<details[^>]+id="deleteAccountSection"[^>]*>/);
  assert.match(html, /<summary[^>]+class="danger-zone__summary"[^]*data-i18n="settings\.deleteDataTitle"/);
  assert.doesNotMatch(html, /<details[^>]+id="deleteAccountSection"[^>]+open/);
  assert.match(app, /deleteAccountSection\?\.addEventListener\("toggle"[^]*setDeleteAccountStage\("start"\)/);
  assert.match(css, /\.danger-zone\s*{[^}]*margin:\s*18px 16px 0/s);
  assert.doesNotMatch(css, /\.danger-zone\s*{[^}]*margin[^;]*118px/s);
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
    "settings.deleteDataDisclosureHint",
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
  assert.match(app, /async function performHistoryLoad\(\)\s*{\s*if \(accountDeleted\) return;/);
  assert.match(app, /function scheduleSettingsAutosave\(\)\s*{\s*if \(accountDeleted\) return Promise\.resolve\(\);[^]*?settingsSaveQueue\.enqueue/);
  assert.match(app, /async function requestExpenseExport\(period\)\s*{\s*if \(accountDeleted\) return;/);
  assert.match(app, /function switchTab\(tab, \{ fromPager = false \} = \{\}\)\s*{\s*if \(accountDeleted\) return;/);
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

test("history period picker CSS avoids horizontal scroll and respects safe areas", async () => {
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(css, /\.history-period-row\s*{[^}]*min-width:\s*0/s);
  assert.match(css, /\.history-filter-chips\s*{[^}]*min-width:\s*0[^}]*overflow-x:\s*visible/s);
  assert.match(css, /\.history-date-action\s*{[^}]*width:\s*100%/s);
  assert.match(css, /\.history-date-sheet\s*{[^}]*position:\s*fixed[^}]*bottom:\s*0/s);
  assert.match(css, /\.history-date-sheet\s*{[^}]*env\(safe-area-inset-bottom\)/s);
  assert.doesNotMatch(css, /\.history-custom-range\s*{/);
});

test("history refresh uses a four-column period grid, separate dates action and compact search", async () => {
  const [html, css] = await Promise.all([
    readFile(new URL("../src/index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);
  assert.match(html, /id="historyQuickPeriods"[\s\S]*data-history-period="today"[\s\S]*data-history-period="yesterday"[\s\S]*data-history-period="last7"[\s\S]*data-history-period="month"/);
  assert.match(html, /id="historyQuickPeriods"[\s\S]*<\/div>\s*<button[^>]+id="openHistoryDatePicker"/);
  assert.match(html, /id="historySearchClear"/);
  assert.doesNotMatch(html, /id="historySearchForm"[\s\S]{0,700}data-i18n="actions\.find"/);
  assert.match(css, /\.history-filter-chips\s*{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)[^}]*overflow-x:\s*visible/s);
});

test("history includes collapsed period analytics and reuses shared category icons", async () => {
  const [html, app, icons] = await Promise.all([
    readFile(new URL("../src/index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/categoryIcons.js", import.meta.url), "utf8")
  ]);
  assert.match(html, /<details[^>]+id="historyAnalytics"(?![^>]*\sopen)[^>]*>/);
  assert.match(html, /id="historyCategoryDonut"/);
  assert.match(html, /id="historyTopExpenses"/);
  assert.match(app, /import \{ categoryIconSvg \} from "\.\/categoryIcons\.js"/);
  assert.doesNotMatch(app, /function dashboardCategoryIcon/);
  assert.match(icons, /export function categoryIconSvg/);
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

  const cardBackText = css.match(/\.dashboard-card__back-text\s*{[^}]*}/s)?.[0] ?? "";
  assert.ok(cardBackText, ".dashboard-card__back-text rule should exist");

  assert.doesNotMatch(cardBackText, /overflow-y:\s*auto/);
  assert.match(cardBackText, /font-size:\s*clamp\(12px,\s*2\.8vw,\s*14px\)/);
  assert.match(cardBackText, /font-weight:\s*650/);
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
  assert.match(css, /\.hero-metric\s*{[^}]*border-radius:\s*20px[^}]*background:\s*linear-gradient/s);
  assert.match(css, /\.hero-metric__amount\s*{[^}]*font-size:\s*clamp\(31px,\s*9vw,\s*39px\)/s);
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

  assert.match(css, /@media \(max-width:\s*640px\)\s*{[^}]*\.shell\s*{[^}]*padding:\s*max\(14px, var\(--tg-content-safe-area-inset-top,[^;]+\)\) 16px calc\(96px \+ max\(0px, var\(--tg-content-safe-area-inset-bottom,/s);
  assert.match(css, /@media \(max-width:\s*640px\)[^]*\.dashboard-card,[^}]*\.dashboard-card__face--back\s*{[^}]*min-height:\s*140px/s);
  assert.match(css, /@media \(max-width:\s*640px\)[^]*\.dashboard-card__face--front\s*{[^}]*gap:\s*5px[^}]*padding:\s*12px/s);
  assert.match(css, /@media \(max-width:\s*640px\)[^]*\.dashboard-card__amount\s*{[^}]*font-size:\s*clamp\(19px,\s*5\.5vw,\s*23px\)/s);
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
  const heroIndex = html.indexOf('class="hero-metric"');
  const inboxIndex = html.indexOf('id="dashboardInboxBlock"');
  const plannedIndex = html.indexOf('id="plannedNotice"');
  const forecastIndex = html.indexOf('id="monthlyForecast"');
  const budgetIndex = html.indexOf('id="budgetPlan"');
  const latestIndex = html.indexOf('id="latestExpensesSection"');
  const categoriesIndex = html.indexOf('id="categoriesDisclosure"');
  const activityIndex = html.indexOf('id="activityDisclosure"');

  assert.ok(heroIndex < inboxIndex);
  assert.ok(inboxIndex < plannedIndex);
  assert.ok(plannedIndex < forecastIndex);
  assert.ok(forecastIndex < budgetIndex);
  assert.ok(budgetIndex < latestIndex);
  assert.ok(latestIndex < categoriesIndex);
  assert.ok(categoriesIndex < activityIndex);
  assert.match(html, /<details class="dashboard-disclosure monthly-forecast" id="monthlyForecast">/);
  assert.match(html, /<details class="dashboard-disclosure budget-plan" id="budgetPlan">/);
  assert.match(html, /id="forecastSummaryTotal"/);
  assert.match(html, /id="forecastSummaryStatus"/);
  assert.match(html, /id="budgetPlanSummary"/);
  assert.ok(
    html.indexOf('id="otherWarning"') > categoriesIndex
      && html.indexOf('id="otherWarning"') < activityIndex
  );
  assert.match(app, /nextUnpaidPlannedItem/);
  assert.match(html, /class="bottom-tabs"/);
  assert.equal((html.match(/class="tab-button__icon"/g) ?? []).length, 4);
  assert.equal((html.match(/class="tab-button__label"/g) ?? []).length, 4);
  assert.match(app, /\.tab-button__label/);
  assert.match(css, /\.bottom-tabs\s*{/);
  assert.match(css, /\.tab-button__icon\s*{/);
  assert.match(css, /\.dashboard-disclosure\s*{/);
  assert.match(css, /\.dashboard-disclosure__summary\s*{/);
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
  assert.match(html, /class="hero-metric__summary"/);
  assert.match(html, /class="hero-metric__amount"[^>]*id="safeToSpend"/);
  assert.match(html, /class="hero-metric__ribbon"/);
  assert.match(html, /class="hero-metric__ribbon-band hero-metric__ribbon-band--one"/);
  assert.match(html, /class="hero-metric__facts"/);
  assert.match(html, /class="hero-metric__footer"/);
  assert.match(html, /id="heroTooltip"/);
  assert.match(html, /id="heroTooltipText"/);
  assert.match(html, /id="heroDetailsToggle"/);
  assert.match(html, /class="hero-metric__details-toggle"[^]*aria-controls="heroTooltip"/);
  assert.doesNotMatch(html, /hero-metric__flip-inner|hero-metric__face|hero-topline/);
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
  assert.match(css, /\.hero-metric__summary\s*{[^}]*position:\s*relative[^}]*min-height:\s*calc\(140px \+ var\(--tg-fullscreen-control-extra-top, 0px\)\)/s);
  assert.match(css, /\.hero-metric__facts\s*{[^}]*border-radius:\s*14px[^}]*background:\s*color-mix/s);
  assert.match(css, /\.hero-metric__details-toggle\s*{/);
  assert.match(css, /\.hero-metric__details\[hidden\]\s*{\s*display:\s*none/s);
  assert.match(css, /transform-style:\s*preserve-3d/);
  assert.doesNotMatch(css, /\.hero-metric__flip-inner|\.hero-metric__face|\.hero-topline/);
  assert.doesNotMatch(app, /heroStatus/);
});

test("dashboard latest expenses use three tappable icon rows that open the existing editor", async () => {
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(app, /expenses\.slice\(0,\s*3\)\.map\(dashboardExpenseRow\)/);
  assert.match(app, /function dashboardExpenseRow\(expense\)/);
  assert.match(app, /categoryIconSvg\(expense\.category_slug\)/);
  assert.match(app, /<svg[^>]+viewBox="0 0 24 24"/);
  const latestRenderer = app.match(/function renderLatest\(expenses\)\s*{[^]*?\n}/)?.[0] ?? "";
  assert.match(latestRenderer, /bindExpenseActions\(list,\s*expenses,\s*\{\s*returnTab:\s*"dashboard"\s*\}\)/);
  assert.doesNotMatch(latestRenderer, /expenses\.map\(expenseRow\)/);
  const dashboardRow = app.match(/function dashboardExpenseRow\(expense\)\s*{[^]*?\n}/)?.[0] ?? "";
  assert.match(dashboardRow, /data-edit-expense/);
  assert.doesNotMatch(dashboardRow, /data-delete-expense/);
  assert.doesNotMatch(dashboardRow, /<div\b/);
  assert.match(dashboardRow, /<span class="dashboard-expense-main">/);
  assert.match(dashboardRow, /<span class="dashboard-expense-amount">/);
  assert.match(css, /\.dashboard-expense-row\s*{/);
  assert.match(css, /\.dashboard-expense-row:active\s*{/);
  assert.match(css, /\.dashboard-expense-icon\s*{/);
});

test("history expenses are compact tappable rows without permanent actions", async () => {
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  const historyRow = app.match(/function expenseRow\(expense\)\s*{[^]*?\n}/)?.[0] ?? "";
  assert.match(historyRow, /<button[^>]+class="expense-row history-expense-row"[^>]+data-edit-expense/);
  assert.match(historyRow, /dashboard-expense-icon/);
  assert.match(historyRow, /history-expense-amount/);
  assert.doesNotMatch(historyRow, /data-delete-expense|button-row compact|>\$\{t\("actions\.edit"\)\}<\/button>/);
  assert.match(css, /\.history-expense-row\s*{[^}]*grid-template-columns:\s*38px minmax\(0,\s*1fr\) auto/s);
  assert.match(css, /\.history-expense-row:focus-visible\s*{/);
  assert.match(css, /body\[data-theme="dark"\] \.history-day-heading\s*{[^}]*background:[^}]*color:\s*var\(--ink\)/s);
});

test("expense and planned edits share one modal without inline scrolling or tab navigation", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");

  assert.match(html, /id="editModalBackdrop"/);
  assert.match(html, /id="editModal"[^>]+role="dialog"[^>]+aria-modal="true"[^>]+aria-labelledby="editModalTitle"/);
  assert.match(html, /id="editModalBody"/);
  assert.equal((html.match(/id="expenseForm"/g) ?? []).length, 1);
  assert.equal((html.match(/id="plannedForm"/g) ?? []).length, 1);

  assert.match(app, /createEditModalController\(/);
  assert.match(app, /renderExpenseEditor\(expense, \{ returnTab: options\.returnTab \?\? "history" \}\)/);
  assert.match(app, /openEditModal\(\{[^}]*form:[^}]*titleText:/s);
  assert.match(app, /<details class="edit-modal__advanced">[\s\S]*?<summary>\$\{t\("forms\.additional"\)\}<\/summary>[\s\S]*?name="\$\{prefix\}-budget_impact"[\s\S]*?name="\$\{prefix\}-spent_at"[\s\S]*?name="\$\{prefix\}-tags"[\s\S]*?<\/details>/);
  assert.match(app, /const plannedTagsField = `[\s\S]*?name="planned-tags"[\s\S]*?`;/);
  assert.match(app, /const plannedTags = mode === "edit" \? `[\s\S]*?<details class="edit-modal__advanced">[\s\S]*?<summary>\$\{t\("forms\.additional"\)\}<\/summary>[\s\S]*?\$\{plannedTagsField\}[\s\S]*?<\/details>/);
  const expenseEditor = app.match(/function renderExpenseEditor\(expense, options = \{\}\)\s*\{[^]*?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(expenseEditor, /switchTab|scrollIntoView/);
  assert.match(expenseEditor, /type="submit"[^>]*>\$\{t\("actions\.saveExpense"\)}/);
  assert.match(expenseEditor, /data-delete-expense/);
  assert.doesNotMatch(expenseEditor, /closeExpenseEditorButton|t\("actions\.close"\)/);
  const plannedActions = app.match(/function bindPlannedActions\(container, items\)\s*\{[^]*?\n\}/)?.[0] ?? "";
  const plannedEditHandlers = [...plannedActions.matchAll(/querySelectorAll\("\[data-edit-planned\]"\)[^]*?openPlannedEditor\(item\);/g)];
  assert.equal(plannedEditHandlers.length, 2);
  plannedEditHandlers.forEach(([handler]) => assert.doesNotMatch(handler, /switchTab\("plan"\)|scrollIntoView/));

  assert.match(css, /body\.edit-modal-open\s*{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.edit-modal-backdrop\s*{[^}]*position:\s*fixed[^}]*inset:\s*0/s);
  assert.match(css, /\.edit-modal\s*{[^}]*--edit-modal-safe-top:[^;]*--tg-fullscreen-control-extra-top[^;]*;[^}]*top:\s*calc\(var\(--edit-modal-safe-top\) \+ \(\(100dvh - var\(--edit-modal-safe-top\) - var\(--edit-modal-safe-bottom\)\) \/ 2\)\)[^}]*bottom:\s*auto[^}]*height:\s*auto[^}]*max-height:\s*calc\(100dvh - var\(--edit-modal-safe-top\) - var\(--edit-modal-safe-bottom\)\)[^}]*transform:\s*translateY\(-50%\)[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.edit-modal__body\s*{[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/s);
  assert.match(css, /\.edit-modal \.form-stack\s*{[^}]*gap:\s*8px[^}]*padding:\s*0/s);
  assert.match(css, /\.edit-modal__advanced\s*{/);
  assert.match(css, /@media \(max-width:\s*430px\)[^]*\.edit-modal \.field-grid\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.edit-modal__actions|\.edit-modal \.button-row/);
});

test("language changes rerender cached dynamic dashboard content without another request", async () => {
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");
  const applyLanguage = app.match(/function applyLanguage\(language\)\s*{[^]*?\r?\n}\r?\n\r?\nfunction applyTheme/)?.[0] ?? "";
  const rerender = app.match(/function rerenderDashboardLanguageState\(\)\s*{[^]*?\r?\n}/)?.[0] ?? "";

  assert.match(applyLanguage, /rerenderDashboardLanguageState\(\)/);
  assert.match(rerender, /dashboardState\?\.snapshot/);
  assert.match(rerender, /renderSnapshot\(dashboardState\.snapshot\)/);
  assert.match(rerender, /renderLatest\(dashboardState\.latestExpenses\s*\?\?\s*\[\]\)/);
  assert.match(rerender, /renderAnalytics\(\s*dashboardState\.snapshot,\s*dashboardState\.analytics\s*\?\?\s*\{\}\s*\)/);
  assert.match(rerender, /const plannedExpenses = dashboardState\.plannedExpenses\s*\?\?\s*\[\]/);
  assert.match(rerender, /renderPlannedNotice\(plannedExpenses\)/);
  assert.doesNotMatch(rerender, /\bload\s*\(/);
  assert.doesNotMatch(app, /setText\("#heroTooltipText"/);
});

test("hero calculation is structured and mobile budget cards keep the reference 2 by 2 grid", async () => {
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(app, /dashboard\.hero\.calculationTitle/);
  assert.match(app, /hero-metric__calculation-title/);
  assert.match(css, /\.hero-metric__detail-row--result\s*{/);
  assert.doesNotMatch(app, /\["dashboard\.hero\.baseBudget",\s*currentMonthBudget\?\.baseBudget\],[^]*\["dashboard\.hero\.monthBudget",\s*snapshot\.monthlyBudget\]/);
  assert.match(css, /@media \(max-width:\s*640px\)[^]*\.metrics-grid\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
});

test("hero ribbon fills the upper right hero background instead of a small inset illustration", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.match(html, /hero-metric__ribbon[^>]*preserveAspectRatio="xMidYMid slice"/);
  assert.match(css, /\.hero-metric__ribbon\s*{[^}]*top:\s*-32px[^}]*right:\s*-58px[^}]*width:\s*clamp\(326px,\s*96vw,\s*380px\)[^}]*height:\s*210px/s);
});

test("all four bottom navigation icons have explicit stable SVG identities", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");

  for (const icon of ["dashboard", "history", "plan", "settings"]) {
    assert.match(html, new RegExp(`data-nav-icon="${icon}"`));
  }
  assert.equal((html.match(/data-nav-icon="/g) ?? []).length, 4);
  assert.match(html, /data-nav-icon="plan"[^>]*data-nav-shape="calendar"/);
  assert.match(html, /data-nav-icon="settings"[^>]*data-nav-shape="gear"/);
  assert.match(html, /data-nav-icon="history"[^>]*><svg[^>]*><path d="M3 12a9 9 0 1 0 3-6\.7"/);
  assert.doesNotMatch(html, /data-nav-icon="history"[^>]*><svg[^>]*><path d="M5 20V8/);
});

test("dashboard light theme uses the approved warm surface system", async () => {
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  const lightTheme = css.match(/body\[data-theme="light"\]\s*{[^}]*}/s)?.[0] ?? "";
  assert.match(lightTheme, /--bg:\s*#f8f6f1/);
  assert.match(lightTheme, /--panel:\s*#fffefa/);
  assert.match(lightTheme, /--line:\s*#e8e2da/);
  assert.match(lightTheme, /--ink:\s*#1d2530/);
  assert.match(lightTheme, /--muted:\s*#6f6a63/);
  assert.match(css, /\.dashboard-disclosure,[^]*\.latest-expenses\s*{[^}]*border-radius:\s*18px/s);
});

test("Plan separates planned payment summary, explanation, and budget reserve", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");

  assert.match(html, /<h2 data-i18n="screen\.plan">/);
  assert.match(html, /class="plan-info-disclosure"[^]*data-i18n="plan\.infoPlannedBody"[^]*data-i18n="plan\.infoReserveBody"/s);
  assert.match(html, /class="planned-summary-card"[^]*data-i18n="plan\.summaryTitle"[^]*id="plannedSummaryProgress"[^]*id="plannedReservePaidRemaining"/s);
  assert.match(html, /class="planned-summary-rows"/);
  assert.match(app, /plannedSummaryRowHtml\("Оплачено",\s*paid\)/);
  assert.match(app, /plannedSummaryRowHtml\("Осталось",\s*remaining\)/);
  assert.match(app, /plannedPaidPercent\(summary\)/);
  assert.match(css, /\.planned-summary-progress__fill\s*{[^}]*background:\s*var\(--accent\)/s);
  assert.match(css, /\.planned-summary-row\s*{[^}]*grid-template-columns:\s*86px minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.planned-summary-row__amount\s*{[^}]*color:\s*var\(--ink\)/s);
});

test("active planned cards share expense visuals while Pay stays direct and destructive actions stay in overflow", async () => {
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  const renderBlock = app.slice(app.indexOf("function renderPlannedExpenses"), app.indexOf("function closeAndResetPlannedForm"));
  assert.match(renderBlock, /class="planned-expense-card"/);
  assert.match(renderBlock, /localDateKeyInTimeZone\(new Date\(\), userTimeZone\(\)\)/);
  assert.match(renderBlock, /class="planned-expense-card__main"[^>]+data-edit-planned/);
  assert.match(renderBlock, /class="dashboard-expense-icon"[^]*categoryIconSvg\(item\.category_slug\)/);
  assert.match(renderBlock, /plannedPaymentStatus\(item, today\)/);
  assert.match(renderBlock, /planned-expense-card__status planned-expense-card__status--\$\{status\}/);
  assert.match(renderBlock, /class="planned-expense-card__actions"[^]*data-pay-planned[^]*data-planned-overflow/s);
  assert.match(renderBlock, /class="planned-expense-card__overflow"[^]*data-delete-planned/s);
  const permanentActions = renderBlock.slice(
    renderBlock.indexOf('class="planned-expense-card__actions"'),
    renderBlock.indexOf('class="planned-expense-card__overflow"')
  );
  assert.doesNotMatch(permanentActions, /actions\.edit/);
  assert.doesNotMatch(permanentActions, /data-delete-planned/);
  assert.match(css, /\.planned-expense-card__actions\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) 40px/s);
  assert.match(css, /\.planned-expense-card__status--paid\s*{[^}]*color:\s*var\(--green\)/s);
  assert.match(css, /\.planned-expense-card__status--overdue\s*{[^}]*color:\s*var\(--red\)/s);
  assert.match(css, /\.planned-expense-card__main\s*{[^}]*grid-template-columns:\s*38px minmax\(0,\s*1fr\) auto/s);
});

test("planned edit modal keeps only save and existing disable actions while create can still reset", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const renderForm = app.slice(app.indexOf("function renderPlannedForm"), app.indexOf("function syncPlannedRecurrenceFields"));

  assert.match(renderForm, /mode === "edit"[\s\S]*?data-disable-planned-edit/);
  assert.match(renderForm, /t\("plan\.disableExisting"\)/);
  assert.match(renderForm, /mode === "edit"\s*\?[^:]+:\s*`[\s\S]*?id="resetPlannedForm"[\s\S]*?id="cancelPlannedForm"/);
  assert.doesNotMatch(renderForm, /if \(mode === "edit"\) renderPlannedForm\(item, \{ mode: "edit" \}\)/);
  assert.match(app, /disablePlanned\(item,\s*event\.currentTarget,\s*\{ closeModal: true \}\)/);
  assert.match(app, /closeModal[\s\S]*?closeEditModal\(\)[\s\S]*?await loadDashboard\(\)[\s\S]*?editModal\.restore\(\)/);
  assert.match(css, /\.edit-modal \.edit-modal__actions\s*{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
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

test("settings are grouped into focused sections with quick access and evening reminder", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const settingsStart = html.indexOf('id="settingsTab"');
  const settingsEnd = html.indexOf("</main>", settingsStart);
  const settingsHtml = html.slice(settingsStart, settingsEnd);

  assert.equal((settingsHtml.match(/class="settings-section"/g) ?? []).length, 5);
  assert.match(settingsHtml, /id="quickAccessBlock"/);
  assert.match(settingsHtml, /id="setupQuickAccessButton"/);
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

test("currency selectors use native option labels without overlay markers", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");

  assert.doesNotMatch(html, /id="baseCurrencyMark"/);
  assert.doesNotMatch(html, /id="displayCurrencyMark"/);
  assert.match(html, /<option value="THB">🇹🇭 THB — Thai baht<\/option>/);
  assert.doesNotMatch(html, /interfaceLanguageFlag/);
  assert.doesNotMatch(html, /flag-icon/);
  assert.doesNotMatch(html, /data-currency/);
  assert.doesNotMatch(html, /data-language/);
  assert.doesNotMatch(app, /updateSettingsDecorations/);
  assert.doesNotMatch(app, /CURRENCY_MARKS/);
  assert.doesNotMatch(app, /updateCurrencyFlags/);
  assert.doesNotMatch(css, /\.currency-mark/);
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

test("Quick Entry is a five-slot navigation action and is unavailable during onboarding", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");
  const css = await readFile(join(miniAppRoot, "styles.css"), "utf8");
  assert.equal((html.match(/<button class="tab-button(?: active)?" type="button" data-tab=/g) ?? []).length, 4);
  assert.match(html, /<nav class="bottom-tabs"[^>]*>[\s\S]*data-tab="dashboard"[\s\S]*data-tab="history"[\s\S]*id="openQuickEntryButton"[\s\S]*data-tab="plan"[\s\S]*data-tab="settings"[\s\S]*<\/nav>/);
  assert.match(html, /class="quick-entry-action hidden"[^>]*id="openQuickEntryButton"[^>]*data-i18n-aria-label="quickEntry\.addExpense"/);
  assert.doesNotMatch(css, /\.quick-entry-fab/);
  assert.match(css, /\.bottom-tabs\s*{[^}]*grid-template-columns:\s*repeat\(5,/s);
  assert.match(css, /\.quick-entry-action\s*{[^}]*transform:\s*translateY\(-15px\)/s);
  const onboarding = app.match(/function renderOnboardingState\(user\)\s*{[^]*?\n}/)?.[0] ?? "";
  assert.match(onboarding, /#openQuickEntryButton/);
  assert.match(app, /status === "unsupported"\) return/);
  assert.match(app, /if \(data\.shortcutConfigured\)/);
  assert.match(app, /#quickAccessConfiguredState/);
  assert.equal(translations.ru["quickEntry.addExpense"], "Добавить расход");
  assert.equal(translations.en["quickEntry.addExpense"], "Add expense");
});

test("Settings omits weekly budget from the form, dirty state and PATCH payload", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");

  assert.doesNotMatch(html, /weeklyBudgetInput|weeklyBudgetAmount|settings\.weeklyBudget/);
  assert.doesNotMatch(app, /weeklyBudgetInput|weeklyBudgetAmount|settings\.weeklyBudget/);
});

test("Dashboard inbox uses an open-by-default disclosure with summary preview", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");

  assert.match(html, /<details class="dashboard-disclosure dashboard-inbox hidden" id="dashboardInboxBlock">/);
  assert.match(html, /id="dashboardInboxPreview"/);
  assert.match(app, /if \(wasHidden\) block\.open = true/);
  assert.match(app, /inboxSummaryPreview\(drafts, currentLanguage/);
});
