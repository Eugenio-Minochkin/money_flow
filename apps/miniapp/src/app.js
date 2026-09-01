import { buildDashboardRequestPath, createApiClient, isOnboardingDashboardResponse } from "./apiClient.js";
import { categories, categoryColor, categoryLabel } from "./categories.js";
import { categoryIconSvg } from "./categoryIcons.js";
import { currencyOptions } from "./currencies.js";
import { resolveDraftSaveResponse, classifyConfirmOutcome } from "./draftSave.js";
import { activatePreparedShortcut, handoffPreparedShortcut, prepareShortcutSetup } from "./quickAccessSetup.js";
import { collectQuickCaptureReviewItems, quickCaptureItemNeedsReview } from "./quickCaptureReview.js";
import { describeQuickCaptureSavedResult } from "./quickCaptureSavedResult.js";
import { buildDashboardCards, buildHeroMetric, renderBudgetTopupBreakdown, renderDashboardCards, shouldShowForecastDifference } from "./dashboardCards.js";
import {
  dateTimeLocal,
  escapeAttribute,
  escapeHtml,
  formatDate,
  formatDateOnly,
  formatMoney,
  moneyBase,
  moneyDisplay,
  moneyDisplaySigned,
  localDateKeyInTimeZone,
  setBaseCurrency
} from "./formatters.js";
import {
  buildCalendarMonth,
  buildHistoryAnalytics,
  canNavigateToMonth,
  buildHistoryRequestParams,
  createCalendarDraft,
  expenseCountLabel,
  formatCustomRangeLabel,
  groupByDay,
  historyFilterFromLaunchParams,
  historySummaryKey,
  periodTotal,
  selectRangeDate,
  shiftCalendarMonth
} from "./history.js";
import { createTranslator } from "./i18n.js";
import { createEditModalController, runEditModalSave } from "./editModal.js";
import {
  inboxDraftDescription,
  inboxDraftTotal,
  reviewAcceptanceConfirmMessage,
  reviewAcceptanceErrorMessage,
  reviewAcceptancePrimaryAction,
  reviewAcceptanceReviewAction,
  reviewAcceptanceSummary,
  reviewAcceptanceTitle,
  smartSaveRecoveryPrimaryAction,
  smartSaveRecoveryReviewAction,
  smartSaveRecoverySummary,
  smartSaveRecoveryTitle,
  shouldShowInboxOnDashboard,
  updateFirstInboxItemCategory
} from "./inbox.js";
import {
  TAB_ORDER,
  canStartTabPager,
  createTabPagerGesture,
  finishTabPagerGesture,
  moveTabPagerGesture
} from "./tabPager.js";
import { applyMiniAppTheme } from "./themeBackground.js";
import { shouldRequestTelegramFullscreen } from "./telegramPlatform.js";
import { buildReserveSettingsView } from "./reserveSettings.js";
import { runPlannedDisable } from "./plannedDisable.js";
import { paidPlannedPaymentUndoOccurrences, runPlannedPaymentUndo } from "./plannedPaymentUndo.js";
import { createPlannedRecreateSession, runPlannedRecreate } from "./plannedRecreate.js";
import {
  buildArchivedPlanView,
  collapsePlannedArchive,
  createPlannedArchiveState,
  expandPlannedArchive,
  invalidatePlannedArchive
} from "./plannedArchive.js";
import {
  buildPlannedOccurrences,
  calculatePlannedMonthSummary,
  defaultPlannedCurrency,
  dueOrOverduePlannedOccurrences,
  nextUnpaidPlannedItem,
  parseDueDays,
  plannedPaymentStatus,
  plannedPaidPercent,
  recurrenceLabel as plannedRecurrenceLabel,
  weekdayOptions as plannedWeekdayOptions
} from "./planned.js";
import {
  commitMonthlyBudgetChange,
  createSettingsSaveQueue,
  detectBrowserTimeZone,
  filterTimeZones,
  normalizeSettingsTimeZone,
  shouldShowCurrentMonthBudgetOverride,
  timeZoneOffsetLabel
} from "./settings.js";
import { timeZoneCityLabel } from "./timezones.js";
import { createHistoryLoader } from "./historyLoad.js";
import { finishStartup, markStartup } from "./startupTiming.js";
import { assertSettingsInitialized } from "./settingsStartupSmoke.js";

markStartup("app_evaluated");

const params = new URLSearchParams(window.location.search);
const telegramUserId = params.get("telegramUserId") || window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
const draftId = params.get("draftId");

const percentNumber = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const FLIP_SELECTOR = "[data-flip-card]";
const FLIP_TOGGLE_SELECTOR = "[data-flip-toggle]";
const api = createApiClient();
let dashboardState = null;
let draftState = null;
let draftDirty = false;
let draftReturnTab = "dashboard";
let historyState = [];
let inboxState = [];
let recoveryState = { totalUnresolved: 0, safeCount: 0, reviewCount: 0, safeDraftIds: [], reviewDraftIds: [], drafts: [] };
let historyReviewQueueIds = [];
let historyReviewQueueTotal = 0;
let historyFilterState = historyFilterFromLaunchParams(params);
let historyCalendarDraft = null;
let currentLanguage = "en";
let translate = createTranslator(currentLanguage);
let currentTheme = "light";
let reserveSettingsExpanded = false;
let preserveSettingsControlsDuringRefresh = false;
let accountDeleted = false;
let cancelTabPager = () => {};
const plannedArchiveState = createPlannedArchiveState();
const historyLoader = createHistoryLoader(performHistoryLoad);

const deleteAccountStartButton = document.getElementById("deleteAccountStartButton");
const deleteAccountAdvanceButton = document.getElementById("deleteAccountAdvanceButton");
const deleteAccountCancelButton = document.getElementById("deleteAccountCancelButton");
const deleteAccountConfirmInput = document.getElementById("deleteAccountConfirmInput");
const deleteAccountConfirmButton = document.getElementById("deleteAccountConfirmButton");
const deleteAccountSection = document.getElementById("deleteAccountSection");
const settingsSaveQueue = createSettingsSaveQueue({
  save: async (settings) => {
    const { monthlyBudgetAmount: _monthlyBudgetAmount, ...autosaveSettings } = settings;
    const result = await api("/api/settings", {
      method: "PATCH",
      body: { telegramUserId, settings: autosaveSettings }
    });
    if (dashboardState?.user && result.user) dashboardState.user = result.user;
    return settingsStateFromUser(result.user);
  },
  onError: (_error, confirmed) => {
    restoreAutosaveControls(confirmed);
    showToast(t("toast.settingsSaveFailed"));
  },
  onIdle: async () => {
    preserveSettingsControlsDuringRefresh = true;
    try {
      await loadDashboard();
      showToast(t("toast.settingsSaved"));
    } catch {
      showToast(t("toast.settingsRefreshFailed"));
    } finally {
      preserveSettingsControlsDuringRefresh = false;
    }
  }
});
const editModal = createEditModalController({
  modal: document.getElementById("editModal"),
  backdrop: document.getElementById("editModalBackdrop"),
  modalBody: document.getElementById("editModalBody"),
  title: document.getElementById("editModalTitle"),
  documentBody: document.body,
  pageRoot: document.querySelector(".shell")
});

function disableTelegramVerticalSwipes() {
  window.Telegram?.WebApp?.disableVerticalSwipes?.();
}

function syncFullscreenControlSafeArea() {
  const webApp = window.Telegram?.WebApp;
  if (!webApp) return;
  const isFullscreen = Boolean(webApp.isFullscreen);
  const contentTop = Number(webApp.contentSafeAreaInset?.top ?? 0);
  const safeTop = Number(webApp.safeAreaInset?.top ?? 0);
  const isIOS = webApp.platform === "ios" || /iPad|iPhone|iPod/.test(navigator.userAgent);
  const iOSControlFallback = safeTop + 52;
  const desiredTop = isFullscreen && isIOS ? Math.max(contentTop, iOSControlFallback) : contentTop;
  const extraTop = Math.max(0, desiredTop - contentTop);

  document.body.classList.toggle("is-fullscreen", isFullscreen);
  document.documentElement.style.setProperty("--tg-fullscreen-control-extra-top", `${extraTop}px`);
}

function syncMiniAppThemeBackground() {
  currentTheme = applyMiniAppTheme(currentTheme, {
    documentElement: document.documentElement,
    body: document.body,
    webApp: window.Telegram?.WebApp
  });
}

if (window.Telegram?.WebApp) {
  const webApp = window.Telegram.WebApp;
  disableTelegramVerticalSwipes();
  syncFullscreenControlSafeArea();
  webApp.onEvent?.("fullscreenChanged", syncFullscreenControlSafeArea);
  webApp.onEvent?.("safeAreaChanged", syncFullscreenControlSafeArea);
  webApp.onEvent?.("contentSafeAreaChanged", syncFullscreenControlSafeArea);
  webApp.onEvent?.("fullscreenChanged", disableTelegramVerticalSwipes);
  webApp.onEvent?.("themeChanged", syncMiniAppThemeBackground);
  if (shouldRequestTelegramFullscreen(webApp.platform)) {
    try { webApp.requestFullscreen?.(); } catch { /* expand remains the fallback */ }
  }
}
syncMiniAppThemeBackground();

const quickEntrySheet = document.querySelector("#quickEntrySheet");
const quickEntryBackdrop = document.querySelector("#quickEntryBackdrop");
const quickEntryText = document.querySelector("#quickEntryText");
const quickEntrySubmit = document.querySelector("#quickEntrySubmit");
const quickEntryStatus = document.querySelector("#quickEntryStatus");
const quickEntryForm = document.querySelector("#quickEntryForm");
const quickCaptureReview = document.querySelector("#quickCaptureReview");
const quickCaptureReviewItems = document.querySelector("#quickCaptureReviewItems");
const quickCaptureReviewStatus = document.querySelector("#quickCaptureReviewStatus");
let quickCaptureDraft = null;
let quickCaptureCategorySelections = new Set();
let quickAccessShortcutUrl = null;
let quickAccessTokenBusy = false;
let quickAccessPreparationId = null;
let quickAccessPreparedToken = null;
let quickAccessClipboardFailed = false;
let quickAccessKeyRevealed = false;
let quickAccessConfigured = false;
let quickAccessSetupError = false;
let quickEntryRequestId = null;
quickEntryText?.addEventListener("input", () => { quickEntryRequestId = null; });
document.querySelector("#openQuickEntryButton")?.addEventListener("click", () => {
  resetQuickEntryView();
  quickEntrySheet.classList.remove("hidden"); quickEntryBackdrop.classList.remove("hidden");
  if (quickEntryStatus) quickEntryStatus.textContent = "";
  quickEntryText?.focus();
  void recordQuickAccessEvent("quick_entry_opened");
});
quickEntryBackdrop?.addEventListener("click", () => {
  if (quickEntrySubmit?.disabled || quickCaptureDraft) return;
  closeQuickEntry();
  void recordQuickAccessEvent("quick_entry_canceled");
});
document.querySelector("#quickEntryForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (quickEntrySubmit?.disabled) return;
  const text = quickEntryText?.value.trim();
  if (!text) return;
  setQuickEntryPending(true);
  try {
    quickEntryRequestId ??= crypto.randomUUID();
    const data = await api("/api/quick-entry", { method: "POST", body: { telegramUserId, text, clientRequestId: quickEntryRequestId } });
    quickEntryRequestId = null;
    if (data.saved) {
      renderQuickCaptureSaved(data.saved.expenses);
    } else {
      renderQuickCaptureReview(data.draft);
    }
  } catch (error) {
    quickEntryStatus.textContent = quickEntryErrorMessage(error);
  } finally {
    setQuickEntryPending(false);
  }
});
document.querySelector("#quickCaptureReviewForm")?.addEventListener("submit", saveQuickCaptureReview);
document.querySelector("#cancelQuickCaptureButton")?.addEventListener("click", () => void cancelQuickCapture());
function quickEntryErrorMessage(error) {
  const code = String(error?.body?.error ?? error?.message ?? "");
  if (code === "amount_not_found") return t("quickEntry.error.amountNotFound");
  if (code === "paid_provider_limit_reached") return t("quickEntry.error.processingLimit");
  if (code === "paid_provider_disabled") return t("quickEntry.error.processingUnavailable");
  if (/failed to fetch|networkerror|network request failed/i.test(code)) return t("quickEntry.error.network");
  return t("quickEntry.error.generic");
}

function setQuickEntryPending(pending) {
  quickEntrySheet?.setAttribute("aria-busy", String(pending));
  if (quickEntryText) quickEntryText.disabled = pending;
  if (quickEntrySubmit) {
    quickEntrySubmit.disabled = pending;
    quickEntrySubmit.innerHTML = pending
      ? `<span class="quick-entry-spinner" aria-hidden="true"></span>${escapeHtml(t("quickEntry.recognizing"))}`
      : escapeHtml(t("quickEntry.submit"));
  }
  if (quickEntryStatus && pending) quickEntryStatus.textContent = t("quickEntry.recognizing");
}
function closeQuickEntry({ force = false } = {}) {
  if (quickEntrySubmit?.disabled && !force) return;
  quickEntrySheet?.classList.add("hidden");
  quickEntryBackdrop?.classList.add("hidden");
}

function resetQuickEntryView() {
  quickCaptureDraft = null;
  quickEntryRequestId = null;
  quickEntryForm?.classList.remove("hidden");
  quickCaptureReview?.classList.add("hidden");
  if (quickEntryStatus) quickEntryStatus.textContent = "";
  if (quickCaptureReviewStatus) quickCaptureReviewStatus.textContent = "";
}

function renderQuickCaptureSaved(expenses) {
  const result = describeQuickCaptureSavedResult(expenses);
  closeQuickEntry({ force: true });
  resetQuickEntryView();
  if (quickEntryText) quickEntryText.value = "";
  if (result.kind === "single") showQuickCaptureToast(result.expense);
  if (result.kind === "multiple") showToast(t("quickEntry.savedMultiple", { count: result.count }));
  void Promise.allSettled([loadDashboard(), loadHistory()]);
}

function renderQuickCaptureReview(draft) {
  quickCaptureDraft = draft;
  quickCaptureCategorySelections = new Set();
  draftState = draft;
  quickEntryForm?.classList.add("hidden");
  quickCaptureReview?.classList.remove("hidden");
  if (quickCaptureReviewStatus) quickCaptureReviewStatus.textContent = "";
  quickCaptureReviewItems.innerHTML = draft.items.map((item, index) => quickCaptureReviewItem(item, index)).join("");
  quickCaptureReviewItems.querySelectorAll("[data-quick-capture-category-index]").forEach((select) => {
    select.addEventListener("change", () => quickCaptureCategorySelections.add(Number(select.dataset.quickCaptureCategoryIndex)));
  });
  const title = quickCaptureReview.querySelector("h3");
  if (title) title.textContent = draft.items.length > 1 ? t("quickEntry.reviewMultiple", { count: draft.items.length }) : t("quickEntry.reviewTitle");
  quickCaptureReview.querySelector("#quickCaptureReviewSubmit").textContent = draft.items.length > 1
    ? t("quickEntry.saveMultiple", { count: draft.items.length })
    : t("quickEntry.save");
}

function quickCaptureReviewItem(item, index) {
  const needsReview = quickCaptureItemNeedsReview(item);
  return `
    <article class="quick-capture-review__item">
      <strong>${escapeHtml(item.description)}</strong>
      <span>${formatMoney(item.amount, item.currency)} · ${escapeHtml(categoryLabel(item.category_slug, currentLanguage))}</span>
      ${needsReview ? `
        <label><span>${t("forms.amount")}</span><input name="quick-capture-${index}-amount" type="number" min="0.01" step="0.01" value="${Number(item.amount)}" required /></label>
        <label><span>${t("quickEntry.reviewCategory")}</span><select name="quick-capture-${index}-category" data-quick-capture-category-index="${index}" required>${item.category_slug === "other" ? `<option value="" selected disabled>${escapeHtml(t("quickEntry.reviewCategory"))}</option>` : ""}${categories.filter(([slug]) => item.category_slug !== "other" || slug !== "other").map(([slug]) => option(slug, item.category_slug, categoryLabel(slug, currentLanguage))).join("")}</select></label>
      ` : ""}
    </article>
  `;
}

async function saveQuickCaptureReview(event) {
  event.preventDefault();
  if (!quickCaptureDraft) return;
  const submit = event.currentTarget.querySelector("button[type='submit']");
  submit.disabled = true;
  try {
    const items = collectQuickCaptureReviewItems(
      quickCaptureDraft.items,
      (name) => input(name)?.value,
      (index) => quickCaptureCategorySelections.has(index)
    );
    const savedDraft = await api(`/api/drafts/${quickCaptureDraft.id}`, { method: "PATCH", body: { telegramUserId, items, expectedVersion: quickCaptureDraft.version } });
    quickCaptureDraft = savedDraft.draft;
    draftState = savedDraft.draft;
    const data = await api(`/api/drafts/${quickCaptureDraft.id}/confirm`, { method: "POST", body: { telegramUserId, language: currentLanguage } });
    renderQuickCaptureSaved(data.expenses);
  } catch (error) {
    const outcome = resolveDraftSaveResponse(error?.status ?? 500, error?.body ?? null);
    if (outcome.conflict) {
      renderQuickCaptureReview(outcome.draft);
      if (quickCaptureReviewStatus) quickCaptureReviewStatus.textContent = t("toast.draftConflict");
    } else if (quickCaptureReviewStatus) {
      quickCaptureReviewStatus.textContent = t("quickEntry.reviewSaveFailed");
    }
  } finally {
    submit.disabled = false;
  }
}

async function cancelQuickCapture() {
  if (!quickCaptureDraft) return;
  try {
    await api(`/api/drafts/${quickCaptureDraft.id}`, { method: "DELETE", body: { telegramUserId, language: currentLanguage } });
    closeQuickEntry({ force: true });
    resetQuickEntryView();
    showToast(t("toast.draftCanceled"));
  } catch {
    if (quickCaptureReviewStatus) quickCaptureReviewStatus.textContent = t("quickEntry.reviewCancelFailed");
  }
}

