import test from "node:test";
import assert from "node:assert/strict";

import { createMiniAppLaunchService } from "../src/miniAppLaunchService.js";
import { buildDashboardRequestPath } from "../../miniapp/src/apiClient.js";

test("creates an authenticated startapp user and records entry before onboarding", async () => {
  const calls = [];
  const user = { id: 7, telegram_user_id: 100, onboarding_step: "language", is_new: true };
  const service = createMiniAppLaunchService({
    repository: fakeRepository(calls, { user }),
    now: () => new Date("2026-07-10T10:00:00.000Z")
  });

  const result = await service.loadDashboard({
    auth: verifiedAuth({ startParam: " EXPAT_CM " }),
    timeZone: "Asia/Bangkok"
  });

  assert.deepEqual(result, { onboarding: true, user });
  assert.deepEqual(calls.map((call) => call.name), [
    "upsertTelegramUser",
    "recordAppEvent:miniapp_opened",
    "syncUserTimezone",
    "recordAppEventOnce:onboarding_started"
  ]);
  assert.equal(calls[0].input.acquisitionSource, "expat_cm");
  assert.deepEqual(calls[1].metadata, {
    launchSource: "startapp",
    startParam: "expat_cm"
  });
  assert.equal(calls.some((call) => call.name === "dashboard"), false);
  assert.equal(calls.some((call) => call.name === "recordAppEvent:dashboard_opened"), false);
});

test("new Mini App user schedules a personalized onboarding command menu", async () => {
  const calls = [];
  const deferred = [];
  const syncCalls = [];
  const user = {
    id: 7,
    telegram_user_id: 100,
    interface_language: "ru",
    onboarding_step: "language",
    is_new: true
  };
  const service = createMiniAppLaunchService({
    repository: fakeRepository(calls, { user }),
    syncTelegramCommandMenu: async (input) => syncCalls.push(input)
  });

  await service.loadDashboard({
    auth: verifiedAuth(),
    defer: (operation) => deferred.push(operation)
  });
  assert.equal(syncCalls.length, 0);
  assert.equal(deferred.length, 1);

  await deferred[0]();
  assert.deepEqual(syncCalls, [{
    chatId: 100,
    language: "ru",
    onboardingStep: "language"
  }]);
});

test("repeated onboarding launch relies on singleton insertion without creating a duplicate user", async () => {
  const calls = [];
  const user = { id: 7, telegram_user_id: 100, onboarding_step: "budget_setup", is_new: false };
  const service = createMiniAppLaunchService({ repository: fakeRepository(calls, { user }) });

  const result = await service.loadDashboard({ auth: verifiedAuth() });

  assert.equal(result.onboarding, true);
  assert.equal(calls.filter((call) => call.name === "upsertTelegramUser").length, 1);
  assert.equal(calls.filter((call) => call.name === "recordAppEventOnce:onboarding_started").length, 1);
});

test("loads a completed dashboard and records exactly one ordinary dashboard event", async () => {
  const calls = [];
  const user = { id: 7, telegram_user_id: 100, onboarding_step: "completed", is_new: false };
  const dashboard = { user, snapshot: { remaining: 42 } };
  const service = createMiniAppLaunchService({ repository: fakeRepository(calls, { user, dashboard }) });

  const result = await service.loadDashboard({ auth: verifiedAuth() });

  assert.deepEqual(result, dashboard);
  assert.equal(calls.filter((call) => call.name === "recordAppEvent:dashboard_opened").length, 1);
  assert.deepEqual(
    calls.find((call) => call.name === "recordAppEvent:dashboard_opened").metadata,
    { source: "menu" }
  );
  assert.equal(calls.some((call) => call.name.startsWith("recordAppEventOnce:")), false);
});

test("onboarding preserves miniapp entry ordering instead of deferring it past the singleton event", async () => {
  const calls = [];
  const deferred = [];
  const user = { id: 7, telegram_user_id: 100, onboarding_step: "budget_setup", is_new: false };
  const service = createMiniAppLaunchService({ repository: fakeRepository(calls, { user }) });

  await service.loadDashboard({ auth: verifiedAuth(), defer: (operation) => deferred.push(operation) });

  assert.equal(deferred.length, 0);
  assert.deepEqual(calls.map((call) => call.name), [
    "upsertTelegramUser",
    "recordAppEvent:miniapp_opened",
    "recordAppEventOnce:onboarding_started"
  ]);
});

test("completed dashboard does not wait for launch analytics", async (t) => {
  t.mock.method(console, "warn", () => {});
  const calls = [];
  const analyticsResolvers = [];
  const deferredAnalytics = [];
  const user = { id: 7, telegram_user_id: 100, onboarding_step: "completed", is_new: false };
  const dashboard = { user, snapshot: { remaining: 42 } };
  const repository = fakeRepository(calls, { user, dashboard });
  repository.recordAppEvent = (userId, eventName, metadata) => {
    calls.push({ name: `recordAppEvent:${eventName}`, userId, metadata });
    return new Promise((resolve, reject) => analyticsResolvers.push({ eventName, resolve, reject }));
  };
  const service = createMiniAppLaunchService({ repository });

  const result = await Promise.race([
    service.loadDashboard({
      auth: verifiedAuth(),
      defer: (operation) => deferredAnalytics.push(operation)
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("dashboard waited for analytics")), 30))
  ]);

  assert.deepEqual(result, dashboard);
  assert.equal(analyticsResolvers.length, 0);
  assert.equal(deferredAnalytics.length, 2);
  deferredAnalytics.forEach((operation) => operation());
  assert.deepEqual(
    analyticsResolvers.map((entry) => entry.eventName),
    ["miniapp_opened", "dashboard_opened"]
  );
  analyticsResolvers[0].reject(new Error("analytics unavailable"));
  analyticsResolvers[1].resolve();
  await new Promise((resolve) => setImmediate(resolve));
});