function showQuickCaptureToast(expense) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.innerHTML = `<strong>✓ ${escapeHtml(expense.description)} — ${escapeHtml(formatMoney(expense.amount_original ?? expense.amount, expense.currency_original ?? expense.currency))}</strong><span>${escapeHtml(categoryLabel(expense.category_slug, currentLanguage))}</span><div><button type="button" data-quick-capture-edit>${t("actions.edit")}</button><button type="button" data-quick-capture-undo>${t("quickEntry.undo")}</button></div>`;
  toast.classList.remove("hidden");
  toast.querySelector("[data-quick-capture-edit]")?.addEventListener("click", () => renderExpenseEditor(expense, { returnTab: "dashboard" }));
  toast.querySelector("[data-quick-capture-undo]")?.addEventListener("click", () => void undoQuickCapture(expense));
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 6000);
}

async function undoQuickCapture(expense) {
  try {
    await api(`/api/expenses/${expense.id}`, { method: "DELETE", body: { telegramUserId, language: currentLanguage } });
    document.querySelector("#toast")?.classList.add("hidden");
    await Promise.allSettled([loadDashboard(), loadHistory()]);
    showToast(t("toast.expenseDeleted"));
  } catch {
    showToast(t("quickEntry.undoFailed"));
  }
}

function recordQuickAccessEvent(eventName) {
  if (!telegramUserId) return Promise.resolve();
  return api("/api/quick-access/events", { method: "POST", body: { telegramUserId, eventName } }).catch(() => {});
}

function initializeTelegramQuickAccess() {
  const webApp = window.Telegram?.WebApp;
  if (!webApp?.checkHomeScreenStatus || !webApp?.addToHomeScreen) return;
  const block = document.querySelector("#homeScreenBlock");
  const add = document.querySelector("#addToHomeScreenButton");
  const added = document.querySelector("#homeScreenAddedState");
  webApp.checkHomeScreenStatus((status) => {
    if (status === "unsupported") return;
    block?.classList.remove("hidden");
    void recordQuickAccessEvent("home_screen_prompted");
    if (status === "added") { add?.classList.add("hidden"); added?.classList.remove("hidden"); }
  });
  add?.addEventListener("click", () => { try { webApp.addToHomeScreen(); } catch { /* optional capability */ } });
  webApp.onEvent?.("homeScreenAdded", () => { add?.classList.add("hidden"); added?.classList.remove("hidden"); void recordQuickAccessEvent("home_screen_added"); });
}

async function createQuickAccessToken() {
  if (quickAccessTokenBusy) return;
  if (!quickAccessShortcutUrl) {
    quickAccessSetupError = true;
    renderShortcutSetupState();
    return;
  }
  quickAccessTokenBusy = true;
  quickAccessSetupError = false;
  setQuickAccessTokenBusy(true);
  try {
    const outcome = await prepareShortcutSetup({ api, telegramUserId });
    quickAccessPreparationId = outcome.preparationId;
    quickAccessPreparedToken = outcome.token;
    if (outcome.status !== "prepared") {
      quickAccessSetupError = true;
      return;
    }
  } catch {
    quickAccessSetupError = true;
  } finally {
    quickAccessTokenBusy = false;
    setQuickAccessTokenBusy(false);
    renderShortcutSetupState();
  }
}

function setQuickAccessTokenBusy(busy) {
  document.querySelector("#shortcutSetupPrimaryButton").disabled = busy;
  document.querySelector("#reconfigureQuickAccessButton").disabled = busy;
  document.querySelector("#copyShortcutKeyButton").disabled = busy;
  document.querySelector("#openShortcutAfterManualCopyButton").disabled = busy;
}

async function activatePreparedShortcutAndOpen() {
  const outcome = await activatePreparedShortcut({ api, telegramUserId, preparationId: quickAccessPreparationId, shortcutUrl: quickAccessShortcutUrl, openShortcut: openSharedShortcut });
  if (outcome.status !== "activated") { quickAccessSetupError = true; return outcome; }
  quickAccessConfigured = true;
  clearPreparedShortcutSetup();
  return outcome;
}

async function copyShortcutKeyAndOpen() {
  if (!quickAccessPreparedToken || quickAccessTokenBusy) return;
  quickAccessClipboardFailed = false;
  quickAccessTokenBusy = true; setQuickAccessTokenBusy(true);
  try {
    const outcome = await handoffPreparedShortcut({
      token: quickAccessPreparedToken,
      writeText: navigator.clipboard?.writeText?.bind(navigator.clipboard),
      activate: activatePreparedShortcutAndOpen
    });
    if (outcome.status === "copy_failed") { quickAccessClipboardFailed = true; return; }
    return outcome;
  } finally {
    quickAccessTokenBusy = false; setQuickAccessTokenBusy(false); renderShortcutSetupState();
  }
}

function revealShortcutKey() {
  if (!quickAccessPreparedToken) return;
  quickAccessKeyRevealed = true;
  const field = document.querySelector("#shortcutKeyFallbackValue");
  if (field) field.value = quickAccessPreparedToken;
  renderShortcutSetupState();
}

async function openShortcutAfterManualCopy() {
  if (!quickAccessPreparedToken || quickAccessTokenBusy) return;
  quickAccessTokenBusy = true; setQuickAccessTokenBusy(true);
  try { await activatePreparedShortcutAndOpen(); } finally { quickAccessTokenBusy = false; setQuickAccessTokenBusy(false); renderShortcutSetupState(); }
}

function clearPreparedShortcutSetup() {
  quickAccessPreparationId = null; quickAccessPreparedToken = null; quickAccessClipboardFailed = false; quickAccessKeyRevealed = false;
  quickAccessSetupError = false;
  const field = document.querySelector("#shortcutKeyFallbackValue");
  if (field) field.value = "";
}

function openSharedShortcut(url) {
  const telegram = window.Telegram?.WebApp;
  if (telegram?.openLink) return telegram.openLink(url);
  window.open(url, "_blank", "noopener");
}

function openShortcutSetup() {
  document.querySelector("#shortcutSetupSheet")?.classList.remove("hidden");
  document.querySelector("#shortcutSetupBackdrop")?.classList.remove("hidden");
  document.body.classList.add("shortcut-setup-open");
  renderShortcutSetupState();
}

function closeShortcutSetup() {
  document.querySelector("#shortcutSetupSheet")?.classList.add("hidden");
  document.querySelector("#shortcutSetupBackdrop")?.classList.add("hidden");
  document.body.classList.remove("shortcut-setup-open");
  clearPreparedShortcutSetup();
}

function renderShortcutSetupState() {
  const unavailable = !quickAccessShortcutUrl;
  const prepared = Boolean(quickAccessPreparationId && quickAccessPreparedToken);
  document.querySelector("#quickAccessConfiguredBadge")?.classList.toggle("hidden", !quickAccessConfigured);
  document.querySelector("#quickAccessUnavailableState")?.classList.toggle("hidden", !unavailable);
  document.querySelector("#retryShortcutSetupConfigButton")?.classList.toggle("hidden", !unavailable);
  document.querySelector("#shortcutSetupUnavailableState")?.classList.toggle("hidden", !unavailable);
  document.querySelector("#shortcutSetupReadyState")?.classList.toggle("hidden", !quickAccessConfigured || unavailable || prepared);
  document.querySelector("#shortcutSetupPreparedState")?.classList.toggle("hidden", !prepared || unavailable);
  document.querySelector("#shortcutSetupPrimaryButton")?.classList.toggle("hidden", quickAccessConfigured || unavailable || prepared);
  document.querySelector("#reconfigureQuickAccessButton")?.classList.toggle("hidden", !quickAccessConfigured || unavailable || prepared);
  document.querySelector("#copyShortcutKeyButton")?.classList.toggle("hidden", quickAccessClipboardFailed);
  document.querySelector("#shortcutKeyCopyFailedState")?.classList.toggle("hidden", !quickAccessClipboardFailed);
  document.querySelector("#showShortcutKeyButton")?.classList.toggle("hidden", !quickAccessClipboardFailed || quickAccessKeyRevealed);
  document.querySelector("#shortcutKeyManualFallback")?.classList.toggle("hidden", !quickAccessKeyRevealed);
  const error = document.querySelector("#shortcutSetupErrorState");
  if (error) {
    error.textContent = quickAccessSetupError ? t("quickAccess.setupFailed") : "";
    error.classList.toggle("hidden", !quickAccessSetupError);
  }
}

async function reconfigureQuickAccessToken() {
  if (quickAccessTokenBusy) {
    quickAccessSetupError = true;
    renderShortcutSetupState();
    return;
  }
  if (!window.confirm(t("quickAccess.reconfigureConfirm"))) return;
  await createQuickAccessToken();
}

async function loadQuickAccessConfig() {
  if (!telegramUserId) return;
  try {
    const data = await api(`/api/quick-access?telegramUserId=${encodeURIComponent(telegramUserId)}`);
    quickAccessShortcutUrl = data.iosShortcutUrl || null;
    quickAccessConfigured = Boolean(data.shortcutConfigured);
    quickAccessSetupError = false;
  } catch {
    quickAccessShortcutUrl = null;
    quickAccessSetupError = true;
  } finally {
    renderShortcutSetupState();
  }
}

document.querySelector("#reserveForm")?.addEventListener("submit", saveReserve);
document.querySelector("#disableReserveButton")?.addEventListener("click", disableReserve);
document.querySelector("#reserveSummaryButton")?.addEventListener("click", () => {
  reserveSettingsExpanded = !reserveSettingsExpanded;
  renderReserveSettings();
});
document.querySelector("#reserveRecurringInput")?.addEventListener("change", renderReserveSettings);
document.querySelector("#saveCurrentMonthBudgetButton")?.addEventListener("click", saveCurrentMonthBudget);
document.querySelector("#historySearchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  loadHistory();
});
document.querySelector("#historySearch")?.addEventListener("input", updateHistorySearchClear);
document.querySelector("#historySearchClear")?.addEventListener("click", () => {
  const search = document.querySelector("#historySearch");
  search.value = "";
  updateHistorySearchClear();
  search.focus();
  loadHistory().catch(showError);
});
document.querySelector("#togglePlannedForm").addEventListener("click", () => {
  const form = document.querySelector("#plannedForm");
  form.classList.toggle("hidden");
  if (!form.classList.contains("hidden")) form.scrollIntoView({ behavior: "smooth", block: "start" });
});
document.querySelector("#plannedArchiveToggle")?.addEventListener("click", async () => {
  if (plannedArchiveState.expanded) {
    collapsePlannedArchive(plannedArchiveState);
    renderPlannedArchive();
    return;
  }
  plannedArchiveState.expanded = true;
  try {
    await refreshPlannedArchive();
  } catch {
    // The archive owns its retryable error state and must not block the active plan list.
  }
});
document.querySelectorAll("[data-tab]").forEach((button) => {
  button.addEventListener("click", () => switchTab(button.dataset.tab));
});
document.querySelector("#settingsForm")?.addEventListener("submit", (event) => event.preventDefault());
for (const selector of ["#baseCurrencyInput", "#displayCurrencyInput", "#displayCurrencyFollowsBaseInput", "#dailyReminderInput", "#timezoneInput"]) {
  document.querySelector(selector)?.addEventListener("change", scheduleSettingsAutosave);
}
document.querySelector("#displayCurrencyFollowsBaseInput")?.addEventListener("change", applyDisplayCurrencyFollowsBase);
for (const [searchSelector, selectSelector] of [["#baseCurrencySearch", "#baseCurrencyInput"], ["#displayCurrencySearch", "#displayCurrencyInput"]]) {
  document.querySelector(searchSelector)?.addEventListener("input", (event) => {
    const select = document.querySelector(selectSelector);
    const selected = select?.value;
    if (!select || !selected) return;
    select.innerHTML = currencyOptions(selected, option, event.target.value);
    select.value = selected;
  });
}
document.querySelector("#interfaceLanguageInput").addEventListener("change", (event) => {
  applyLanguage(event.target.value);
  scheduleSettingsAutosave();
});
document.querySelector("#interfaceThemeInput").addEventListener("change", (event) => {
  applyTheme(event.target.value);
  scheduleSettingsAutosave();
});
document.querySelector("#budgetInput")?.addEventListener("change", saveMonthlyBudget);
document.querySelector("#budgetInput")?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  event.currentTarget.blur();
});
document.querySelector("#detectTimezoneButton")?.addEventListener("click", detectTimezone);
document.querySelector("#timezonePickerButton")?.addEventListener("click", () => document.querySelector("#timezonePicker")?.classList.toggle("hidden"));
document.querySelector("#timezoneSearch")?.addEventListener("input", () => renderTimezoneOptions(document.querySelector("#timezoneInput")?.value));
document.querySelector("#timezoneOptions")?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-timezone]");
  if (!button) return;
  document.querySelector("#timezoneInput").value = button.dataset.timezone;
  document.querySelector("#timezonePicker").classList.add("hidden");
  renderTimezoneOptions();
  scheduleSettingsAutosave();
});
document.querySelector("#openShortcutSetupButton")?.addEventListener("click", openShortcutSetup);
document.querySelector("#closeShortcutSetupButton")?.addEventListener("click", closeShortcutSetup);
document.querySelector("#shortcutSetupBackdrop")?.addEventListener("click", closeShortcutSetup);
document.querySelector("#shortcutSetupPrimaryButton")?.addEventListener("click", createQuickAccessToken);
document.querySelector("#reconfigureQuickAccessButton")?.addEventListener("click", reconfigureQuickAccessToken);
document.querySelector("#copyShortcutKeyButton")?.addEventListener("click", copyShortcutKeyAndOpen);
document.querySelector("#showShortcutKeyButton")?.addEventListener("click", revealShortcutKey);
document.querySelector("#openShortcutAfterManualCopyButton")?.addEventListener("click", openShortcutAfterManualCopy);
document.querySelector("#installShortcutLink")?.addEventListener("click", () => {
  if (quickAccessShortcutUrl) openSharedShortcut(quickAccessShortcutUrl);
});
for (const selector of ["#retryShortcutSetupButton", "#retryShortcutSetupConfigButton"]) {
  document.querySelector(selector)?.addEventListener("click", () => void loadQuickAccessConfig());
}
initializeTelegramQuickAccess();
installTabSwipeNavigation();
void loadQuickAccessConfig().catch(() => {});
document.querySelector("#openAllHistoryButton")?.addEventListener("click", () => switchTab("history"));
document.querySelector("#saveSafeDraftsButton")?.addEventListener("click", () => void saveSafeRecoveryDrafts().catch(showError));
document.querySelector("#reviewRecoveryDraftsButton")?.addEventListener("click", () => switchTab("history"));
document.querySelector("#acceptReviewDraftsButton")?.addEventListener("click", () => void acceptReviewDraftsAsIs());
document.querySelector("#reviewDraftsOneByOneButton")?.addEventListener("click", startHistoryReviewQueue);
document.querySelectorAll("[data-export-period]").forEach((button) => {
  button.addEventListener("click", () => requestExpenseExport(button.dataset.exportPeriod));
});
deleteAccountStartButton?.addEventListener("click", requestAccountDeletion);
deleteAccountAdvanceButton?.addEventListener("click", advanceAccountDeletion);
deleteAccountCancelButton?.addEventListener("click", cancelAccountDeletion);
deleteAccountConfirmInput?.addEventListener("input", () => {
  deleteAccountConfirmButton.disabled = deleteAccountConfirmInput.value !== "DELETE";
});
deleteAccountConfirmButton?.addEventListener("click", confirmAccountDeletion);
deleteAccountSection?.addEventListener("toggle", () => {
  if (!deleteAccountSection.open) setDeleteAccountStage("start");
});
document.querySelectorAll("[data-history-period]").forEach((chip) => {
  chip.addEventListener("click", () => selectHistoryPeriod(chip.dataset.historyPeriod));
});
document.querySelector("#openHistoryDatePicker")?.addEventListener("click", openHistoryDatePicker);
document.querySelector("#closeHistoryDatePicker")?.addEventListener("click", closeHistoryDatePicker);
document.querySelector("#historyDateBackdrop")?.addEventListener("click", closeHistoryDatePicker);
document.querySelector("#historyCalendarPrevious")?.addEventListener("click", () => moveHistoryCalendar(-1));
document.querySelector("#historyCalendarNext")?.addEventListener("click", () => moveHistoryCalendar(1));
document.querySelector("#historyCalendarGrid")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-calendar-date]");
  if (!button || button.disabled) return;
  historyCalendarDraft = {
    ...historyCalendarDraft,
    ...selectRangeDate(historyCalendarDraft, button.dataset.calendarDate)
  };
  renderHistoryCalendar();
});
document.querySelector("#applyHistoryPeriodButton")?.addEventListener("click", applyHistoryCustomRange);
document.querySelector("#resetHistoryPeriodButton")?.addEventListener("click", resetHistoryPeriod);
document.querySelector("#closeEditModalButton")?.addEventListener("click", closeEditModal);
document.querySelector("#editModalBackdrop")?.addEventListener("click", closeEditModal);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDashboardTooltips();
  if (event.key === "Escape" && editModal.isOpen()) closeEditModal();
  if (event.key === "Escape" && !document.querySelector("#historyDateSheet")?.classList.contains("hidden")) {
    closeHistoryDatePicker();
  }
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(FLIP_SELECTOR)) closeDashboardTooltips();
  const popover = document.querySelector("#plannedDuePopover");
  if (!popover || popover.classList.contains("hidden")) return;
  if (popover.contains(event.target) || event.target.closest("[data-planned-menu]")) return;
  popover.classList.add("hidden");
});

applyLanguage(currentLanguage);
load().catch(showError);

async function load() {
  if (!telegramUserId) throw new Error("No Telegram user id. Open Mini App from the bot.");
  renderPlannedForm();
  const dashboard = await loadDashboard();
  if (isOnboardingDashboardResponse(dashboard)) {
    window.__moneyFlowCompleteStartup?.();
    return;
  }
  markStartup("dashboard_usable");
  window.__moneyFlowCompleteStartup?.();
  const startupTimings = finishStartup();
  void reportStartupTimings(startupTimings);
  if (params.get("view") === "history") {
    await ensureHistoryLoaded();
    switchTab("history");
  } else {
    requestAnimationFrame(() => {
      void loadDashboardInbox().catch(() => {
        // Dashboard remains usable; History will retry the inbox request when opened.
      });
    });
  }
  if (params.get("view") === "settings") switchTab("settings");
  if (draftId) await openDraftInline(draftId, {
    returnTab: "dashboard",
    row: document.querySelector(`[data-inbox-location="dashboard"][data-draft-row="${draftId}"]`)
      ?? document.querySelector(`[data-draft-row="${draftId}"]`)
  });
}

function reportStartupTimings(timings) {
  return api("/api/startup-timing", {
    method: "POST",
    body: { timings }
  }).catch(() => {
    // Diagnostics are best-effort and never delay or fail Dashboard startup.
  });
}

async function loadDashboard() {
  if (accountDeleted) return;
  markStartup("dashboard_request_start");
  const data = await api(buildDashboardRequestPath(telegramUserId, window.location.search));
  markStartup("dashboard_response_received");
  if (accountDeleted) return;
  if (isOnboardingDashboardResponse(data)) {
    renderOnboardingState(data.user);
    return data;
  }
  document.querySelector("#openQuickEntryButton")?.classList.remove("hidden");
  dashboardState = data;
  setBaseCurrency(data.user?.base_currency ?? data.snapshot?.baseCurrency ?? "THB");
  if (!preserveSettingsControlsDuringRefresh) renderSettings(data.user);
  renderPlannedForm();
  renderSnapshot(data.snapshot);
  renderPlannedNotice(data.plannedExpenses ?? []);
  renderAnalytics(data.snapshot, data.analytics ?? {});
  renderTopCategories(data.topCategories ?? [], data.snapshot.month);
  renderPlannedMonthSummary(data.plannedExpenses ?? []);
  renderPlannedExpenses(data.plannedExpenses ?? []);
  renderLatest(data.latestExpenses ?? []);
  await renderClosedReserveEvents(data.closedReserveEvents ?? []);
  if (data.recurringReserveBlocked) showToast(t("reserve.blocked"));
  markStartup("dashboard_rendered");
  return data;
}

function renderOnboardingState(user) {
  applyLanguage(user?.interface_language ?? "en");
  document.querySelector("#onboardingState")?.classList.remove("hidden");
  for (const id of ["dashboardTab", "historyTab", "planTab", "settingsTab"]) {
    document.getElementById(id)?.classList.add("hidden");
  }
  document.querySelector(".bottom-tabs")?.classList.add("hidden");
  document.querySelector("#openQuickEntryButton")?.classList.add("hidden");
  document.querySelector("#onboardingOpenBotButton")?.addEventListener("click", () => {
    window.Telegram?.WebApp?.close();
  }, { once: true });
}

function renderAnalytics(snapshot, analytics) {
  renderMonthlyForecast(snapshot, analytics);
  renderOtherWarning(analytics.otherCategoryWarning);
  renderLargestExpenses(analytics);
  renderTopTags(analytics.topTags ?? []);
  renderHeatmap(analytics.dailyHeatmap ?? [], snapshot.daysInMonth ?? 30);
}

function renderOtherWarning(warning) {
  const notice = document.querySelector("#otherWarning");
  const badge = document.querySelector("#otherWarningBadge");
  if (!warning?.active) {
    notice.classList.add("hidden");
    notice.innerHTML = "";
    badge?.classList.add("hidden");
    return;
  }
  notice.classList.remove("hidden");
  badge?.classList.remove("hidden");
  notice.innerHTML = `
    <div class="notice-title">
      <span>${currentLanguage === "ru" ? `Категория “Другое” уже ${warning.percent}% месяца` : `Other is already ${warning.percent}% of the month`}</span>
      <strong>${moneyBase(warning.total)}</strong>
    </div>
    <div class="expense-meta">${currentLanguage === "ru" ? "Стоит разобрать эти траты, чтобы статистика была полезнее." : "Review these expenses to make the stats more useful."}</div>
  `;
}

function renderLargestExpenses(analytics) {
  const list = document.querySelector("#largestExpenses");
  const items = [
    analytics.largestWeek ? [t("dashboard.week"), analytics.largestWeek] : null,
    analytics.largestMonth ? [t("dashboard.month"), analytics.largestMonth] : null
  ].filter(Boolean);
  if (!items.length) {
    list.innerHTML = `<div class="empty">${t("dashboard.largestEmpty")}</div>`;
    return;
  }
  list.innerHTML = items.map(([label, expense]) => `
    <article class="expense-row" style="--category-color: ${categoryColor(expense.category_slug)}">
      <div class="expense-main">
        <div class="expense-title">${escapeHtml(label)} · ${escapeHtml(expense.description)}</div>
        <div class="expense-meta">${formatDate(expense.spent_at, currentLanguage, userTimeZone())} · ${escapeHtml(categoryLabel(expense.category_slug, currentLanguage))}</div>
      </div>
      <div class="expense-amount">${moneyBase(expense.amount_base)}
        <em>${moneyDisplay(expense.display?.amount, expense.display?.currency)}</em>
      </div>
    </article>
  `).join("");
}

function renderTopTags(items) {
  const list = document.querySelector("#topTags");
  if (!items.length) {
    list.innerHTML = `<div class="empty">${t("dashboard.tagsEmpty")}</div>`;
    return;
  }
  list.innerHTML = items.map((item) => `
    <div class="tag-chip">
      <span>#${escapeHtml(item.tag)}</span>
      <strong>${moneyBase(item.total)}</strong>
      <em>${moneyDisplay(item.display?.amount, item.display?.currency)}</em>
    </div>
  `).join("");
}

function renderHeatmap(items, daysInMonth) {
  const grid = document.querySelector("#dailyHeatmap");
  const byDay = new Map(items.map((item) => [Number(item.day), Number(item.total)]));
  const max = Math.max(...items.map((item) => Number(item.total)), 1);
  grid.innerHTML = Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    const total = byDay.get(day) ?? 0;
    const intensity = Math.min(total / max, 1);
    return `<div class="heatmap-day" style="--heat: ${intensity}" title="${day}: ${moneyBase(total)}">${day}</div>`;
  }).join("");
}

function renderMonthlyForecast(snapshot, analytics) {
  const forecast = Number(snapshot.forecastMonthTotal ?? 0);
  const monthlyBudget = Number(snapshot.monthlyBudget ?? 0);
  const spentSoFar = Number(snapshot.month ?? 0);
  const daysInMonth = Number(snapshot.daysInMonth ?? 0) || 0;
  const averageDailySpending = Number(
    snapshot.averageDailyRegularSpending ?? (daysInMonth > 0 ? forecast / daysInMonth : 0)
  );
  const difference = forecast - monthlyBudget;
  const displayCurrency = snapshot.display?.currency;
  const showDisplay = Boolean(displayCurrency) && displayCurrency !== snapshot.baseCurrency;
  const displayText = (value) => (showDisplay ? moneyDisplay(value, displayCurrency) : "");
  const displayForecast = Number(snapshot.display?.forecastMonthTotal ?? 0);
  const displayBudget = Number(snapshot.display?.monthlyBudget ?? 0);
  const displayAverageDaily = Number(
    snapshot.display?.averageDailyRegularSpending ?? (daysInMonth > 0 ? displayForecast / daysInMonth : 0)
  );
  const perDay = t("monthlyForecast.perDay");
  const hasBudget = Number.isFinite(monthlyBudget) && monthlyBudget > 0;
  const isOverBudget = shouldShowForecastDifference(forecast, monthlyBudget);
  const forecastSection = document.querySelector("#monthlyForecast");

  setText("#forecastSummaryTotal", t("monthlyForecast.summaryTotal", { amount: moneyBase(forecast) }));
  setText("#forecastSummaryStatus", hasBudget
    ? (isOverBudget
      ? t("monthlyForecast.summaryAboveBudget", { amount: moneyBase(Math.abs(difference)) })
      : t("monthlyForecast.summaryWithinBudget", { amount: moneyBase(Math.abs(difference)) }))
    : t("monthlyForecast.withinBudget"));
  if (forecastSection) forecastSection.dataset.state = isOverBudget ? "danger" : "good";
  setText("#forecastAmount", moneyBase(forecast));
  setText("#forecastAmountDisplay", displayText(displayForecast));
  setText("#forecastExplanation", t("monthlyForecast.explanation", { spentSoFar: moneyBase(spentSoFar) }));

  setText("#forecastBudget", moneyBase(monthlyBudget));
  setText("#forecastBudgetDisplay", displayText(displayBudget));

  const diffRow = document.querySelector("#forecastDiffRow");
  diffRow.classList.remove("good", "bad", "neutral");
  if (isOverBudget) {
    diffRow.classList.add("bad");
    setText("#forecastDiff", t("monthlyForecast.aboveBudget", { amount: moneyBase(Math.abs(difference)) }));
  } else {
    diffRow.classList.add("good");
    setText("#forecastDiff", t("monthlyForecast.withinBudgetWithLeft", { amount: moneyBase(Math.abs(difference)) }));
  }
  setText("#forecastDiffDisplay", displayText(Math.abs(displayForecast - displayBudget)));

  setText("#forecastAvgPace", `${moneyBase(averageDailySpending)}${perDay}`);
  setText("#forecastAvgPaceDisplay", showDisplay ? `${moneyDisplay(displayAverageDaily, displayCurrency)}${perDay}` : "");

  const weekComparison = analytics?.weekComparison ?? {};
  const weekDelta = Number(weekComparison.delta ?? NaN);
  const weekRow = document.querySelector("#forecastWeekRow");
  weekRow.classList.remove("good", "bad", "neutral");
  if (Number.isFinite(weekDelta)) {
    if (weekDelta > 0) weekRow.classList.add("bad");
    else if (weekDelta < 0) weekRow.classList.add("good");
    else weekRow.classList.add("neutral");
    setText("#forecastWeek", `${weekDelta > 0 ? "+" : ""}${moneyBase(weekDelta)}`);
    setText("#forecastWeekDisplay", showDisplay ? moneyDisplaySigned(weekComparison.display?.delta, weekComparison.display?.currency) : "");
  } else {
    weekRow.classList.add("neutral");
    setText("#forecastWeek", t("monthlyForecast.noData"));
    setText("#forecastWeekDisplay", "");
  }

  document.querySelector("#forecastBudgetRow").classList.toggle("hidden", !hasBudget);
  document.querySelector("#forecastDiffRow").classList.toggle("hidden", !isOverBudget);
}

function ensureHistoryLoaded() {
  return historyLoader.ensure();
}

function loadHistory() {
  return historyLoader.refresh();
}

async function loadDashboardInbox() {
  if (accountDeleted) return;
  const inbox = await api(`/api/drafts/recovery-preview?telegramUserId=${encodeURIComponent(telegramUserId)}`);
  if (accountDeleted) return;
  recoveryState = inbox;
  inboxState = inbox.drafts ?? [];
  renderDashboardInboxDrafts(recoveryState);
}

async function saveSafeRecoveryDrafts() {
  const button = document.querySelector("#saveSafeDraftsButton");
  const draftIds = [...(recoveryState.safeDraftIds ?? [])];
  if (!draftIds.length || button?.disabled) return;
  button.disabled = true;
  try {
    const result = await api("/api/drafts/recovery-save", {
      method: "POST",
      body: { telegramUserId, draftIds: recoveryState.safeDraftIds }
    });
    const savedCount = (result.results ?? []).filter((item) => ["saved", "already_saved"].includes(item.state)).length;
    await loadDashboard();
    await loadDashboardInbox();
    if (historyLoader.hasStarted()) await loadHistory();
    showToast(currentLanguage === "ru" ? `Сохранено: ${savedCount}` : `Saved: ${savedCount}`);
  } finally {
    button.disabled = false;
  }
}