test("records a report click only for a matching successful delivery", async () => {
  const calls = [];
  const user = { id: 7, telegram_user_id: 100, onboarding_step: "completed", is_new: false };
  const dashboard = { user, snapshot: {} };
  const service = createMiniAppLaunchService({
    repository: fakeRepository(calls, { user, dashboard, hasReportDelivery: true })
  });

  await service.loadDashboard({
    auth: verifiedAuth(),
    reportType: "weekly",
    reportKey: "2026-W28"
  });

  assert.deepEqual(calls.find((call) => call.name === "hasReportDelivery").input, {
    userId: 7,
    reportType: "weekly",
    reportKey: "2026-W28"
  });
  assert.deepEqual(calls.find((call) => call.name === "recordAppEvent:report_app_clicked").metadata, {
    reportType: "weekly",
    reportKey: "2026-W28"
  });
  assert.deepEqual(calls.find((call) => call.name === "recordAppEvent:dashboard_opened").metadata, {
    source: "report"
  });
});

test("preserves Mini App report launch markers through the dashboard boundary", async () => {
  const calls = [];
  const user = { id: 7, telegram_user_id: 100, onboarding_step: "completed", is_new: false };
  const service = createMiniAppLaunchService({
    repository: fakeRepository(calls, {
      user,
      dashboard: { user, snapshot: {} },
      hasReportDelivery: true
    })
  });
  const requestUrl = new URL(
    buildDashboardRequestPath(100, "?reportType=weekly&reportKey=2026-W28"),
    "https://miniapp.example"
  );

  await service.loadDashboard({
    auth: verifiedAuth(),
    reportType: requestUrl.searchParams.get("reportType"),
    reportKey: requestUrl.searchParams.get("reportKey")
  });

  assert.deepEqual(calls.find((call) => call.name === "recordAppEvent:report_app_clicked").metadata, {
    reportType: "weekly",
    reportKey: "2026-W28"
  });
  assert.deepEqual(calls.find((call) => call.name === "recordAppEvent:dashboard_opened").metadata, {
    source: "report"
  });
});

test("ignores an unbacked or malformed report marker", async () => {
  for (const input of [
    { reportType: "weekly", reportKey: "2026-W28", hasReportDelivery: false },
    { reportType: "weekly", reportKey: "<bad>", hasReportDelivery: true }
  ]) {
    const calls = [];
    const user = { id: 7, onboarding_step: "completed", is_new: false };
    const service = createMiniAppLaunchService({
      repository: fakeRepository(calls, {
        user,
        dashboard: { user, snapshot: {} },
        hasReportDelivery: input.hasReportDelivery
      })
    });

    await service.loadDashboard({
      auth: verifiedAuth(),
      reportType: input.reportType,
      reportKey: input.reportKey
    });

    assert.equal(calls.some((call) => call.name === "recordAppEvent:report_app_clicked"), false);
    assert.deepEqual(calls.find((call) => call.name === "recordAppEvent:dashboard_opened").metadata, {
      source: "menu"
    });
  }
});

test("rejects unverified identity without repository calls", async () => {
  const calls = [];
  const service = createMiniAppLaunchService({ repository: fakeRepository(calls) });

  await assert.rejects(
    () => service.loadDashboard({
      auth: { telegramUserId: 100, startParam: "expat_cm" }
    }),
    { code: "telegram_init_data_required" }
  );
  assert.deepEqual(calls, []);
});

function verifiedAuth(overrides = {}) {
  return {
    telegramUserId: 100,
    verified: true,
    profile: { id: 100, firstName: "M", username: "mino" },
    startParam: null,
    ...overrides
  };
}

function fakeRepository(calls, options = {}) {
  const user = options.user ?? { id: 7, onboarding_step: "completed", is_new: false };
  return {
    async upsertTelegramUser(input) {
      calls.push({ name: "upsertTelegramUser", input });
      return user;
    },
    async recordAppEvent(userId, eventName, metadata) {
      calls.push({ name: `recordAppEvent:${eventName}`, userId, metadata });
    },
    async recordAppEventOnce(userId, eventName, metadata) {
      calls.push({ name: `recordAppEventOnce:${eventName}`, userId, metadata });
      return { recorded: true };
    },
    async syncUserTimezone(telegramUserId, timeZone) {
      calls.push({ name: "syncUserTimezone", input: { telegramUserId, timeZone } });
    },
    async dashboard(telegramUserId) {
      calls.push({ name: "dashboard", input: { telegramUserId } });
      return options.dashboard ?? { user, snapshot: {} };
    },
    async hasReportDelivery(userId, reportType, reportKey) {
      calls.push({ name: "hasReportDelivery", input: { userId, reportType, reportKey } });
      return options.hasReportDelivery ?? false;
    }
  };
}