async function acceptReviewDraftsAsIs() {
  const button = document.querySelector("#acceptReviewDraftsButton");
  const draftIds = [...(recoveryState.acceptDraftIds ?? [])];
  const itemCount = Number(recoveryState.acceptItemCount ?? 0);
  if (!draftIds.length || button?.disabled) return;
  if (!window.confirm(reviewAcceptanceConfirmMessage(itemCount, currentLanguage))) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const result = await api("/api/drafts/recovery-accept", {
      method: "POST",
      body: { telegramUserId, draftIds }
    });
    const savedItems = (result.results ?? [])
      .filter((item) => ["saved", "already_saved"].includes(item.state))
      .reduce((sum, item) => sum + (item.expenses?.length ?? 0), 0);
    const unresolved = (result.results ?? []).filter((item) => ["review", "error"].includes(item.state)).length;
    await loadDashboard();
    await loadHistory();
    const message = currentLanguage === "ru"
      ? `Сохранено ${savedItems}${unresolved ? ` · ${unresolved} требует исправления` : ""}`
      : `Saved ${savedItems}${unresolved ? ` · ${unresolved} need changes` : ""}`;
    showToast(message);
  } catch (error) {
    console.error("[miniapp] review batch acceptance failed", error);
    showToast(reviewAcceptanceErrorMessage(error, currentLanguage));
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

function startHistoryReviewQueue() {
  const requiresInput = recoveryState.requiresInputDraftIds ?? [];
  historyReviewQueueIds = [...(requiresInput.length ? requiresInput : (recoveryState.drafts ?? []).map((draft) => draft.id))].map(String);
  historyReviewQueueTotal = historyReviewQueueIds.length;
  renderInboxDrafts(recoveryState);
}

async function performHistoryLoad() {
  if (accountDeleted) return;
  markStartup("history_request_start");
  const search = document.querySelector("#historySearch").value.trim();
  const params = buildHistoryRequestParams(telegramUserId, search, historyFilterState);
  const [data, inbox] = await Promise.all([
    api(`/api/expenses?${params.toString()}`),
    api(`/api/drafts/recovery-preview?telegramUserId=${encodeURIComponent(telegramUserId)}`)
  ]);
  if (accountDeleted) return;
  historyState = data.expenses ?? [];
  recoveryState = inbox;
  inboxState = inbox.drafts ?? [];
  renderDashboardInboxDrafts(recoveryState);
  renderInboxDrafts(recoveryState);
  renderHistory(historyState);
  renderHistoryPeriodSummary(historyState);
  renderHistoryAnalytics(historyState);
  updateHistorySearchClear();
  markStartup("history_request_finish");
}

function selectHistoryPeriod(period) {
  historyFilterState = { period, monthKey: "", fromDate: "", toDate: "" };
  updateHistoryFilterChips();
  loadHistory().catch(showError);
}

function applyHistoryCustomRange() {
  const fromDate = historyCalendarDraft?.startDate;
  const toDate = historyCalendarDraft?.endDate;
  if (!fromDate || !toDate) {
    return;
  }
  historyFilterState = { period: "custom", monthKey: "", fromDate, toDate };
  closeHistoryDatePicker();
  updateHistoryFilterChips();
  loadHistory().catch(showError);
}

function resetHistoryPeriod() {
  historyFilterState = { period: "month", monthKey: "", fromDate: "", toDate: "" };
  closeHistoryDatePicker();
  updateHistoryFilterChips();
  loadHistory().catch(showError);
}

function updateHistoryFilterChips() {
  document.querySelectorAll("[data-history-period]").forEach((chip) => {
    const active = chip.dataset.historyPeriod === historyFilterState.period;
    chip.classList.toggle("active", active);
    chip.setAttribute("aria-pressed", String(active));
  });
  const dateButton = document.querySelector("#openHistoryDatePicker");
  const customActive = historyFilterState.period === "custom";
  dateButton?.classList.toggle("active", customActive);
  dateButton?.setAttribute("aria-pressed", String(customActive));
  if (dateButton) {
    dateButton.textContent = customActive
      ? formatCustomRangeLabel(historyFilterState.fromDate, historyFilterState.toDate, currentLanguage)
      : t("history.customPeriod");
  }
  updateHistoryFilterCurrent();
}

function openHistoryDatePicker() {
  historyCalendarDraft = createCalendarDraft(historyFilterState, localTodayYmd());
  document.querySelector("#historyDateBackdrop")?.classList.remove("hidden");
  document.querySelector("#historyDateSheet")?.classList.remove("hidden");
  document.body.classList.add("history-date-sheet-open");
  renderHistoryCalendar();
  document.querySelector("#closeHistoryDatePicker")?.focus();
}

function closeHistoryDatePicker() {
  document.querySelector("#historyDateBackdrop")?.classList.add("hidden");
  document.querySelector("#historyDateSheet")?.classList.add("hidden");
  document.body.classList.remove("history-date-sheet-open");
  historyCalendarDraft = null;
  document.querySelector("#openHistoryDatePicker")?.focus();
}

function moveHistoryCalendar(delta) {
  if (!historyCalendarDraft) return;
  const nextMonth = shiftCalendarMonth(historyCalendarDraft.visibleMonth, delta);
  if (!canNavigateToMonth(nextMonth, localTodayYmd())) return;
  historyCalendarDraft.visibleMonth = nextMonth;
  renderHistoryCalendar();
}

function renderHistoryCalendar() {
  if (!historyCalendarDraft) return;
  const today = localTodayYmd();
  const cells = buildCalendarMonth(historyCalendarDraft.visibleMonth, today, historyCalendarDraft);
  const monthDate = new Date(
    Number(historyCalendarDraft.visibleMonth.slice(0, 4)),
    Number(historyCalendarDraft.visibleMonth.slice(5, 7)) - 1,
    1
  );
  setText("#historyCalendarMonth", new Intl.DateTimeFormat(
    currentLanguage === "ru" ? "ru-RU" : "en-US",
    { month: "long", year: "numeric" }
  ).format(monthDate));

  const grid = document.querySelector("#historyCalendarGrid");
  grid.innerHTML = cells.map((cell, index) => {
    const classes = [
      "history-calendar__day",
      cell.isStart ? "is-start" : "",
      cell.isEnd ? "is-end" : "",
      cell.isInRange ? "is-in-range" : "",
      cell.date === today ? "is-today" : ""
    ].filter(Boolean).join(" ");
    const label = new Intl.DateTimeFormat(
      currentLanguage === "ru" ? "ru-RU" : "en-US",
      { day: "numeric", month: "long", year: "numeric" }
    ).format(new Date(Number(cell.date.slice(0, 4)), Number(cell.date.slice(5, 7)) - 1, cell.day));
    const offset = index === 0 ? ` style="grid-column-start:${cell.weekdayIndex + 1}"` : "";
    return `<button type="button" class="${classes}" data-calendar-date="${cell.date}" aria-label="${escapeAttribute(label)}"${offset}${cell.disabled ? " disabled" : ""}>${cell.day}</button>`;
  }).join("");

  const selection = historyCalendarDraft.startDate
    ? formatCustomRangeLabel(historyCalendarDraft.startDate, historyCalendarDraft.endDate, currentLanguage)
    : t("history.selectedPeriod");
  setText("#historyDateSelection", selection);
  const applyButton = document.querySelector("#applyHistoryPeriodButton");
  if (applyButton) applyButton.disabled = !historyCalendarDraft.startDate;
  const nextMonth = shiftCalendarMonth(historyCalendarDraft.visibleMonth, 1);
  const nextButton = document.querySelector("#historyCalendarNext");
  if (nextButton) nextButton.disabled = !canNavigateToMonth(nextMonth, today);

  const weekdayLabels = currentLanguage === "ru"
    ? ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
    : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  document.querySelectorAll(".history-calendar__weekdays span").forEach((element, index) => {
    element.textContent = weekdayLabels[index];
  });
}

function localTodayYmd() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function updateHistoryFilterCurrent() {
  const current = document.querySelector("#historyFilterCurrent");
  if (!current) return;
  current.textContent = historyPeriodLabel();
}

function historyPeriodLabel() {
  const period = historyFilterState.period;
  if (period === "custom" && historyFilterState.fromDate && historyFilterState.toDate) {
    return formatCustomRangeLabel(historyFilterState.fromDate, historyFilterState.toDate, currentLanguage);
  }
  const key = {
    today: "history.today",
    yesterday: "history.yesterday",
    last7: "history.last7",
    previous_month: "history.previousMonth",
    month: "history.thisMonth"
  }[period] ?? "history.thisMonth";
  return t(key);
}

function historyPeriodTitle() {
  const period = historyFilterState.period;
  if (period === "custom" && historyFilterState.fromDate && historyFilterState.toDate) {
    return t("history.total.custom", {
      range: formatCustomRangeLabel(historyFilterState.fromDate, historyFilterState.toDate, currentLanguage)
    });
  }
  const key = {
    today: "history.total.today",
    yesterday: "history.total.yesterday",
    last7: "history.total.last7",
    previous_month: "history.total.previousMonth",
    month: "history.total.month"
  }[period] ?? "history.total.month";
  return t(key);
}

function renderHistoryPeriodSummary(expenses) {
  const summary = document.querySelector("#historyPeriodSummary");
  if (!summary) return;
  const total = periodTotal(expenses);
  const count = expenses.length;
  const title = historySummaryKey(document.querySelector("#historySearch")?.value)
    ? t("history.total.filtered")
    : historyPeriodTitle();
  summary.innerHTML = `
    <div class="history-summary-card">
      <span class="history-summary-label">${escapeHtml(title)}</span>
      <strong class="history-summary-amount">${escapeHtml(moneyBase(total))}</strong>
      <small class="history-summary-meta">${escapeHtml(expenseCountLabel(count, currentLanguage))}</small>
    </div>
  `;
}

function updateHistorySearchClear() {
  const hasSearch = Boolean(document.querySelector("#historySearch")?.value);
  document.querySelector("#historySearchClear")?.classList.toggle("hidden", !hasSearch);
}

function renderHistoryAnalytics(expenses) {
  const analytics = buildHistoryAnalytics(expenses);
  const disclosure = document.querySelector("#historyAnalytics");
  disclosure?.classList.toggle("hidden", analytics.count === 0);
  if (!analytics.count) return;

  const leading = analytics.categories[0];
  setText("#historyAnalyticsPreview", leading
    ? t("history.analyticsPreview", {
      category: categoryLabel(leading.category_slug, currentLanguage),
      share: Math.round(leading.share)
    })
    : "");
  setText("#historyDonutTotal", moneyBase(analytics.total));
  setText("#historyDonutCount", expenseCountLabel(analytics.count, currentLanguage));

  let cursor = 0;
  const segments = analytics.categories.map((item, index) => {
    const start = cursor;
    cursor = index === analytics.categories.length - 1 ? 100 : cursor + item.share;
    return `${categoryColor(item.category_slug)} ${start}% ${cursor}%`;
  });
  const donut = document.querySelector("#historyCategoryDonut");
  if (donut) donut.style.background = `conic-gradient(${segments.join(", ")})`;

  const ranking = document.querySelector("#historyCategoryRanking");
  ranking.innerHTML = analytics.categories.map((item) => `
    <div class="history-category-rank" style="--category-color:${categoryColor(item.category_slug)}">
      <span>${escapeHtml(categoryLabel(item.category_slug, currentLanguage))}</span>
      <strong>${escapeHtml(moneyBase(item.amount))} · ${item.share.toFixed(1)}%</strong>
    </div>
  `).join("");

  const top = document.querySelector("#historyTopExpenses");
  top.innerHTML = analytics.topExpenses.map((expense) => historyAnalyticsExpenseRow(expense)).join("");
}

function historyAnalyticsExpenseRow(expense) {
  return `<div class="history-analytics-expense" style="--category-color:${categoryColor(expense.category_slug)}">
    <span class="dashboard-expense-icon" aria-hidden="true">${categoryIconSvg(expense.category_slug)}</span>
    <span><strong>${escapeHtml(expense.description)}</strong><small>${escapeHtml(categoryLabel(expense.category_slug, currentLanguage))}</small></span>
    <b>${escapeHtml(moneyBase(expense.amount_base ?? 0))}</b>
  </div>`;
}

async function loadDraft(id, options = {}) {
  const data = await api(`/api/drafts/${id}?telegramUserId=${encodeURIComponent(telegramUserId)}`);
  draftState = data.draft;
  draftReturnTab = options.returnTab ?? "dashboard";
  renderDraftEditor(draftState);
}

function switchTab(tab, { fromPager = false } = {}) {
  if (accountDeleted) return;
  if (!fromPager) cancelTabPager();
  if (tab === "settings") {
    if (deleteAccountSection) deleteAccountSection.open = false;
    setDeleteAccountStage("start");
  }
  document.querySelector("#dashboardTab").classList.toggle("hidden", tab !== "dashboard");
  document.querySelector("#planTab").classList.toggle("hidden", tab !== "plan");
  document.querySelector("#historyTab").classList.toggle("hidden", tab !== "history");
  document.querySelector("#settingsTab").classList.toggle("hidden", tab !== "settings");
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  if (tab === "history") void ensureHistoryLoaded().catch(showError);
}

function isTabSwipeBlocked() {
  const bottomTabs = document.querySelector(".bottom-tabs");
  if (accountDeleted || !bottomTabs || bottomTabs.classList.contains("hidden")) return true;
  return [...document.querySelectorAll('[role="dialog"], #draftEditorSection, #plannedForm')]
    .some((element) => !element.classList.contains("hidden"));
}

function installTabSwipeNavigation() {
  const pager = document.querySelector("#tabPager");
  let gesture = null;
  let renderedNeighborIndex = null;
  let animationTimer = null;

  function page(index) {
    return document.querySelector(`#${TAB_ORDER[index]}Tab`);
  }

  function currentIndex() {
    return TAB_ORDER.findIndex((tab) => !document.querySelector(`#${tab}Tab`)?.classList.contains("hidden"));
  }

  function clearPager(activeIndex) {
    clearTimeout(animationTimer);
    animationTimer = null;
    gesture = null;
    renderedNeighborIndex = null;
    pager?.classList.remove("is-dragging", "is-animating");
    document.body.classList.remove("is-paging");
    TAB_ORDER.forEach((_, index) => {
      const tabPage = page(index);
      tabPage?.classList.remove("is-pager-current", "is-pager-neighbor");
      tabPage?.style.removeProperty("transform");
      tabPage?.removeAttribute("aria-hidden");
      if (activeIndex >= 0) tabPage?.classList.toggle("hidden", index !== activeIndex);
    });
  }

  cancelTabPager = () => {
    const activeTab = document.querySelector("[data-tab].active")?.dataset.tab;
    clearPager(TAB_ORDER.indexOf(activeTab));
  };

  function renderGesture(nextGesture) {
    const activePage = page(nextGesture.currentIndex);
    if (!activePage) return;
    pager?.classList.add("is-dragging");
    document.body.classList.add("is-paging");
    activePage.classList.add("is-pager-current");
    activePage.style.transform = `translate3d(${nextGesture.visualDeltaX}px, 0, 0)`;

    if (renderedNeighborIndex != null && renderedNeighborIndex !== nextGesture.neighborIndex) {
      const oldNeighbor = page(renderedNeighborIndex);
      oldNeighbor?.classList.add("hidden");
      oldNeighbor?.classList.remove("is-pager-neighbor");
      oldNeighbor?.style.removeProperty("transform");
      oldNeighbor?.removeAttribute("aria-hidden");
    }
    renderedNeighborIndex = nextGesture.neighborIndex;
    if (renderedNeighborIndex == null) return;

    const neighbor = page(renderedNeighborIndex);
    const offset = renderedNeighborIndex > nextGesture.currentIndex ? nextGesture.width : -nextGesture.width;
    neighbor?.classList.remove("hidden");
    neighbor?.classList.add("is-pager-neighbor");
    neighbor?.setAttribute("aria-hidden", "true");
    if (neighbor) neighbor.style.transform = `translate3d(${offset + nextGesture.visualDeltaX}px, 0, 0)`;
  }

  function settleGesture(result) {
    if (!gesture || gesture.phase !== "dragging") {
      clearPager(currentIndex());
      return;
    }
    const activePage = page(gesture.currentIndex);
    const neighbor = gesture.neighborIndex == null ? null : page(gesture.neighborIndex);
    const commits = result.action === "commit";
    const direction = gesture.neighborIndex > gesture.currentIndex ? -1 : 1;
    pager?.classList.remove("is-dragging");
    pager?.classList.add("is-animating");
    if (activePage) activePage.style.transform = `translate3d(${commits ? direction * gesture.width : 0}px, 0, 0)`;
    if (neighbor) {
      const restingOffset = gesture.neighborIndex > gesture.currentIndex ? gesture.width : -gesture.width;
      neighbor.style.transform = `translate3d(${commits ? 0 : restingOffset}px, 0, 0)`;
    }
    const settledIndex = commits ? result.nextIndex : gesture.currentIndex;
    animationTimer = setTimeout(() => {
      clearPager(settledIndex);
      if (!commits) return;
      switchTab(TAB_ORDER[result.nextIndex], { fromPager: true });
      window.Telegram?.WebApp?.HapticFeedback?.selectionChanged?.();
    }, 240);
  }

  document.addEventListener("touchstart", (event) => {
    if (gesture || animationTimer) return;
    const touch = event.touches[0];
    const activeIndex = currentIndex();
    if (!touch || !canStartTabPager({
      blocked: isTabSwipeBlocked(),
      currentIndex: activeIndex,
      interactive: Boolean(event.target.closest("input, textarea, select, button, a, [contenteditable='true']")),
      startX: touch.clientX,
      touchCount: event.touches.length,
      viewportWidth: window.innerWidth
    })) return;
    gesture = createTabPagerGesture({
      currentIndex: activeIndex,
      startX: touch.clientX,
      startY: touch.clientY,
      width: pager?.clientWidth || window.innerWidth
    });
  }, { passive: true });

  document.addEventListener("touchmove", (event) => {
    if (!gesture) return;
    const touch = event.touches[0];
    if (!touch || event.touches.length !== 1 || isTabSwipeBlocked()) {
      clearPager(currentIndex());
      return;
    }
    gesture = moveTabPagerGesture(gesture, { x: touch.clientX, y: touch.clientY });
    if (gesture.phase === "cancelled") {
      clearPager(currentIndex());
      return;
    }
    if (gesture.phase !== "dragging") return;
    event.preventDefault();
    renderGesture(gesture);
  }, { passive: false });

  document.addEventListener("touchend", (event) => {
    if (!gesture) return;
    if (isTabSwipeBlocked()) {
      clearPager(currentIndex());
      return;
    }
    settleGesture(finishTabPagerGesture(gesture));
  }, { passive: true });

  document.addEventListener("touchcancel", () => {
    if (!gesture) return;
    settleGesture({ action: "snapback", currentIndex: gesture.currentIndex });
  }, { passive: true });
}

function renderSnapshot(snapshot) {
  setBaseCurrency(snapshot.baseCurrency ?? dashboardState?.user?.base_currency ?? "THB");
  const heroMetric = buildHeroMetric(snapshot, {
    t,
    moneyBase,
    moneyDisplay
  });
  const hero = document.querySelector(".hero-metric");
  if (hero) hero.dataset.state = heroMetric.state;
  setText("#heroTitle", heroMetric.title);
  setText("#safeToSpend", heroMetric.amount);
  setText("#safeToSpendDisplay", heroMetric.display);
  setText("#heroHint", heroMetric.hint);
  setText("#heroSpentLabel", heroMetric.spentLabel);
  setText("#heroSpentValue", heroMetric.spent);
  setText("#heroMonthLabel", heroMetric.monthLabel);
  setText("#heroMonthValue", heroMetric.monthValue);
  const heroProgress = document.querySelector("#heroProgress");
  if (heroProgress) {
    heroProgress.style.width = `${heroMetric.progress.percent}%`;
    heroProgress.dataset.state = heroMetric.progress.state;
  }
  const heroDetails = document.querySelector("#heroTooltip");
  if (heroDetails) heroDetails.innerHTML = renderHeroDetails(snapshot, dashboardState?.currentMonthBudget, heroMetric);
  const heroToggle = document.querySelector("#heroDetailsToggle");
  heroToggle?.setAttribute("aria-label", t("dashboard.hero.why"));
  heroToggle && (heroToggle.textContent = t("dashboard.hero.why"));
  bindHeroDetails();
  setText("#budgetPlanSummary", t("dashboard.budgetPlanSummary", {
    free: moneyBase(snapshot.freeRemaining ?? 0),
    planned: moneyBase(snapshot.plannedRemaining ?? 0)
  }));
  renderDashboardCards(document.querySelector("#dashboardCards"), buildDashboardCards(snapshot, {
    t,
    moneyBase,
    moneyDisplay,
    percent: (value) => `${percentNumber.format(Number(value ?? 0))}%`
  }));
  renderBudgetTopupBreakdown(document.querySelector("#budgetTopupBreakdown"), dashboardState?.currentMonthBudget, {
    t,
    moneyBase,
    formatDate: (value) => formatDateOnly(value)
  });
  bindDashboardTooltips();
}

function renderHeroDetails(snapshot, currentMonthBudget, heroMetric) {
  const baseBudget = Number(currentMonthBudget?.baseBudget ?? snapshot.monthlyBudget ?? 0);
  const topups = Number(currentMonthBudget?.topupsTotal ?? 0);
  const monthlyBudget = Number(snapshot.monthlyBudget ?? currentMonthBudget?.amount ?? baseBudget + topups);
  const monthSpent = Number(snapshot.month ?? 0);
  const planned = Number(snapshot.plannedRemaining ?? 0);
  const reserve = Number(snapshot.reserve?.amount ?? 0);
  const freeRemaining = Number(snapshot.freeRemaining ?? 0);
  const today = Number(snapshot.today ?? 0);
  const dayPlan = Number(snapshot.dayPlanLimit ?? 0);
  const rows = [];

  if (topups > 0) {
    rows.push(heroDetailRow("dashboard.hero.baseBudget", moneyBase(baseBudget)));
    rows.push(heroDetailRow("dashboard.hero.topups", `+${moneyBase(topups)}`));
    rows.push(heroDetailRow("dashboard.hero.monthBudget", moneyBase(monthlyBudget), "subtotal"));
  } else {
    rows.push(heroDetailRow("dashboard.hero.monthBudget", moneyBase(monthlyBudget)));
  }
  if (monthSpent > 0) rows.push(heroDetailRow("dashboard.hero.spentSoFar", `−${moneyBase(monthSpent)}`));
  if (planned > 0) rows.push(heroDetailRow("dashboard.hero.planned", `−${moneyBase(planned)}`));
  if (reserve > 0) rows.push(heroDetailRow("dashboard.hero.reserve", `−${moneyBase(reserve)}`));

  if (heroMetric.kind === "monthOverrun") {
    rows.push(heroDetailRow("dashboard.hero.budgetOverrun", heroMetric.amount, "result"));
    if (freeRemaining < 0 && Math.abs(freeRemaining) !== Math.abs(Number(snapshot.monthRemaining ?? 0))) {
      rows.push(heroDetailRow(
        reserve > 0 ? "dashboard.hero.shortAfterPlannedAndReserve" : "dashboard.hero.shortAfterPlanned",
        moneyBase(Math.abs(freeRemaining))
      ));
    }
  } else if (heroMetric.kind === "freeDeficit") {
    rows.push(heroDetailRow(
      reserve > 0 ? "dashboard.hero.shortAfterPlannedAndReserve" : "dashboard.hero.shortAfterPlanned",
      heroMetric.amount,
      "result"
    ));
  } else {
    rows.push(heroDetailRow("dashboard.hero.free", moneyBase(Math.max(freeRemaining, 0)), "subtotal"));
    rows.push(heroDetailRow("dashboard.hero.dayPlan", moneyBase(dayPlan)));
    if (today > 0) rows.push(heroDetailRow("dashboard.hero.spentToday", `−${moneyBase(today)}`));
    rows.push(heroDetailRow(
      heroMetric.kind === "dayOverrun" ? "dashboard.hero.dayOverrun" : "dashboard.hero.safeToday",
      heroMetric.amount,
      "result"
    ));
  }

  const zeroTargetExplanation = dayPlan === 0
    ? `<p class="hero-metric__calculation-note">${escapeHtml(t("dashboard.hero.zeroTargetExplanation", { amount: moneyBase(0) }))}</p>`
    : "";
  return `
    <h3 class="hero-metric__calculation-title">${escapeHtml(t("dashboard.hero.calculationTitle"))}</h3>
    <div class="hero-metric__calculation-rows">${rows.join("")}</div>
    ${zeroTargetExplanation}
  `;
}

function heroDetailRow(labelKey, value, modifier = "") {
  const className = modifier ? ` hero-metric__detail-row--${modifier}` : "";
  return `
    <div class="hero-metric__detail-row${className}">
      <span>${escapeHtml(t(labelKey))}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function bindHeroDetails() {
  const toggle = document.querySelector("#heroDetailsToggle");
  const panel = document.querySelector("#heroTooltip");
  if (!toggle || !panel || toggle.dataset.bound === "true") return;
  toggle.dataset.bound = "true";
  toggle.addEventListener("click", () => {
    const open = panel.hasAttribute("hidden");
    panel.toggleAttribute("hidden", !open);
    toggle.setAttribute("aria-expanded", String(open));
  });
}

function bindDashboardTooltips() {
  document.querySelectorAll(FLIP_SELECTOR).forEach((card) => {
    if (card.dataset.flipBound === "true") return;
    card.dataset.flipBound = "true";
    const button = card.querySelector(FLIP_TOGGLE_SELECTOR);
    card.addEventListener("click", (event) => {
      if (event.target.closest(FLIP_TOGGLE_SELECTOR)) return;
      toggleDashboardTooltip(card);
    });
    button?.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleDashboardTooltip(card);
    });
    button?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleDashboardTooltip(card);
    });
  });
}

function toggleDashboardTooltip(card) {
  const isOpen = card.classList.contains("is-flipped");
  closeDashboardTooltips();
  if (isOpen) return;
  setDashboardCardFlipped(card, true);
}

function closeDashboardTooltips() {
  document.querySelectorAll(`${FLIP_SELECTOR}.is-flipped`).forEach((card) => {
    setDashboardCardFlipped(card, false);
  });
}

function setDashboardCardFlipped(card, isFlipped) {
  card.classList.toggle("is-flipped", isFlipped);
  const button = card.querySelector(FLIP_TOGGLE_SELECTOR);
  const front = card.querySelector("[data-flip-front]");
  const back = card.querySelector("[data-flip-back]");
  button?.setAttribute("aria-expanded", String(isFlipped));
  front?.setAttribute("aria-hidden", String(isFlipped));
  back?.setAttribute("aria-hidden", String(!isFlipped));
  if (isFlipped) back?.focus?.({ preventScroll: true });
}

function renderSettings(user) {
  try {
    renderSettingsControls(user);
  } catch (error) {
    reportSettingsInitializationFailure(error);
    throw error;
  }
}

function renderSettingsControls(user) {
  currentLanguage = user.interface_language ?? "en";
  currentTheme = user.interface_theme ?? "light";
  applyTheme(currentTheme);
  setBaseCurrency(user.base_currency ?? "THB");
  applyLanguage(currentLanguage);
  document.querySelector("#budgetInput").value = Math.round(Number(user.monthly_budget_amount ?? 45000));
  const currentMonthBudgetForm = document.querySelector("#currentMonthBudgetForm");
  const showCurrentMonthBudgetOverride = shouldShowCurrentMonthBudgetOverride(dashboardState?.currentMonthBudget, new Date(), userTimeZone(user));
  currentMonthBudgetForm?.classList.toggle("hidden", !showCurrentMonthBudgetOverride);
  if (showCurrentMonthBudgetOverride) {
    document.querySelector("#currentMonthBudgetInput").value = Math.round(Number(dashboardState.currentMonthBudget.amount));
  }
  const baseCurrencyInput = document.querySelector("#baseCurrencyInput");
  const displayCurrencyInput = document.querySelector("#displayCurrencyInput");
  baseCurrencyInput.innerHTML = currencyOptions(user.base_currency ?? "THB", option, document.querySelector("#baseCurrencySearch")?.value);
  displayCurrencyInput.innerHTML = currencyOptions(user.display_currency ?? "USD", option, document.querySelector("#displayCurrencySearch")?.value);
  baseCurrencyInput.value = user.base_currency ?? "THB";
  displayCurrencyInput.value = user.display_currency ?? "USD";
  document.querySelector("#displayCurrencyFollowsBaseInput").checked = user.display_currency_follows_base === true;
  applyDisplayCurrencyFollowsBase();
  document.querySelector("#interfaceLanguageInput").value = currentLanguage;
  document.querySelector("#interfaceThemeInput").value = currentTheme;
  renderTimezoneOptions(user.timezone);
  document.querySelector("#usdThbRateInput").value = Number(user.usd_thb_rate ?? 32.65);
  document.querySelector("#dailyReminderInput").checked = user.daily_entry_reminder_enabled !== false;
  const reserve = dashboardState?.reserveInstance;
  const template = dashboardState?.reserveTemplate;
  document.querySelector("#reserveAmountInput").value = ["active", "disabled"].includes(reserve?.status)
    ? Math.round(Number(reserve.reserve_amount))
    : "";
  document.querySelector("#reserveTitleInput").value = reserve?.title ?? "";
  document.querySelector("#reserveRecurringInput").checked = template?.is_active === true;
  document.querySelector("#reserveScopeInput").value = template?.is_active === true
    ? "current_and_future"
    : "current";
  renderReserveSettings();
  settingsSaveQueue.reset(settingsStateFromUser(user));
  assertSettingsInitialized({
    document,
    user,
    followBaseLabel: t("settings.displayCurrencyFollowsBase")
  });
}

function reportSettingsInitializationFailure(error) {
  window.__moneyFlowReportStartupError?.("settings_initialization_failed");
  console.error("[miniapp] Settings initialization failed", error?.name ?? "Error");
}

function renderReserveSettings() {
  const reserve = dashboardState?.reserveInstance ?? null;
  const template = dashboardState?.reserveTemplate ?? null;
  const currency = dashboardState?.user?.base_currency ?? dashboardState?.snapshot?.baseCurrency ?? "THB";
  const view = buildReserveSettingsView({
    reserve,
    reserveSummary: dashboardState?.snapshot?.reserve ?? null,
    template: {
      ...template,
      is_active: document.querySelector("#reserveRecurringInput")?.checked === true
    },
    currency,
    displayAmount: dashboardState?.snapshot?.display?.reserveAmount,
    displayCurrency: dashboardState?.snapshot?.display?.currency ?? dashboardState?.user?.display_currency,
    isExpanded: reserveSettingsExpanded,
    t,
    moneyBase,
    moneyDisplay
  });
  setOptionalText("#reserveSummaryTitle", view.title);
  setOptionalText("#reserveSummaryMeta", view.meta);
  setOptionalText("#reserveSummaryDescription", view.description);
  setOptionalText("#reserveSummaryStatus", view.status);

  const summaryButton = document.querySelector("#reserveSummaryButton");
  summaryButton?.setAttribute("aria-expanded", String(view.isExpanded));
  summaryButton?.classList.toggle("reserve-summary--expanded", view.isExpanded);

  const disabledNote = document.querySelector("#reserveDisabledNote");
  if (disabledNote) {
    disabledNote.textContent = view.disabledNote;
    disabledNote.classList.toggle("hidden", !view.disabledNote || view.isExpanded);
  }

  document.querySelector("#reserveForm")?.classList.toggle("hidden", !view.isExpanded);
  document.querySelector("#reserveScopeField")?.classList.toggle("hidden", !view.showScope);
  document.querySelector("#disableReserveButton")?.classList.toggle("hidden", !view.showDisable);
}

function renderPlannedMonthSummary(items) {
  const summary = dashboardState?.plannedMonthSummary ?? calculatePlannedMonthSummary(items);
  const baseCurrency = dashboardState?.user?.base_currency ?? dashboardState?.snapshot?.baseCurrency ?? "THB";
  const total = plannedSummaryMoneyParts(summary.total, baseCurrency, summary.display.total, summary.display.currency);
  const paid = plannedSummaryMoneyParts(summary.paid, baseCurrency, summary.display.paid, summary.display.currency);
  const remaining = plannedSummaryMoneyParts(summary.remaining, baseCurrency, summary.display.remaining, summary.display.currency);

  setHtml("#plannedReserveTotal", plannedSummaryMoneyHtml(total));
  setHtml("#plannedReservePaidRemaining", currentLanguage === "ru"
    ? `${plannedSummaryRowHtml("Оплачено", paid)}${plannedSummaryRowHtml("Осталось", remaining)}`
    : `${plannedSummaryRowHtml("Paid", paid)}${plannedSummaryRowHtml("Remaining", remaining)}`);
  const progress = document.querySelector("#plannedSummaryProgressFill");
  if (progress) progress.style.width = `${plannedPaidPercent(summary)}%`;
}

function plannedSummaryMoneyParts(baseAmount, baseCurrency, displayAmount, displayCurrency) {
  return {
    base: moneyBase(baseAmount, baseCurrency),
    display: displayCurrency && displayCurrency !== baseCurrency
      ? moneyDisplay(displayAmount, displayCurrency)
      : ""
  };
}

function plannedSummaryMoneyHtml(parts) {
  return parts.display ? `${parts.base} <em>· ${parts.display}</em>` : parts.base;
}

function plannedSummaryRowHtml(label, parts) {
  return `
    <div class="planned-summary-row">
      <span class="planned-summary-row__label">${label}</span>
      <span class="planned-summary-row__amount">${plannedSummaryMoneyHtml(parts)}</span>
    </div>
  `;
}

function renderPlannedNotice(items) {
  const notice = document.querySelector("#plannedNotice");
  const entries = dueOrOverduePlannedOccurrences(items);
  if (!entries.length) {
    const next = nextUnpaidPlannedItem(items);
    if (!next) {
      notice.classList.add("hidden");
      notice.innerHTML = "";
      return;
    }
    notice.classList.remove("hidden");
    notice.innerHTML = plannedFutureRowHtml(next);
    return;
  }
  notice.classList.remove("hidden");
  const hasToday = entries.some((entry) => entry.isToday);
  const hasOverdue = entries.some((entry) => !entry.isToday);
  const titleKey = hasToday && hasOverdue
    ? "plan.paymentsDueTitle"
    : hasOverdue ? "plan.overduePaymentsTitle" : "plan.paymentsDueTodayTitle";
  const rows = entries.map((entry) => plannedDueRowHtml(entry, titleKey)).join("");
  notice.innerHTML = `<div class="planned-due-list${hasOverdue ? " planned-due-list--overdue" : ""}">${rows}</div>`;
  bindPlannedActions(notice, items);
}

function plannedFutureRowHtml(entry) {
  const item = entry.item;
  const occurrenceDate = entry.occurrence?.occurrence_date ?? entry.date;
  const metaParts = [
    formatDateOnly(occurrenceDate, currentLanguage, userTimeZone()),
    moneyBase(item.amount_base ?? item.amount)
  ];
  const displayText = moneyDisplay(item.display?.amount, item.display?.currency);
  if (displayText && item.display?.currency && String(item.display.currency).toUpperCase() !== String(item.base_currency ?? "").toUpperCase()) {
    metaParts.push(displayText);
  }
  return `
    <article class="planned-due-row planned-due-row--compact planned-due-row--future">
      <span class="planned-due-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M8 3v4m8-4v4M8 11h8"/></svg></span>
      <div class="planned-due-main">
        <span class="planned-due-label">${t("plan.nextPlanned")}</span>
        <strong class="planned-due-title">${escapeHtml(item.description)}</strong>
        <em class="planned-due-meta">${escapeHtml(metaParts.join(" · "))}</em>
      </div>
    </article>
  `;
}

function plannedDueRowHtml(entry, titleKey) {
  const { item, occurrence, isToday } = entry;
  const dateLabel = isToday
    ? t("plan.dueToday")
    : t("plan.wasDue", { date: formatDateOnly(occurrence.occurrence_date, currentLanguage, userTimeZone()) });
  const displayCurrency = item.display?.currency;
  const displayAmount = item.display?.amount;
  const baseAmount = moneyBase(item.amount_base ?? item.amount);
  const metaParts = [dateLabel, baseAmount];
  const displayText = moneyDisplay(displayAmount, displayCurrency);
  if (displayText && displayCurrency && String(displayCurrency).toUpperCase() !== String(item.base_currency ?? "").toUpperCase()) {
    metaParts.push(displayText);
  }
  const labelKey = titleKey ?? "plan.paymentsDueTodayTitle";
  const payAttributes = `data-pay-planned="${escapeAttribute(item.id)}" data-occurrence-date="${escapeAttribute(occurrence.occurrence_date)}"`;
  return `
    <article class="planned-due-row planned-due-row--compact">
      <span class="planned-due-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M8 3v4m8-4v4M8 11h8"/></svg></span>
      <div class="planned-due-main">
        <span class="planned-due-label">${t(labelKey)}</span>
        <strong class="planned-due-title">${escapeHtml(item.description)}</strong>
        <em class="planned-due-meta">${escapeHtml(metaParts.join(" · "))}</em>
      </div>
      <button type="button" class="planned-due-pay" ${payAttributes}>${t("actions.pay")}</button>
    </article>
  `;
}

function openPlannedDueMenu(item, anchor) {
  const popover = document.querySelector("#plannedDuePopover");
  if (!popover) return;
  popover.innerHTML = `
    <button type="button" data-edit-planned="${escapeAttribute(item.id)}">${t("actions.edit")}</button>
    <button type="button" data-open-plan-tab>${t("actions.openPlan")}</button>
  `;
  popover.classList.remove("hidden");
  popover.dataset.plannedId = item.id;
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    const popoverWidth = 160;
    const left = Math.min(rect.right, window.innerWidth - popoverWidth - 8);
    popover.style.top = `${rect.bottom + 4}px`;
    popover.style.left = `${Math.max(8, left)}px`;
  }
}

function renderTopCategories(items, monthTotal) {
  const list = document.querySelector("#topCategories");
  if (!items.length) {
    list.innerHTML = `<div class="empty">${t("history.noCategories")}</div>`;
    return;
  }
  list.innerHTML = items.map((item) => {
    const total = Number(item.total);
    const percent = monthTotal > 0 ? Math.round((total / monthTotal) * 100) : 0;
    return `
      <div class="bar-row" style="--category-color: ${categoryColor(item.category_slug)}">
        <div class="bar-row-top">
          <span>${escapeHtml(categoryLabel(item.category_slug, currentLanguage))}</span>
          <strong>${moneyBase(total)} · ${percent}%</strong>
        </div>
        <div class="bar-row-display">${moneyDisplay(item.display?.amount, item.display?.currency)}</div>
        <div class="bar-track"><div class="bar-fill" style="width: ${Math.min(percent, 100)}%"></div></div>
      </div>
    `;
  }).join("");
}

function renderLatest(expenses) {
  const list = document.querySelector("#latestExpenses");
  if (!expenses.length) {
    list.innerHTML = `<div class="empty">${t("history.noExpenses")}</div>`;
    return;
  }
  list.innerHTML = expenses.slice(0, 3).map(dashboardExpenseRow).join("");
  bindExpenseActions(list, expenses, { returnTab: "dashboard" });
}

function dashboardExpenseRow(expense) {
  const amount = expense.amount_original ?? expense.amount_base ?? expense.amount ?? 0;
  const currency = expense.currency_original
    ?? expense.base_currency
    ?? dashboardState?.snapshot?.baseCurrency
    ?? dashboardState?.user?.base_currency
    ?? "THB";
  return `
    <button type="button" class="dashboard-expense-row" data-edit-expense="${escapeAttribute(expense.id)}" aria-label="${escapeAttribute(`${t("actions.edit")}: ${expense.description}`)}" style="--category-color: ${categoryColor(expense.category_slug)}">
      <span class="dashboard-expense-icon" aria-hidden="true">${categoryIconSvg(expense.category_slug)}</span>
      <span class="dashboard-expense-main">
        <strong>${escapeHtml(expense.description)}</strong>
        <span>${formatDate(expense.spent_at, currentLanguage, userTimeZone())}</span>
      </span>
      <span class="dashboard-expense-amount">
        <strong>${formatMoney(amount, currency)}</strong>
        <em>${moneyDisplay(expense.display?.amount, expense.display?.currency)}</em>
      </span>
    </button>
  `;
}

function renderHistory(expenses) {
  const list = document.querySelector("#historyList");
  const savedHeading = document.querySelector("#historySavedHeading");
  if (!expenses.length) {
    const searching = document.querySelector("#historySearch")?.value.trim();
    list.innerHTML = `<div class="empty">${escapeHtml(searching ? t("history.empty") : t("history.periodEmpty"))}</div>`;
    savedHeading?.classList.add("hidden");
    return;
  }

  savedHeading?.classList.remove("hidden");
  const groups = groupByDay(expenses);
  list.innerHTML = groups.map((group) => `
    <section class="history-day">
      <div class="history-day-heading">
        <h3>${escapeHtml(group.label)}</h3>
        <strong>${moneyBase(group.total)}</strong>
      </div>
      ${group.items.map(expenseRow).join("")}
    </section>
  `).join("");
  bindExpenseActions(list, expenses);
}

function renderInboxDrafts(previewState) {
  const drafts = previewState?.drafts ?? [];
  const block = document.querySelector("#inboxBlock");
  const list = document.querySelector("#inboxDrafts");
  const title = document.querySelector("#inboxTitle");
  const summary = document.querySelector("#inboxSummary");
  const acceptButton = document.querySelector("#acceptReviewDraftsButton");
  const reviewButton = document.querySelector("#reviewDraftsOneByOneButton");
  if (!drafts.length) {
    block.classList.add("hidden");
    list.innerHTML = "";
    historyReviewQueueIds = [];
    historyReviewQueueTotal = 0;
    return;
  }
  block.classList.remove("hidden");
  title.textContent = reviewAcceptanceTitle(previewState, currentLanguage);
  summary.textContent = reviewAcceptanceSummary(previewState, currentLanguage);
  acceptButton.textContent = reviewAcceptancePrimaryAction(previewState.acceptItemCount, currentLanguage);
  acceptButton.classList.toggle("hidden", !previewState.acceptItemCount);
  reviewButton.textContent = reviewAcceptanceReviewAction(previewState, currentLanguage);

  const currentIds = new Set(drafts.map((draft) => String(draft.id)));
  historyReviewQueueIds = historyReviewQueueIds.filter((id) => currentIds.has(String(id)));
  const queueDrafts = historyReviewQueueIds
    .map((id) => drafts.find((draft) => String(draft.id) === String(id)))
    .filter(Boolean);
  if (!queueDrafts.length) {
    list.classList.add("hidden");
    list.innerHTML = "";
    return;
  }
  const progress = Math.max(1, historyReviewQueueTotal - queueDrafts.length + 1);
  list.classList.remove("hidden");
  list.innerHTML = queueDrafts.slice(0, 1).map((draft) => {
    const total = inboxDraftTotal(draft);
    const description = inboxDraftDescription(draft);
    return `
      <div class="history-review-progress">${currentLanguage === "ru" ? `${progress} из ${historyReviewQueueTotal}` : `${progress} of ${historyReviewQueueTotal}`}</div>
      <article class="expense-row inbox-draft-row" data-inbox-location="history" data-draft-row="${draft.id}" style="--category-color: #b84d7a">
        <div class="expense-main">
          <div class="expense-title">${escapeHtml(description)}</div>
          <div class="expense-meta">${formatDate(draft.created_at, currentLanguage, userTimeZone())} · ${draft.items.length} ${t("history.rows")} · ${moneyBase(total)}</div>
          <div class="button-row inbox-category-row">
            ${inboxCategoryButtons(draft)}
          </div>
        </div>
        <div class="expense-actions">
          <div class="button-row compact">
            <button type="button" data-confirm-draft="${draft.id}">${t("actions.confirm")}</button>
            <button type="button" class="ghost-button" data-open-draft="${draft.id}">${t("actions.open")}</button>
            <button type="button" class="danger-button" data-cancel-draft="${draft.id}">${t("actions.cancel")}</button>
          </div>
        </div>
      </article>
    `;
  }).join("");
  bindInboxActions(list);
}

function renderDashboardInboxDrafts(previewState) {
  const drafts = previewState?.drafts ?? [];
  const block = document.querySelector("#dashboardInboxBlock");
  const list = document.querySelector("#dashboardInboxDrafts");
  const title = document.querySelector("#dashboardInboxTitle");
  const preview = document.querySelector("#dashboardInboxPreview");
  const saveButton = document.querySelector("#saveSafeDraftsButton");
  const reviewButton = document.querySelector("#reviewRecoveryDraftsButton");
  const wasHidden = block.classList.contains("hidden");
  if (!shouldShowInboxOnDashboard(drafts)) {
    block.classList.add("hidden");
    block.open = false;
    list.innerHTML = "";
    preview.textContent = "";
    return;
  }
  block.classList.remove("hidden");
  if (wasHidden) block.open = true;
  title.textContent = smartSaveRecoveryTitle(previewState.totalUnresolved, currentLanguage);
  preview.textContent = smartSaveRecoverySummary(previewState, currentLanguage);
  saveButton.textContent = smartSaveRecoveryPrimaryAction(previewState.safeCount, currentLanguage);
  saveButton.classList.toggle("hidden", !previewState.safeCount);
  reviewButton.textContent = smartSaveRecoveryReviewAction(previewState.reviewCount, currentLanguage);
  reviewButton.classList.toggle("hidden", !previewState.reviewCount);
  const reviewIds = new Set((previewState.reviewDraftIds ?? []).map(String));
  const reviewDrafts = drafts.filter((draft) => reviewIds.has(String(draft.id)));
  list.innerHTML = reviewDrafts.slice(0, 2).map((draft) => {
    const total = inboxDraftTotal(draft);
    const description = inboxDraftDescription(draft);
    return `
      <article class="expense-row inbox-draft-row" data-inbox-location="dashboard" data-draft-row="${draft.id}" style="--category-color: #b84d7a">
        <div class="expense-main">
          <div class="expense-title">${escapeHtml(description)}</div>
          <div class="expense-meta">${formatDate(draft.created_at, currentLanguage, userTimeZone())} · ${draft.items.length} ${t("history.rows")} · ${moneyBase(total)}</div>
          <div class="button-row inbox-category-row">
            ${inboxCategoryButtons(draft)}
          </div>
        </div>
        <div class="expense-actions">
          <div class="button-row compact">
            <button type="button" data-confirm-draft="${draft.id}">${t("actions.confirm")}</button>
            <button type="button" class="ghost-button" data-open-draft="${draft.id}">${t("actions.open")}</button>
            <button type="button" class="danger-button" data-cancel-draft="${draft.id}">${t("actions.cancel")}</button>
          </div>
        </div>
      </article>
    `;
  }).join("");
  bindInboxActions(list);
}

function inboxCategoryButtons(draft) {
  const first = draft.items?.[0];
  if (!first) return "";
  const quickCategories = [
    ["food_cafe", currentLanguage === "ru" ? "Еда" : "Food"],
    ["transport", currentLanguage === "ru" ? "Транспорт" : "Transport"],
    ["health", currentLanguage === "ru" ? "Здоровье" : "Health"],
    ["sport_activities", currentLanguage === "ru" ? "Спорт" : "Sport"],
    ["other", currentLanguage === "ru" ? "Другое" : "Other"]
  ];
  return quickCategories.map(([slug, label]) => `
    <button type="button" class="ghost-button ${first.category_slug === slug ? "active-chip" : ""}" data-inbox-draft="${draft.id}" data-inbox-category="${slug}">
      ${escapeHtml(label)}
    </button>
  `).join("");
}

function bindInboxActions(container) {
  container.querySelectorAll("[data-open-draft]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        const row = button.closest(".expense-row");
        await openDraftInline(button.dataset.openDraft, {
          returnTab: row?.dataset.inboxLocation ?? "history",
          row
        });
      } catch (error) {
        console.error("[miniapp] opening review draft failed", error);
        showToast(reviewAcceptanceErrorMessage(error, currentLanguage));
      } finally {
        button.disabled = false;
      }
    });
  });
  container.querySelectorAll("[data-confirm-draft]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      try {
        await api(`/api/drafts/${button.dataset.confirmDraft}/confirm`, { method: "POST", body: { telegramUserId } });
        await loadDashboard();
        await loadHistory();
        showToast(t("toast.draftConfirmed"));
      } catch (error) {
        console.error("[miniapp] confirming review draft failed", error);
        showToast(reviewAcceptanceErrorMessage(error, currentLanguage));
      } finally {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    });
  });
  container.querySelectorAll("[data-inbox-category]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        const draft = inboxState.find((item) => String(item.id) === button.dataset.inboxDraft);
        if (!draft) return;
        const items = updateFirstInboxItemCategory(draft, button.dataset.inboxCategory);
        await api(`/api/drafts/${draft.id}`, { method: "PATCH", body: { telegramUserId, items } });
        await loadHistory();
        showToast(t("toast.categoryUpdated"));
      } catch (error) {
        console.error("[miniapp] updating review category failed", error);
        showToast(reviewAcceptanceErrorMessage(error, currentLanguage));
      } finally {
        button.disabled = false;
      }
    });
  });
  container.querySelectorAll("[data-cancel-draft]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (button.disabled || !window.confirm(t("confirmations.closeWithoutSaving"))) return;
      button.disabled = true;
      try {
        await api(`/api/drafts/${button.dataset.cancelDraft}`, { method: "DELETE", body: { telegramUserId } });
        await loadDashboard();
        await loadHistory();
        showToast(t("toast.draftCanceled"));
      } catch (error) {
        console.error("[miniapp] cancelling review draft failed", error);
        showToast(reviewAcceptanceErrorMessage(error, currentLanguage));
      } finally {
        button.disabled = false;
      }
    });
  });
}

async function openDraftInline(id, options = {}) {
  await loadDraft(id, { returnTab: options.returnTab ?? "dashboard" });
  const section = document.querySelector("#draftEditorSection");
  const row = options.row ?? document.querySelector(`[data-draft-row="${id}"]`);
  if (row && section) {
    row.after(section);
    section.dataset.inlineDraftId = String(id);
  }
  section?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function expenseRow(expense) {
  const impactLabel = budgetImpactLabel(expense.budget_impact);
  const tags = (expense.tags ?? []).map((tag) => `#${tag}`).join(" ");
  return `
    <button type="button" class="expense-row history-expense-row" data-edit-expense="${escapeAttribute(expense.id)}" aria-label="${escapeAttribute(`${t("actions.edit")}: ${expense.description}`)}" style="--category-color: ${categoryColor(expense.category_slug)}">
      <span class="dashboard-expense-icon" aria-hidden="true">${categoryIconSvg(expense.category_slug)}</span>
      <span class="expense-main">
        <span class="expense-title">${escapeHtml(expense.description)}</span>
        ${impactLabel ? `<span class="expense-meta">${impactLabel}</span>` : ""}
        <span class="expense-meta">${formatDate(expense.spent_at, currentLanguage, userTimeZone())} · ${escapeHtml(categoryLabel(expense.category_slug, currentLanguage))}${tags ? ` · ${escapeHtml(tags)}` : ""}</span>
      </span>
      <span class="expense-amount history-expense-amount">${formatMoney(expense.amount_original, expense.currency_original)}
        <em>${moneyDisplay(expense.display?.amount, expense.display?.currency)}</em>
      </span>
    </button>
  `;
}

function budgetImpactLabel(value) {
  if (value === "planned") return currentLanguage === "ru" ? "🧾 Плановая" : "🧾 Planned";
  if (value === "large_oneoff") return currentLanguage === "ru" ? "📦 Крупная" : "📦 Large";
  return "";
}

function bindExpenseActions(container, expenses, options = {}) {
  container.querySelectorAll("[data-edit-expense]").forEach((button) => {
    button.addEventListener("click", () => {
      const expense = expenses.find((item) => String(item.id) === button.dataset.editExpense);
      renderExpenseEditor(expense, { returnTab: options.returnTab ?? "history" });
    });
  });
}

function renderPlannedForm(item = {}, { mode = "create", sourcePlannedExpenseId = null } = {}) {
  const form = document.querySelector("#plannedForm");
  const dueDays = Array.isArray(item.due_days) && item.due_days.length ? item.due_days.join(", ") : (item.due_day ?? "");
  const plannedCurrency = defaultPlannedCurrency(item, dashboardState?.user?.base_currency ?? "THB");
  const startsOn = mode === "recreate" ? localDateKeyInTimeZone(new Date(), userTimeZone()) : null;
  const sourceDueDate = item.due_date ? String(item.due_date).slice(0, 10) : "";
  const dueDate = mode === "recreate" && sourceDueDate <= startsOn ? "" : sourceDueDate;
  const title = mode === "recreate" ? t("plan.createAgain") : mode === "edit" ? t("plan.saveExisting") : t("plan.addPlanned");
  const submitLabel = mode === "recreate" ? t("plan.createAgain") : mode === "edit" ? t("plan.saveExisting") : t("plan.saveNew");
  const recreateSession = mode === "recreate" ? createPlannedRecreateSession() : null;
  const plannedTagsField = `
    <label>
      <span>${t("forms.tagsComma")}</span>
      <input name="planned-tags" value="${escapeAttribute((item.tags ?? []).join(", "))}" />
    </label>
  `;
  const plannedTags = mode === "edit" ? `
    <details class="edit-modal__advanced">
      <summary>${t("forms.additional")}</summary>
      <div class="edit-modal__advanced-fields">${plannedTagsField}</div>
    </details>
  ` : plannedTagsField;
  const plannedActions = mode === "edit" ? `
    <button type="submit">${submitLabel}</button>
    <button type="button" class="danger-button" data-disable-planned-edit>${t("plan.disableExisting")}</button>
  ` : `
    <button type="submit">${submitLabel}</button>
    <button type="button" class="ghost-button" id="resetPlannedForm">${t("plan.reset")}</button>
    <button type="button" class="ghost-button" id="cancelPlannedForm">${t("actions.close")}</button>
  `;
  form.innerHTML = `
    ${mode === "edit" ? "" : `<h3>${title}</h3>`}
    ${mode === "recreate" ? `
      <label>
        <span>${t("plan.startsOn")}</span>
        <input name="planned-starts_on" type="date" value="${startsOn}" min="${startsOn}" required />
      </label>
    ` : ""}
    <div class="field-grid">
      <label>
        <span>${t("forms.description")}</span>
        <input name="planned-description" value="${escapeAttribute(item.description ?? "")}" placeholder="${currentLanguage === "ru" ? "ChatGPT, аренда, английский" : "ChatGPT, rent, English"}" required />
      </label>
      <label>
        <span>${t("forms.amount")}</span>
        <input name="planned-amount" type="number" min="0.01" step="0.01" value="${item.amount ?? ""}" required />
      </label>
    </div>
    <div class="field-grid">
      <label>
        <span>${t("forms.currency")}</span>
        <select name="planned-currency">${currencyOptions(plannedCurrency, option)}</select>
      </label>
      <label>
        <span>${t("plan.recurrence")}</span>
        <select name="planned-recurrence">
          ${option("monthly", item.recurrence, t("plan.monthly"))}
          ${option("weekly", item.recurrence, t("plan.weekly"))}
          ${option("twice_monthly", item.recurrence, t("plan.twiceMonthly"))}
          ${option("one_off", item.recurrence, t("plan.oneOff"))}
        </select>
      </label>
    </div>
    <div class="field-grid">
      <label>
        <span>${t("forms.category")}</span>
        <select name="planned-category_slug">${categories.map(([slug]) => option(slug, item.category_slug, categoryLabel(slug, currentLanguage))).join("")}</select>
      </label>
      <label data-recurrence-field="monthly">
        <span>${t("plan.dayOfMonth")}</span>
        <input name="planned-due_day" type="number" min="1" max="31" value="${item.due_day ?? ""}" />
      </label>
      <label data-recurrence-field="twice_monthly">
        <span>${t("plan.daysOfMonth")}</span>
        <input name="planned-due_days" value="${escapeAttribute(dueDays)}" placeholder="4, 18" />
      </label>
      <label data-recurrence-field="weekly">
        <span>${t("plan.weekday")}</span>
        <select name="planned-weekday">${weekdayOptions(item.weekday)}</select>
      </label>
      <label data-recurrence-field="one_off">
        <span>${t("plan.dueDate")}</span>
        <input name="planned-due_date" type="date" value="${dueDate}" />
      </label>
    </div>
    ${plannedTags}
    <div class="button-row edit-modal__actions">
      ${plannedActions}
    </div>
  `;
  form.onsubmit = (event) => savePlanned(event, {
    mode,
    plannedId: mode === "edit" ? item.id : null,
    sourcePlannedExpenseId,
    recreateSession
  });
  form.querySelector("[data-disable-planned-edit]")?.addEventListener("click", (event) => {
    disablePlanned(item, event.currentTarget, { closeModal: true });
  });
  form.querySelector("#resetPlannedForm")?.addEventListener("click", () => renderPlannedForm());
  form.querySelector("#cancelPlannedForm")?.addEventListener("click", closeAndResetPlannedForm);
  form.querySelector('[name="planned-recurrence"]').addEventListener("change", syncPlannedRecurrenceFields);
  syncPlannedRecurrenceFields();
}

function syncPlannedRecurrenceFields() {
  const recurrence = input("planned-recurrence")?.value ?? "monthly";
  document.querySelectorAll("[data-recurrence-field]").forEach((field) => {
    field.classList.toggle("hidden", field.dataset.recurrenceField !== recurrence);
  });
}

function renderPlannedExpenses(items) {
  const list = document.querySelector("#plannedExpenses");
  if (!items.length) {
    list.innerHTML = `<div class="empty">${t("plan.noPlanned")}</div>`;
    return;
  }
  const today = new Date(`${localDateKeyInTimeZone(new Date(), userTimeZone())}T12:00:00`);
  list.innerHTML = items.map((item) => {
    const status = plannedPaymentStatus(item, today);
    const paid = status === "paid";
    const progress = plannedPaymentProgressLabel(item, status, today);
    const undoButtons = paidPlannedPaymentUndoOccurrences(item)
      .map((occurrenceDate) => {
        const date = formatDateOnly(`${occurrenceDate}T12:00:00.000Z`, currentLanguage, "UTC");
        return `<button type="button" class="ghost-button" data-undo-planned="${escapeAttribute(item.id)}" data-occurrence-date="${escapeAttribute(occurrenceDate)}">${escapeHtml(t("actions.undoPayment", { date }))}</button>`;
      })
      .join("");
    return `
    <article class="planned-expense-card" style="--category-color: ${categoryColor(item.category_slug)}">
      <button type="button" class="planned-expense-card__main" data-edit-planned="${escapeAttribute(item.id)}" aria-label="${escapeAttribute(`${t("actions.edit")}: ${item.description}`)}">
        <span class="dashboard-expense-icon" aria-hidden="true">${categoryIconSvg(item.category_slug)}</span>
        <span class="planned-expense-card__content">
          <strong>${escapeHtml(item.description)}</strong>
          <span class="planned-expense-card__meta">${recurrenceLabel(item)} · ${escapeHtml(categoryLabel(item.category_slug, currentLanguage))}</span>
          <span class="planned-expense-card__status planned-expense-card__status--${status}">${escapeHtml(progress)}</span>
        </span>
        <span class="planned-expense-card__amount">${formatMoney(item.amount, item.currency)}<em>${moneyDisplay(item.display?.amount, item.display?.currency)}</em></span>
      </button>
      <div class="planned-expense-card__actions">
        <button type="button" data-pay-planned="${escapeAttribute(item.id)}"${paid ? " disabled" : ""}>${paid ? t("actions.paid") : t("actions.pay")}</button>
        <details class="planned-expense-card__menu" data-planned-overflow>
          <summary aria-label="${escapeAttribute(t("plan.moreActions"))}">⋯</summary>
          <div class="planned-expense-card__overflow">
            ${undoButtons}
            <button type="button" class="danger-button" data-delete-planned="${escapeAttribute(item.id)}">${t("actions.disable")}</button>
          </div>
        </details>
      </div>
    </article>
  `;
  }).join("");
  bindPlannedActions(list, items);
}

function closeAndResetPlannedForm() {
  renderPlannedForm();
  document.querySelector("#plannedForm").classList.add("hidden");
}

function openPlannedEditor(item) {
  if (!item) return;
  renderPlannedForm(item, { mode: "edit" });
  openEditModal({
    form: document.querySelector("#plannedForm"),
    titleText: t("plan.saveExisting"),
    onClose: closeAndResetPlannedForm
  });
}

async function refreshPlannedArchive({ force = false } = {}) {
  if (!plannedArchiveState.expanded && !force) return plannedArchiveState.items;
  if (force) plannedArchiveState.stale = true;
  const pending = expandPlannedArchive(plannedArchiveState, {
    load: async () => {
      const data = await api(`/api/planned-expenses/archive?telegramUserId=${encodeURIComponent(telegramUserId)}`);
      return data.archivedPlannedExpenses ?? [];
    }
  });
  renderPlannedArchive();
  try {
    const items = await pending;
    renderPlannedArchive();
    return items;
  } catch (error) {
    renderPlannedArchive();
    throw error;
  }
}

async function refreshArchiveAfterDisable() {
  const shouldRefresh = invalidatePlannedArchive(plannedArchiveState);
  if (shouldRefresh) await refreshPlannedArchive({ force: true });
}

function renderPlannedArchive() {
  const toggle = document.querySelector("#plannedArchiveToggle");
  const content = document.querySelector("#plannedArchiveContent");
  const status = document.querySelector("#plannedArchiveStatus");
  const list = document.querySelector("#plannedArchiveList");
  if (!toggle || !content || !status || !list) return;

  toggle.setAttribute("aria-expanded", String(plannedArchiveState.expanded));
  content.classList.toggle("hidden", !plannedArchiveState.expanded);
  if (!plannedArchiveState.expanded) return;

  status.innerHTML = "";
  list.innerHTML = "";
  if (plannedArchiveState.status === "loading") {
    status.textContent = t("plan.archiveLoading");
    return;
  }
  if (plannedArchiveState.status === "error") {
    status.innerHTML = `${escapeHtml(t("plan.archiveError"))} <button type="button" class="ghost-button" data-retry-planned-archive>${escapeHtml(t("plan.archiveRetry"))}</button>`;
    status.querySelector("[data-retry-planned-archive]")?.addEventListener("click", async () => {
      try { await refreshPlannedArchive({ force: true }); } catch { /* keep retry state visible */ }
    });
    return;
  }
  if (plannedArchiveState.status !== "loaded") return;
  if (!plannedArchiveState.items.length) {
    status.textContent = t("plan.archiveEmpty");
    return;
  }

  const baseCurrency = dashboardState?.user?.base_currency ?? dashboardState?.snapshot?.baseCurrency ?? "THB";
  list.innerHTML = plannedArchiveState.items.map((item) => {
    const view = buildArchivedPlanView(item, { language: currentLanguage, translate: t });
    const disabledLabel = view.disabledAt
      ? formatDate(view.disabledAt, currentLanguage, userTimeZone())
      : view.disabledLabel;
    const paidAmounts = [moneyBase(view.paidAmountBase, baseCurrency)];
    const displayPaid = moneyDisplay(view.displayPaidAmount, item.display?.currency);
    if (displayPaid && item.display?.currency !== baseCurrency) paidAmounts.push(displayPaid);
    return `
      <article class="expense-row planned-archive__row" style="--category-color: ${categoryColor(item.category_slug)}">
        <div class="expense-main">
          <div class="expense-title">${escapeHtml(view.title)}</div>
          <div class="expense-meta">${escapeHtml(recurrenceLabel(item))} · ${escapeHtml(disabledLabel)}</div>
          <div class="expense-meta">${escapeHtml(view.paymentLabel)} · ${escapeHtml(paidAmounts.join(" · "))}</div>
        </div>
        <div class="expense-actions">
          <div class="expense-amount">${formatMoney(item.amount, item.currency)}
            <em>${moneyDisplay(item.display?.amount, item.display?.currency)}</em>
          </div>
          <div class="button-row compact">
            <button type="button" class="ghost-button" data-recreate-planned="${escapeAttribute(item.id)}">${t("plan.createAgain")}</button>
          </div>
        </div>
      </article>
    `;
  }).join("");
  list.querySelectorAll("[data-recreate-planned]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = plannedArchiveState.items.find((planned) => String(planned.id) === button.dataset.recreatePlanned);
      if (!item) return;
      renderPlannedForm(item, { mode: "recreate", sourcePlannedExpenseId: item.id });
      const form = document.querySelector("#plannedForm");
      form.classList.remove("hidden");
      form.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function plannedPaymentProgressLabel(item, status = plannedPaymentStatus(item), now = new Date()) {
  const occurrences = buildPlannedOccurrences(item, now);
  const statusLabel = t(`plan.status${status[0].toUpperCase()}${status.slice(1)}`);
  if (!occurrences.length) return statusLabel;
  const paid = occurrences.filter((occurrence) => occurrence.paid).length;
  if (occurrences.length === 1) return statusLabel;
  const progress = `${paid}/${occurrences.length} ${t("plan.paidSuffix")}`;
  return status === "paid" ? progress : `${progress} · ${statusLabel}`;
}

async function disablePlanned(item, button, { closeModal = false } = {}) {
  if (!item) return;
  try {
    await runPlannedDisable({
      button,
      item,
      confirm: window.confirm.bind(window),
      disableRequest: (id) => api(`/api/planned-expenses/${id}`, {
        method: "DELETE",
        body: { telegramUserId }
      }),
      loadDashboard: async () => {
        if (closeModal) closeEditModal();
        await loadDashboard();
        if (closeModal) editModal.restore();
      },
      afterDashboard: refreshArchiveAfterDisable,
      showResult: showToast,
      language: currentLanguage,
      createTranslator,
      translate: t,
      formatMoney
    });
  } catch (error) {
    showError(error);
  }
}

function bindPlannedActions(container, items) {
  container.querySelectorAll("[data-edit-planned]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = items.find((planned) => String(planned.id) === button.dataset.editPlanned);
      openPlannedEditor(item);
    });
  });
  container.querySelectorAll("[data-delete-planned]").forEach((button) => {
    button.addEventListener("click", async () => {
      const item = items.find((planned) => String(planned.id) === button.dataset.deletePlanned);
      await disablePlanned(item, button);
    });
  });
  container.querySelectorAll("[data-pay-planned]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      const originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = currentLanguage === "ru" ? "Оплачиваю…" : "Paying…";
      try {
        const body = { telegramUserId };
        if (button.dataset.occurrenceDate) body.occurrenceDate = button.dataset.occurrenceDate;
        await api(`/api/planned-expenses/${button.dataset.payPlanned}/pay`, { method: "POST", body });
        await loadDashboard();
        await loadHistory();
        showToast(t("toast.paymentSaved"));
      } catch (error) {
        button.disabled = false;
        button.textContent = originalLabel;
        const code = String(error.message || "");
        const message = code === "planned_expense_already_paid"
          ? t("toast.plannedAlreadyPaid")
          : code === "planned_expense_not_found"
            ? t("toast.plannedNotFound")
            : code === "invalid_occurrence"
              ? t("toast.plannedInvalidOccurrence")
              : code === "future_occurrence"
                ? t("toast.plannedFutureOccurrence")
                : code === "internal_error" || !code
                  ? t("toast.paymentFailed")
                  : code;
        showToast(message);
      }
    });
  });
  container.querySelectorAll("[data-undo-planned]").forEach((button) => {
    button.addEventListener("click", async () => {
      const item = items.find((planned) => String(planned.id) === button.dataset.undoPlanned);
      if (!item) return;
      await runPlannedPaymentUndo({
        button,
        item,
        occurrenceDate: button.dataset.occurrenceDate,
        confirm: window.confirm.bind(window),
        undoRequest: (id, occurrenceDate) => api(`/api/planned-expenses/${id}/payments/${encodeURIComponent(occurrenceDate)}`, {
          method: "DELETE",
          body: { telegramUserId }
        }),
        loadDashboard,
        loadHistory,
        showToast,
        showError: showToast,
        translate: t,
        formatOccurrenceDate: (value) => formatDateOnly(`${value}T12:00:00.000Z`, currentLanguage, "UTC")
      });
    });
  });
  container.querySelectorAll("[data-planned-menu]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const item = items.find((planned) => String(planned.id) === button.dataset.plannedMenu);
      if (!item) return;
      const popover = document.querySelector("#plannedDuePopover");
      if (popover && !popover.classList.contains("hidden") && popover.dataset.plannedId === String(item.id)) {
        popover.classList.add("hidden");
        return;
      }
      openPlannedDueMenu(item, button);
    });
  });
  const popover = container.querySelector("#plannedDuePopover");
  if (popover) {
    popover.querySelectorAll("[data-edit-planned]").forEach((button) => {
      button.addEventListener("click", () => {
        const item = items.find((planned) => String(planned.id) === button.dataset.editPlanned);
        popover.classList.add("hidden");
        openPlannedEditor(item);
      });
    });
    popover.querySelectorAll("[data-open-plan-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        popover.classList.add("hidden");
        switchTab("plan");
      });
    });
  }
}

function renderDraftEditor(draft) {
  const section = document.querySelector("#draftEditorSection");
  const title = document.querySelector("#draftEditorTitle");
  const form = document.querySelector("#draftForm");
  if (title) title.textContent = draft.status === "inbox" ? (currentLanguage === "ru" ? "Разобрать черновик" : "Review draft") : (currentLanguage === "ru" ? "Черновик" : "Draft");
  section.classList.remove("hidden");
  form.innerHTML = `
    <div class="form-stack">
      ${draft.items.map((item, index) => editableItemFields(item, `draft-${index}`, index)).join("")}
      <div class="button-row">
        <button type="submit">${t("actions.saveChanges")}</button>
        <button type="button" id="confirmDraftButton">${t("actions.confirm")}</button>
        <button type="button" class="danger-button" id="cancelDraftButton">${t("actions.cancelDraft")}</button>
        <button type="button" class="ghost-button" id="closeDraftButton">${t("actions.close")}</button>
      </div>
    </div>
  `;
  form.onsubmit = saveDraft;
  form.querySelector("#confirmDraftButton").addEventListener("click", confirmDraft);
  form.querySelector("#cancelDraftButton").addEventListener("click", cancelDraftFromEditor);
  form.querySelector("#closeDraftButton").addEventListener("click", closeDraftEditor);
  form.addEventListener("input", () => { draftDirty = true; });
  draftDirty = false;
}

function renderExpenseEditor(expense, options = {}) {
  if (!expense) return;
  const form = document.querySelector("#expenseForm");
  form.innerHTML = `
    <div class="form-stack">
      ${editableItemFields({
        amount: expense.amount_original,
        currency: expense.currency_original,
        description: expense.description,
        category_slug: expense.category_slug,
        budget_impact: expense.budget_impact ?? "regular",
        tags: expense.tags ?? [],
        spent_at: expense.spent_at
      }, "expense", 0)}
      <div class="button-row edit-modal__actions">
        <button type="submit">${t("actions.saveExpense")}</button>
        <button type="button" class="danger-button" data-delete-expense="${escapeAttribute(expense.id)}">${t("actions.delete")}</button>
      </div>
    </div>
  `;
  form.onsubmit = (event) => saveExpense(event, expense.id);
  form.querySelector("[data-delete-expense]").addEventListener("click", (event) => {
    deleteExpense(expense, event.currentTarget).catch(showError);
  });
  openEditModal({
    form,
    titleText: currentLanguage === "ru" ? `Расход: ${expense.description}` : `Expense: ${expense.description}`
  });
}

function closeDraftEditor() {
  if (draftDirty && !window.confirm(t("confirmations.closeWithoutSaving"))) return;
  document.querySelector("#draftEditorSection").classList.add("hidden");
  draftState = null;
  draftDirty = false;
  switchTab(draftReturnTab);
}

function closeExpenseEditor() {
  closeEditModal();
}

function openEditModal({ form, titleText, onClose = null }) {
  editModal.open({ form, titleText, onClose });
}

function closeEditModal() {
  editModal.close();
}

function editableItemFields(item, prefix, index) {
  return `
    <fieldset class="edit-card" data-index="${index}">
      <label>
        <span>${t("forms.description")}</span>
        <input name="${prefix}-description" value="${escapeAttribute(item.description ?? "")}" required />
      </label>
      <div class="field-grid">
        <label>
          <span>${t("forms.amount")}</span>
          <input name="${prefix}-amount" type="number" min="0.01" step="0.01" value="${Number(item.amount)}" required />
        </label>
        <label>
          <span>${t("forms.currency")}</span>
          <select name="${prefix}-currency">${currencyOptions(item.currency, option)}</select>
        </label>
      </div>
      <label>
        <span>${t("forms.category")}</span>
        <select name="${prefix}-category_slug">${categories.map(([slug]) => option(slug, item.category_slug, categoryLabel(slug, currentLanguage))).join("")}</select>
      </label>
      <details class="edit-modal__advanced">
        <summary>${t("forms.additional")}</summary>
        <div class="edit-modal__advanced-fields">
          <label>
            <span>${currentLanguage === "ru" ? "Тип расхода" : "Expense type"}</span>
            <select name="${prefix}-budget_impact">
              ${option("regular", item.budget_impact ?? "regular", currentLanguage === "ru" ? "Обычная" : "Regular")}
              ${option("planned", item.budget_impact ?? "regular", currentLanguage === "ru" ? "Плановая" : "Planned")}
              ${option("large_oneoff", item.budget_impact ?? "regular", currentLanguage === "ru" ? "Крупная" : "Large")}
            </select>
          </label>
          <label>
            <span>${t("forms.dateAndTime")}</span>
            <input name="${prefix}-spent_at" type="datetime-local" value="${dateTimeLocal(item.spent_at, dashboardState?.user?.timezone)}" required />
          </label>
          <label>
            <span>${t("forms.tagsComma")}</span>
            <input name="${prefix}-tags" value="${escapeAttribute((item.tags ?? []).join(", "))}" />
          </label>
        </div>
      </details>
    </fieldset>
  `;
}

async function saveMonthlyBudget() {
  if (accountDeleted) return;
  const input = document.querySelector("#budgetInput");
  const confirmedSettings = settingsSaveQueue.confirmed();
  const currentValue = Number(confirmedSettings?.monthlyBudgetAmount ?? dashboardState?.user?.monthly_budget_amount);
  const currency = confirmedSettings?.baseCurrency ?? dashboardState?.user?.base_currency ?? "THB";
  const outcome = await commitMonthlyBudgetChange({
    currentValue,
    rawValue: input?.value,
    confirm: ({ currentValue: from, nextValue: to }) => window.confirm(t("confirmations.monthlyBudgetChange", {
      from: formatMoney(from, currency),
      to: formatMoney(to, currency)
    })),
    save: async (monthlyBudgetAmount) => {
      const result = await api("/api/settings/budget", {
        method: "PATCH",
        body: { telegramUserId, monthlyBudgetAmount }
      });
      if (dashboardState?.user && result.user) dashboardState.user = result.user;
      settingsSaveQueue.reset(settingsStateFromUser(result.user));
      await loadDashboard();
      showToast(t("toast.settingsSaved"));
    }
  });
  if (outcome.status === "failed") {
    const code = outcome.error?.body?.error ?? outcome.error?.message;
    if (code === "reserve_conflicts_with_budget_change") {
      const details = outcome.error?.body?.details ?? {};
      showToast(t("toast.budgetReserveConflict", {
        attempted: formatMoney(details.nextBudgetAmount ?? Number(input?.value), currency),
        minimum: formatMoney(details.minimumBudgetAmount, currency)
      }));
    } else {
      showToast(t("toast.settingsSaveFailed"));
    }
  }
  if (["cancelled", "failed"].includes(outcome.status) && input) input.value = Math.round(currentValue);
}

function scheduleSettingsAutosave() {
  if (accountDeleted) return Promise.resolve();
  return settingsSaveQueue.enqueue(collectAutosaveSettingsState());
}

async function requestExpenseExport(period) {
  if (accountDeleted) return;
  try {
    const result = await api("/api/exports/expenses", {
      method: "POST",
      body: { period }
    });
    showToast(result.message ?? t("toast.exportRequested"));
  } catch (error) {
    showToast(error.body?.message ?? error.message);
  }
}

async function callAccountDeletion(endpoint, body = {}) {
  return api(endpoint, {
    method: "POST",
    body: { source: "miniapp", ...body }
  });
}

function setDeleteAccountStage(stage) {
  document.getElementById("deleteAccountStartState")?.classList.toggle("hidden", stage !== "start");
  document.getElementById("deleteAccountWarningState")?.classList.toggle("hidden", stage !== "warning");
  document.getElementById("deleteAccountConfirmState")?.classList.toggle("hidden", stage !== "confirm");
  deleteAccountCancelButton?.classList.toggle("hidden", stage === "start");
  if (stage !== "confirm" && deleteAccountConfirmInput && deleteAccountConfirmButton) {
    deleteAccountConfirmInput.value = "";
    deleteAccountConfirmButton.disabled = true;
  }
}

function showAccountDeletionError(error) {
  const code = error.body?.error ?? error.message;
  if (code === "account_deletion_expired") {
    setDeleteAccountStage("start");
    showToast(t("toast.accountDeletionExpired"));
    return;
  }
  showToast(t("toast.accountDeletionFailed"));
}

async function requestAccountDeletion() {
  if (accountDeleted) return;
  try {
    await callAccountDeletion("/api/account-deletion/request");
    setDeleteAccountStage("warning");
    showToast(t("toast.accountDeletionRequested"));
  } catch (error) {
    showAccountDeletionError(error);
  }
}

async function advanceAccountDeletion() {
  if (accountDeleted) return;
  try {
    await callAccountDeletion("/api/account-deletion/advance");
    setDeleteAccountStage("confirm");
    deleteAccountConfirmInput?.focus();
  } catch (error) {
    showAccountDeletionError(error);
  }
}

async function cancelAccountDeletion() {
  if (accountDeleted) return;
  try {
    await callAccountDeletion("/api/account-deletion/cancel");
    setDeleteAccountStage("start");
    showToast(t("toast.accountDeletionCancelled"));
  } catch (error) {
    showAccountDeletionError(error);
  }
}

async function confirmAccountDeletion() {
  if (accountDeleted) return;
  const confirmationText = deleteAccountConfirmInput?.value ?? "";
  if (confirmationText !== "DELETE") return;
  try {
    await callAccountDeletion("/api/account-deletion/confirm", { confirmationText });
    renderDeletedState();
  } catch (error) {
    showAccountDeletionError(error);
  }
}

function renderDeletedState() {
  accountDeleted = true;
  const bottomTabs = document.querySelector(".bottom-tabs");
  bottomTabs?.querySelectorAll("button").forEach((button) => {
    button.disabled = true;
  });
  bottomTabs?.classList.add("hidden");
  bottomTabs?.setAttribute("aria-hidden", "true");
  document.querySelector("#openQuickEntryButton")?.classList.add("hidden");
  document.querySelectorAll("#settingsForm input, #settingsForm select, #settingsForm button").forEach((control) => {
    control.disabled = true;
  });
  document.querySelectorAll("[data-export-period]").forEach((control) => {
    control.disabled = true;
  });
  document.querySelectorAll("#dashboardTab button, #planTab button, #historyTab button, #dashboardTab input, #planTab input, #historyTab input, #dashboardTab select, #planTab select, #historyTab select").forEach((control) => {
    control.disabled = true;
  });

  const section = document.getElementById("deleteAccountSection");
  if (!section) return;
  const title = document.createElement("h3");
  title.className = "settings-section-title danger-zone__label";
  title.textContent = t("settings.deleteDataDeletedTitle");
  const body = document.createElement("p");
  body.className = "deleted-account-state";
  body.textContent = t("settings.deleteDataDeletedBody");
  section.classList.add("danger-zone--deleted");
  section.replaceChildren(title, body);
}

function detectTimezone() {
  const input = document.querySelector("#timezoneInput");
  if (!input) return;
  input.value = detectBrowserTimeZone();
  renderTimezoneOptions(input.value);
  scheduleSettingsAutosave();
}

function renderTimezoneOptions(value) {
  const input = document.querySelector("#timezoneInput");
  if (!input) return;
  const selected = normalizeSettingsTimeZone(value);
  const zones = filterTimeZones(document.querySelector("#timezoneSearch")?.value ?? "");
  input.innerHTML = [...new Set([...zones, selected])]
    .map((timeZone) => option(timeZone, selected, timeZone))
    .join("");
  input.value = selected;
  const pickerButton = document.querySelector("#timezonePickerButton");
  pickerButton.textContent = `${timeZoneOffsetLabel(selected)} · ${timeZoneCityLabel(selected)}`;
  const options = document.querySelector("#timezoneOptions");
  if (options) options.innerHTML = zones.map((timeZone) => `<button type="button" class="timezone-picker__option" data-timezone="${escapeHtml(timeZone)}" role="option" aria-selected="${timeZone === selected}"><strong>${escapeHtml(`${timeZoneOffsetLabel(timeZone)} · ${timeZoneCityLabel(timeZone)}`)}</strong><small>${escapeHtml(timeZone)}</small></button>`).join("");
}

async function saveCurrentMonthBudget() {
  await api("/api/settings/current-month-budget", {
    method: "PATCH",
    body: {
      telegramUserId,
      currentMonthBudgetAmount: Number(document.querySelector("#currentMonthBudgetInput").value),
      currency: dashboardState?.user?.base_currency ?? dashboardState?.snapshot?.baseCurrency ?? "THB"
    }
  });
  await loadDashboard();
  showToast(t("toast.settingsSaved"));
}

async function saveReserve(event) {
  event.preventDefault();
  const recurring = document.querySelector("#reserveRecurringInput").checked;
  const scope = recurring ? document.querySelector("#reserveScopeInput").value : "current";
  try {
    await api("/api/reserve/current", {
      method: "PUT",
      body: {
        telegramUserId,
        reserve: {
          amount: Number(document.querySelector("#reserveAmountInput").value),
          title: document.querySelector("#reserveTitleInput").value,
          scope
        }
      }
    });
    await loadDashboard();
    reserveSettingsExpanded = false;
    renderReserveSettings();
    showToast(t("reserve.savedAction"));
  } catch (error) {
    showToast(error.message === "reserve_exceeds_free_budget" ? t("reserve.validationError") : error.message);
  }
}

async function disableReserve() {
  const recurring = document.querySelector("#reserveRecurringInput").checked;
  const scope = recurring ? document.querySelector("#reserveScopeInput").value : "current";
  await api("/api/reserve/current/disable", {
    method: "POST",
    body: { telegramUserId, scope }
  });
  await loadDashboard();
  reserveSettingsExpanded = false;
  renderReserveSettings();
  showToast(t("reserve.disabledAction"));
}

async function renderClosedReserveEvents(events) {
  if (!events.length) return;
  const latest = events.at(-1);
  const amount = latest.saved_amount > 0 ? latest.saved_amount : latest.reserve_amount;
  showToast(latest.status === "saved"
    ? t("reserve.closedSaved", { amount: moneyBase(amount) })
    : t("reserve.closedUsed", { amount: moneyBase(amount) }));
  await api("/api/reserve-events/ack", {
    method: "POST",
    body: { telegramUserId, eventIds: events.map((event) => event.id) }
  });
}

async function saveDraft(event) {
  event.preventDefault();
  await saveDraftItems({ showFeedback: true });
}

async function saveDraftItems(options = {}) {
  const items = draftState.items.map((item, index) => collectItem(`draft-${index}`, item));
  let status = 200;
  let errorBody = null;
  let data;
  try {
    data = await api(`/api/drafts/${draftState.id}`, { method: "PATCH", body: { telegramUserId, items, expectedVersion: draftState.version } });
  } catch (error) {
    status = error?.status ?? 500;
    errorBody = error?.body ?? null;
    const outcome = resolveDraftSaveResponse(status, errorBody);
    if (outcome.conflict) {
      draftState = outcome.draft;
      renderDraftEditor(draftState);
      draftDirty = false;
      showToast(t("toast.draftConflict"));
      return { saved: false };
    }
    throw error;
  }
  draftState = data.draft;
  renderDraftEditor(draftState);
  draftDirty = false;
  if (options.showFeedback) showToast(t("toast.draftSaved"));
  return { saved: true };
}

async function confirmDraft() {
  const saveResult = await saveDraftItems();
  if (!saveResult?.saved) return;
  const data = await api(`/api/drafts/${draftState.id}/confirm`, { method: "POST", body: { telegramUserId, language: currentLanguage } });
  const outcome = classifyConfirmOutcome(data);
  document.querySelector("#draftEditorSection").classList.add("hidden");
  await loadDashboard();
  await loadHistory();
  showToast(outcome.alreadySaved ? t("toast.alreadySaved") : t("toast.draftConfirmed"));
  switchTab(draftReturnTab);
}

async function cancelDraftFromEditor() {
  if (!window.confirm(t("confirmations.closeWithoutSaving"))) return;
  await api(`/api/drafts/${draftState.id}`, { method: "DELETE", body: { telegramUserId, language: currentLanguage } });
  document.querySelector("#draftEditorSection").classList.add("hidden");
  draftState = null;
  draftDirty = false;
  await loadDashboard();
  await loadHistory();
  showToast(t("toast.draftCanceled"));
}

async function saveExpense(event, expenseId) {
  event.preventDefault();
  await runEditModalSave({
    save: () => api(`/api/expenses/${expenseId}`, { method: "PATCH", body: { telegramUserId, expense: collectItem("expense", {}) } }),
    refresh: async () => {
      await loadDashboard();
      await loadHistory();
    },
    close: closeEditModal,
    restore: editModal.restore
  });
  showToast(t("toast.expenseSaved"));
}

async function deleteExpense(expense, button) {
  const confirmation = currentLanguage === "ru"
    ? `Удалить расход "${expense.description}"?`
    : `Delete expense "${expense.description}"?`;
  if (!window.confirm(confirmation)) return;
  button.disabled = true;
  try {
    await runEditModalSave({
      save: () => api(`/api/expenses/${expense.id}`, { method: "DELETE", body: { telegramUserId, language: currentLanguage } }),
      refresh: async () => {
        await loadDashboard();
        await loadHistory();
      },
      close: closeEditModal,
      restore: editModal.restore
    });
    showToast(t("toast.expenseDeleted"));
  } catch (error) {
    button.disabled = false;
    throw error;
  }
}

async function savePlanned(event, {
  mode = "create",
  plannedId = null,
  sourcePlannedExpenseId = null,
  recreateSession = null
} = {}) {
  event.preventDefault();
  if (mode === "recreate") {
    const form = event.currentTarget;
    const submitButton = form.querySelector('button[type="submit"]');
    try {
      await runPlannedRecreate({
        session: recreateSession,
        recreateRequest: async () => {
          submitButton.disabled = true;
          try {
            return await api(`/api/planned-expenses/${sourcePlannedExpenseId}/recreate`, {
              method: "POST",
              body: {
                telegramUserId,
                startsOn: input("planned-starts_on").value,
                plannedExpense: collectPlanned()
              }
            });
          } catch (error) {
            submitButton.disabled = false;
            throw error;
          }
        },
        closeForm: closeAndResetPlannedForm,
        loadDashboard,
        refreshArchive: () => refreshPlannedArchive({ force: true }),
        showCreated: () => showToast(t("toast.plannedRecreated")),
        showRefreshWarning: () => showToast(t("toast.plannedRefreshWarning"))
      });
    } catch (error) {
      if (error.message === "reserve_conflicts_with_planned_change") {
        showToast(t("reserve.plannedChangeError"));
        return;
      }
      showError(error);
    }
    return;
  }

  const method = plannedId ? "PATCH" : "POST";
  const path = plannedId ? `/api/planned-expenses/${plannedId}` : "/api/planned-expenses";
  try {
    const save = () => api(path, { method, body: { telegramUserId, plannedExpense: collectPlanned() } });
    if (plannedId) {
      await runEditModalSave({ save, refresh: loadDashboard, close: closeEditModal, restore: editModal.restore });
    } else {
      await save();
      closeAndResetPlannedForm();
      await loadDashboard();
    }
  } catch (error) {
    if (error.message === "reserve_conflicts_with_planned_change") {
      showToast(t("reserve.plannedChangeError"));
      return;
    }
    throw error;
  }
  showToast(plannedId ? t("toast.plannedSaved") : t("toast.plannedAdded"));
}

function collectItem(prefix, original) {
  return {
    amount: Number(input(`${prefix}-amount`).value),
    currency: input(`${prefix}-currency`).value,
    description: input(`${prefix}-description`).value.trim(),
    category_slug: input(`${prefix}-category_slug`).value,
    budget_impact: input(`${prefix}-budget_impact`)?.value ?? original.budget_impact ?? "regular",
    category_source: "user",
    spent_at: new Date(input(`${prefix}-spent_at`).value).toISOString(),
    tags: input(`${prefix}-tags`).value.split(",").map((tag) => tag.trim()).filter(Boolean),
    confidence: original.confidence ?? 1,
    needs_review: false
  };
}

function collectPlanned() {
  const recurrence = input("planned-recurrence").value;
  const dueDays = parseDueDays(input("planned-due_days")?.value);
  const monthlyDay = input("planned-due_day")?.value ? Number(input("planned-due_day").value) : null;
  return {
    amount: Number(input("planned-amount").value),
    currency: input("planned-currency").value,
    description: input("planned-description").value.trim(),
    category_slug: input("planned-category_slug").value,
    recurrence,
    due_day: recurrence === "monthly" ? monthlyDay : null,
    due_days: recurrence === "twice_monthly" ? dueDays : (monthlyDay ? [monthlyDay] : []),
    weekday: recurrence === "weekly" ? Number(input("planned-weekday").value) : null,
    due_date: recurrence === "one_off" ? input("planned-due_date").value : null,
    tags: input("planned-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean),
    active: true
  };
}

function input(name) {
  return document.querySelector(`[name="${name}"]`);
}

function settingsStateFromUser(user = {}) {
  return {
    monthlyBudgetAmount: Math.round(Number(user.monthly_budget_amount ?? 45000)),
    baseCurrency: user.base_currency ?? "THB",
    displayCurrency: user.display_currency ?? "USD",
    displayCurrencyFollowsBase: user.display_currency_follows_base === true,
    dailyEntryReminderEnabled: user.daily_entry_reminder_enabled !== false,
    interfaceLanguage: user.interface_language === "ru" ? "ru" : "en",
    interfaceTheme: user.interface_theme === "dark" ? "dark" : "light",
    timezone: normalizeSettingsTimeZone(user.timezone),
    usdThbRate: Number(user.usd_thb_rate ?? 32.65)
  };
}

function collectAutosaveSettingsState() {
  const confirmed = settingsSaveQueue.confirmed();
  return {
    monthlyBudgetAmount: Number(confirmed?.monthlyBudgetAmount ?? document.querySelector("#budgetInput")?.value),
    baseCurrency: document.querySelector("#baseCurrencyInput")?.value ?? "THB",
    displayCurrency: document.querySelector("#displayCurrencyInput")?.value ?? "USD",
    displayCurrencyFollowsBase: document.querySelector("#displayCurrencyFollowsBaseInput")?.checked === true,
    dailyEntryReminderEnabled: document.querySelector("#dailyReminderInput")?.checked === true,
    interfaceLanguage: document.querySelector("#interfaceLanguageInput")?.value ?? "en",
    interfaceTheme: document.querySelector("#interfaceThemeInput")?.value ?? "light",
    timezone: document.querySelector("#timezoneInput")?.value ?? "Asia/Bangkok",
    usdThbRate: Number(document.querySelector("#usdThbRateInput")?.value ?? 32.65)
  };
}

function restoreAutosaveControls(settings) {
  if (!settings) return;
  document.querySelector("#baseCurrencyInput").value = settings.baseCurrency;
  document.querySelector("#displayCurrencyInput").value = settings.displayCurrency;
  document.querySelector("#displayCurrencyFollowsBaseInput").checked = settings.displayCurrencyFollowsBase === true;
  applyDisplayCurrencyFollowsBase();
  document.querySelector("#dailyReminderInput").checked = settings.dailyEntryReminderEnabled;
  document.querySelector("#interfaceLanguageInput").value = settings.interfaceLanguage;
  document.querySelector("#interfaceThemeInput").value = settings.interfaceTheme;
  renderTimezoneOptions(settings.timezone);
  applyLanguage(settings.interfaceLanguage);
  applyTheme(settings.interfaceTheme);
}

function applyDisplayCurrencyFollowsBase() {
  const followsBase = document.querySelector("#displayCurrencyFollowsBaseInput")?.checked === true;
  const controls = document.querySelector("#customDisplayCurrencyControls");
  controls?.classList.toggle("hidden", followsBase);
  document.querySelector("#displayCurrencySearch").disabled = followsBase;
  document.querySelector("#displayCurrencyInput").disabled = followsBase;
}

function option(value, selected, label = value) {
  return `<option value="${value}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

function applyLanguage(language) {
  currentLanguage = language === "ru" ? "ru" : "en";
  translate = createTranslator(currentLanguage);
  document.documentElement.lang = currentLanguage;
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    element.setAttribute("placeholder", t(element.dataset.i18nPlaceholder));
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
  });
  document.querySelectorAll("[data-tab]").forEach((button) => {
    const label = button.querySelector(".tab-button__label");
    if (label) label.textContent = t(`screen.${button.dataset.tab}`);
    else button.textContent = t(`screen.${button.dataset.tab}`);
  });
  setOptionalText("#settingsTab h2", t("settings.title"));
  const labels = [
    ["#budgetInput", "settings.monthlyBudget"],
    ["#currentMonthBudgetInput", "settings.currentMonthBudget"],
    ["#baseCurrencyInput", "settings.baseCurrency"],
    ["#displayCurrencyInput", "settings.displayCurrency"],
    ["#interfaceLanguageInput", "settings.interfaceLanguage"],
    ["#interfaceThemeInput", "settings.interfaceTheme"],
    ["#timezoneInput", "settings.timezone"]
  ];
  for (const [selector, key] of labels) {
    const label = document.querySelector(selector)?.closest("label")?.querySelector("span");
    if (label) label.textContent = t(key);
  }
  renderReserveSettings();
  updateHistoryFilterChips();
  if (historyCalendarDraft) renderHistoryCalendar();
  renderHistory(historyState);
  renderHistoryPeriodSummary(historyState);
  renderHistoryAnalytics(historyState);
  renderPlannedArchive();
  rerenderDashboardLanguageState();
}

function rerenderDashboardLanguageState() {
  if (!dashboardState?.snapshot) return;
  const plannedExpenses = dashboardState.plannedExpenses ?? [];
  renderSnapshot(dashboardState.snapshot);
  renderPlannedNotice(plannedExpenses);
  renderAnalytics(
    dashboardState.snapshot,
    dashboardState.analytics ?? {}
  );
  renderTopCategories(dashboardState.topCategories ?? [], dashboardState.snapshot.month);
  renderPlannedMonthSummary(plannedExpenses);
  renderPlannedExpenses(plannedExpenses);
  renderLatest(dashboardState.latestExpenses ?? []);
  renderDashboardInboxDrafts(recoveryState);
  renderInboxDrafts(recoveryState);
}

function applyTheme(theme) {
  currentTheme = theme === "dark" ? "dark" : "light";
  syncMiniAppThemeBackground();
}

function t(key, values = {}) {
  return translate(key, values);
}

function setOptionalText(selector, text) {
  if (text == null) return;
  const element = document.querySelector(selector);
  if (element) element.textContent = text;
}

function recurrenceLabel(item) {
  return plannedRecurrenceLabel(item, (value) => formatDate(value, currentLanguage, userTimeZone()), currentLanguage);
}

function userTimeZone(user = dashboardState?.user) {
  return normalizeSettingsTimeZone(user?.timezone);
}

function weekdayOptions(selected) {
  return plannedWeekdayOptions(selected, option, currentLanguage);
}
function setText(selector, text) {
  document.querySelector(selector).textContent = text;
}

function setHtml(selector, html) {
  document.querySelector(selector).innerHTML = html;
}

function showError(error) {
  document.querySelector("#latestExpenses").innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  showToast(error.message);
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.classList.add("hidden");
  }, 2200);
}


