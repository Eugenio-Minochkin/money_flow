# Product Analytics and Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-touch attribution, safe product events, idempotent bot reachability, product `/admin_stats`, and technical `/admin_stats_tech` while preserving existing Money Flow behavior.

**Architecture:** Keep `adminStatsService.js` as a compatibility facade over separate product and technical services. Centralize event/source policy in a pure module, keep user state transitions and first-touch writes in repository SQL, and instrument Telegram, authenticated Mini App, settings, planned expenses, feedback, and reports only after their primary operations succeed.

**Tech Stack:** Node.js ES modules, PostgreSQL migrations and aggregate SQL, Telegram Bot API HTML, Node built-in test runner.

---

## File Map

**Create:**

- `apps/api/migrations/008_product_analytics.sql` — additive user attribution/reachability fields and one-time onboarding-event uniqueness.
- `apps/api/src/productAnalytics.js` — event constants, meaningful-activity set, acquisition normalization, report marker validation, and error-type classification.
- `apps/api/src/miniAppLaunchService.js` — authenticated Mini App user upsert, entry-event ordering, report-click validation, and dashboard/onboarding event decisions.
- `apps/api/src/productStatsService.js` — product aggregates and product report sections.
- `apps/api/src/technicalStatsService.js` — existing technical aggregates and technical report sections.
- `apps/api/test/productAnalytics.test.js` — pure policy tests.
- `apps/api/test/miniAppLaunchService.test.js` — authenticated Mini App launch behavior.
- `apps/api/test/productStatsService.test.js` — product metric and formatting tests.
- `apps/api/test/technicalStatsService.test.js` — extracted technical service regression.

**Modify:**

- `apps/api/src/adminStatsService.js` — compatibility facade and shared chunk/plain-text helpers.
- `apps/api/src/repository.js` — first-touch upsert, one-time events, blocked transitions, report-delivery lookup, and successful mutation events.
- `apps/api/src/telegramAuth.js` — return signed user profile and `start_param`.
- `apps/api/src/apiSecurity.js` — expose verified profile/start parameter to callers.
- `apps/api/src/server.js` — use Mini App launch service and record successful settings/planned/dashboard events.
- `apps/api/src/telegram.js` — `/start` payload/order, onboarding events, incoming unblock, `my_chat_member`, and both admin commands.
- `apps/api/src/reportService.js` — canonical delivery events and blocked transition.
- `apps/api/src/reportKeyboards.js` — bounded report marker parameters.
- `apps/api/test/db.test.js` — migration-ledger recognition.
- `apps/api/test/repository.test.js` — attribution, event uniqueness, transitions, delivery lookup, and privacy regressions.
- `apps/api/test/security.test.js` — signed profile/start parameter verification.
- `apps/api/test/telegram.test.js` — entry ordering, onboarding, blocking, access, output, and unavailable paths.
- `apps/api/test/reportService.test.js` — success/failure event ordering and safe error types.
- `apps/api/test/reportKeyboards.test.js` — safe report URLs.
- `docs/DOMAIN_RULES.md` — exact analytics cohort/timezone semantics.
- `docs/PRODUCT_CONTEXT.md` — admin product-health capability without exposing it as user UI.
- `docs/TESTING_GUIDE.md` — focused suites and analytics invariants.

## Task 1: Add Product Analytics Policy and Migration

**Files:**

- Create: `apps/api/src/productAnalytics.js`
- Create: `apps/api/test/productAnalytics.test.js`
- Create: `apps/api/migrations/008_product_analytics.sql`
- Modify: `apps/api/test/db.test.js`
- Modify: `apps/api/test/repository.test.js`

- [ ] **Step 1: Write failing policy tests**

Add tests that define source normalization, event sets, report marker validation, and safe report error types:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  MEANINGFUL_ACTIVITY_EVENTS,
  normalizeAcquisitionSource,
  normalizeReportMarker,
  reportDeliveryErrorType
} from "../src/productAnalytics.js";

test("normalizes bounded first-touch sources", () => {
  assert.equal(normalizeAcquisitionSource(" Friend_Alex "), "friend_alex");
  assert.equal(normalizeAcquisitionSource("expat-cm"), "expat-cm");
  assert.equal(normalizeAcquisitionSource("name with spaces"), "direct");
  assert.equal(normalizeAcquisitionSource("x".repeat(65)), "direct");
  assert.equal(normalizeAcquisitionSource(null), "direct");
});

test("meaningful activity excludes automatic delivery", () => {
  assert.equal(MEANINGFUL_ACTIVITY_EVENTS.has("expense_saved"), true);
  assert.equal(MEANINGFUL_ACTIVITY_EVENTS.has("planned_expense_created"), true);
  assert.equal(MEANINGFUL_ACTIVITY_EVENTS.has("report_delivered"), false);
  assert.equal(MEANINGFUL_ACTIVITY_EVENTS.has("bot_started"), false);
});

test("accepts only bounded report markers", () => {
  assert.deepEqual(normalizeReportMarker("weekly", "2026-W28"), {
    reportType: "weekly",
    reportKey: "2026-W28"
  });
  assert.deepEqual(normalizeReportMarker("monthly", "2026-07"), {
    reportType: "monthly",
    reportKey: "2026-07"
  });
  assert.equal(normalizeReportMarker("daily", "2026-07-10"), null);
  assert.equal(normalizeReportMarker("weekly", "<b>bad</b>"), null);
});

test("classifies report errors without storing Telegram text", () => {
  assert.equal(reportDeliveryErrorType({ status: 403, message: "Forbidden: bot was blocked by the user" }), "blocked");
  assert.equal(reportDeliveryErrorType({ status: 429 }), "rate_limited");
  assert.equal(reportDeliveryErrorType({ status: 503 }), "telegram_5xx");
  assert.equal(reportDeliveryErrorType({ code: "ETIMEDOUT" }), "network");
  assert.equal(reportDeliveryErrorType(new Error("private detail")), "unknown");
});
```

- [ ] **Step 2: Run the policy tests and verify RED**

Run:

```powershell
node --test apps/api/test/productAnalytics.test.js
```

Expected: FAIL because `productAnalytics.js` does not exist.

- [ ] **Step 3: Implement the pure policy module**

Export frozen event-name collections, `normalizeAcquisitionSource`, `normalizeReportMarker`, and `reportDeliveryErrorType`. Use exact anchored regular expressions:

```js
const SOURCE_PATTERN = /^[a-z0-9_-]{1,64}$/;
const WEEKLY_REPORT_KEY = /^\d{4}-W\d{2}$/;
const MONTHLY_REPORT_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

export function normalizeAcquisitionSource(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return SOURCE_PATTERN.test(normalized) ? normalized : "direct";
}

export function normalizeReportMarker(reportType, reportKey) {
  const type = String(reportType ?? "");
  const key = String(reportKey ?? "");
  const valid = type === "weekly"
    ? WEEKLY_REPORT_KEY.test(key)
    : type === "monthly" && MONTHLY_REPORT_KEY.test(key);
  return valid ? { reportType: type, reportKey: key } : null;
}
```

Classify only confirmed blocked errors as `blocked`; return one of the five approved error types and never return the source message.

- [ ] **Step 4: Run the policy tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Write failing migration contract tests**

Read `008_product_analytics.sql` in `repository.test.js` and assert the four columns, the partial unique predicate, and absence of update/backfill SQL. Extend `db.test.js` to expect migration `008_product_analytics.sql` after `007_account_deletion.sql`.

For actual index behavior, extend the existing disposable PostgreSQL integration path with inserts proving:

```sql
INSERT INTO app_events (user_id, event_name) VALUES (1, 'onboarding_started');
INSERT INTO app_events (user_id, event_name) VALUES (1, 'currency_selected');
INSERT INTO app_events (user_id, event_name) VALUES (1, 'bot_started'), (1, 'bot_started');
```

succeeds, while a raw duplicate `onboarding_started` conflicts and the repository `ON CONFLICT DO NOTHING` path returns without error.

- [ ] **Step 6: Run migration tests and verify RED**

Run:

```powershell
node --test apps/api/test/db.test.js apps/api/test/repository.test.js
```

Expected: FAIL because migration 008 is absent.

- [ ] **Step 7: Add migration 008**

Create additive SQL with `ADD COLUMN IF NOT EXISTS` and the exact partial unique index predicate approved in the design. Do not update existing rows and do not edit `001_initial.sql`.

- [ ] **Step 8: Run migration tests and verify GREEN**

Run the command from Step 6. Expected: PASS.

- [ ] **Step 9: Commit Task 1**

```powershell
git add apps/api/src/productAnalytics.js apps/api/test/productAnalytics.test.js apps/api/migrations/008_product_analytics.sql apps/api/test/db.test.js apps/api/test/repository.test.js
git commit -m "Add product analytics schema and policy"
```

## Task 2: Implement Atomic First-touch User Upsert and One-time Events

**Files:**

- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/test/repository.test.js`

- [ ] **Step 1: Write failing repository tests**

Cover these contracts with the existing fake-pool query recorder:

```js
test("upsertTelegramUser sets first-touch once and refreshes profile", async () => {
  const calls = [];
  const repo = createRepository(fakePool((sql, params) => {
    calls.push({ sql: String(sql), params });
    return { rows: [{ id: 7, telegram_user_id: 100, acquisition_source: "friend_alex", is_new: false }] };
  }));

  await repo.upsertTelegramUser({
    id: 100,
    firstName: "New name",
    username: "new_user",
    acquisitionSource: "expat_cm",
    acquisitionSeenAt: new Date("2026-07-10T10:00:00Z")
  });

  assert.match(calls[0].sql, /acquisition_source = COALESCE\(users\.acquisition_source, EXCLUDED\.acquisition_source\)/);
  assert.match(calls[0].sql, /acquisition_first_seen_at = COALESCE/);
  assert.equal(calls[0].params.includes("expat_cm"), true);
});
```

Add a concurrency-oriented assertion that two upsert calls use the same atomic statement and never perform a preliminary `SELECT` followed by an attribution `UPDATE`.

Add tests for:

- `recordAppEventOnce(userId, eventName, metadata)` emits `ON CONFLICT DO NOTHING` only for approved onboarding events.
- a non-onboarding event is rejected by `recordAppEventOnce` with controlled code `invalid_singleton_event`.
- existing `recordAppEvent` remains best-effort.

- [ ] **Step 2: Run repository tests and verify RED**

```powershell
node --test apps/api/test/repository.test.js
```

Expected: FAIL on missing attribution SQL and `recordAppEventOnce`.

- [ ] **Step 3: Implement the atomic upsert**

Import `normalizeAcquisitionSource` and update `upsertTelegramUser(profile)` so one `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` statement:

- creates at `onboarding_step = 'language'`;
- stores normalized acquisition source and first-seen time on insert;
- refreshes `first_name` and `username` on conflict;
- uses `COALESCE` for both attribution fields;
- returns `is_new`.

Use `profile.acquisitionSource` only after callers have established a valid entry. The repository still normalizes defensively.

- [ ] **Step 4: Implement singleton event insertion**

Add:

```js
async recordAppEventOnce(userId, eventName, metadata = {})
```

Validate `eventName` against the four singleton events and execute:

```sql
INSERT INTO app_events (user_id, event_name, metadata)
VALUES ($1, $2, $3::jsonb)
ON CONFLICT DO NOTHING
```

Catch and safely log DB errors using the same best-effort contract as `recordAppEvent`.

- [ ] **Step 5: Run repository tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```powershell
git add apps/api/src/repository.js apps/api/test/repository.test.js
git commit -m "Add atomic first-touch user upsert"
```

## Task 3: Return Verified Mini App Profile and Build the Launch Boundary

**Files:**

- Modify: `apps/api/src/telegramAuth.js`
- Modify: `apps/api/src/apiSecurity.js`
- Create: `apps/api/src/miniAppLaunchService.js`
- Modify: `apps/api/test/security.test.js`
- Create: `apps/api/test/miniAppLaunchService.test.js`

- [ ] **Step 1: Write failing signed-auth tests**

Extend the existing initData signing helper so valid data includes:

```text
user={"id":100,"first_name":"M","username":"mino"}
start_param=expat_cm
```

Assert:

```js
assert.deepEqual(result.profile, {
  id: 100,
  firstName: "M",
  username: "mino"
});
assert.equal(result.startParam, "expat_cm");
```

Assert tampered, expired, or unsigned values return no profile/start parameter.

- [ ] **Step 2: Run security tests and verify RED**

```powershell
node --test apps/api/test/security.test.js
```

Expected: FAIL because auth currently returns only `telegramUserId`.

- [ ] **Step 3: Implement verified profile extraction**

In `verifyTelegramInitData`, parse the signed `user` JSON after hash/age validation and return:

```js
{
  ok: true,
  telegramUserId: Number(user.id),
  profile: {
    id: Number(user.id),
    firstName: typeof user.first_name === "string" ? user.first_name : null,
    username: typeof user.username === "string" ? user.username : null
  },
  startParam: params.get("start_param")
}
```

Update both API security resolvers to forward these verified fields. Query/body identity remains allowed only under the existing development policy and never carries a verified profile or start parameter.

- [ ] **Step 4: Run security tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Write failing Mini App launch service tests**

Use a fake repository to assert:

- verified first launch upserts the user with source, records `miniapp_opened` before `onboarding_started`, and returns onboarding state without `dashboard_opened`;
- repeat launch does not create a second user or singleton event;
- existing completed user creates `miniapp_opened` then exactly one `dashboard_opened`;
- valid report marker requires `hasReportDelivery` and creates one click plus one report dashboard event;
- unverified auth returns controlled `telegram_init_data_required` and makes zero repository calls.

- [ ] **Step 6: Run launch-service tests and verify RED**

```powershell
node --test apps/api/test/miniAppLaunchService.test.js
```

Expected: FAIL because the service does not exist.

- [ ] **Step 7: Implement `createMiniAppLaunchService`**

Expose:

```js
createMiniAppLaunchService({ repository, now }).loadDashboard({ auth, reportType, reportKey, timeZone })
```

Reject auth objects without a verified `profile`. Upsert with normalized signed `startParam`, record `miniapp_opened`, synchronize timezone, and branch:

- new/onboarding user: return `{ onboarding: true, user }`, then singleton `onboarding_started`, with no dashboard event;
- completed user: load `repository.dashboard`, validate a report marker and delivery when present, then record the click and one dashboard event.

All event calls remain best-effort.

- [ ] **Step 8: Run launch-service tests and verify GREEN**

Run the command from Step 6. Expected: PASS.

- [ ] **Step 9: Commit Task 3**

```powershell
git add apps/api/src/telegramAuth.js apps/api/src/apiSecurity.js apps/api/src/miniAppLaunchService.js apps/api/test/security.test.js apps/api/test/miniAppLaunchService.test.js
git commit -m "Add authenticated Mini App entry flow"
```

## Task 4: Wire Mini App Dashboard and Product Mutations

**Files:**

- Modify: `apps/api/src/server.js`
- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/test/miniAppLaunchService.test.js`
- Modify: `apps/api/test/repository.test.js`
- Modify: `apps/miniapp/test/smokeAssets.test.js`

- [ ] **Step 1: Write failing route-contract and repository-event tests**

Assert server construction injects `miniAppLaunchService` and `/api/dashboard` uses its verified path when initData exists. Preserve the current development query-ID path only for existing users; it must not create users, attribution, or launch events.

Add repository tests proving successful mutation methods emit safe events after the mutation:

- `updateMonthlyBudget` and relevant settings paths: `budget_changed` without amount.
- base/display currency change: `currency_changed` with currency code only.
- planned create/update/deactivate: corresponding event without description or amount.
- `createFeedback`: `feedback_sent` with source only and no feedback text.

Assert failed mutations do not emit events.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
node --test apps/api/test/miniAppLaunchService.test.js apps/api/test/repository.test.js apps/miniapp/test/smokeAssets.test.js
```

Expected: FAIL on missing route wiring and mutation events.

- [ ] **Step 3: Wire the dashboard route**

Construct the launch service beside the other services in `server.js`. For a verified request, call it with signed auth and bounded report query parameters. Return onboarding state for new users instead of `404`; return the existing dashboard shape for completed users.

Do not allow unsigned `startParam`, `reportType`, or `reportKey` to create events. The report marker is navigation metadata only and never acquisition.

- [ ] **Step 4: Add successful mutation instrumentation**

Use a small repository helper that records events after successful SQL returns. For settings payloads, compare previous and returned user values so unchanged settings do not create false changes. Keep budget top-ups distinct from `budget_changed`.

For feedback, store the feedback row first and then record:

```js
await this.recordAppEvent(input.userId, "feedback_sent", {
  source: input.source === "bot" ? "telegram" : "miniapp"
});
```

Never pass the feedback message.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```powershell
git add apps/api/src/server.js apps/api/src/repository.js apps/api/test/miniAppLaunchService.test.js apps/api/test/repository.test.js apps/miniapp/test/smokeAssets.test.js
git commit -m "Record authenticated product activity"
```

## Task 5: Instrument Telegram Entry and Onboarding in the Correct Order

**Files:**

- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/src/telegramCommands.js`
- Modify: `apps/api/test/telegram.test.js`
- Modify: `apps/api/test/telegramCommands.test.js`

- [ ] **Step 1: Write failing `/start` and onboarding tests**

Add tests for:

- `/start friend_alex` preserves the payload through command parsing;
- new user call order is `upsertTelegramUser`, `bot_started`, onboarding response, `onboarding_started`;
- repeat `/start expat_cm` refreshes profile but the fake repository keeps the original source;
- no-source `/start` passes `direct`;
- initial currency and budget saves record singleton `currency_selected` and `budget_set` only after successful persistence;
- completion records `onboarding_completed` once;
- later settings use changed events, not singleton onboarding events;
- event write failures do not alter the Telegram response.

Use an ordered `calls` array rather than asserting only final event presence.

- [ ] **Step 2: Run Telegram tests and verify RED**

```powershell
node --test apps/api/test/telegramCommands.test.js apps/api/test/telegram.test.js
```

Expected: FAIL because command normalization currently reduces `/start payload` to `/start` without exposing the payload and no start events exist.

- [ ] **Step 3: Add start-command parsing**

Expose a parser returning:

```js
{ command: "/start", payload: "friend_alex" }
```

while preserving existing bot-mention normalization such as `/start@MoneyFlowBot friend_alex`.

- [ ] **Step 4: Reorder Telegram entry**

Parse raw input before upsert so `/start` can supply acquisition. Upsert the user, clear stale blocked state, then for `/start` record `bot_started` before sending onboarding. After a successful first onboarding response, call `recordAppEventOnce(..., "onboarding_started")`.

Non-start incoming messages use `direct` only when the legacy user's attribution is still null, as required by the repository `COALESCE` contract.

- [ ] **Step 5: Instrument onboarding transitions**

After each existing repository save succeeds, insert the matching singleton event. Record completion only after a real transition to `completed`. Metadata for `budget_set` contains currency and `budgetType: "monthly"`, never the amount.

- [ ] **Step 6: Run Telegram tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 7: Commit Task 5**

```powershell
git add apps/api/src/telegram.js apps/api/src/telegramCommands.js apps/api/test/telegram.test.js apps/api/test/telegramCommands.test.js
git commit -m "Track Telegram entry and onboarding"
```

## Task 6: Add Idempotent Bot Reachability Transitions

**Files:**

- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/test/repository.test.js`
- Modify: `apps/api/test/telegram.test.js`

- [ ] **Step 1: Write failing repository transition tests**

Define:

```js
setUserBotBlocked(userId, { blocked, source, now })
clearTelegramUserBotBlocked(telegramUserId, { source, now })
```

Tests assert conditional SQL updates only the opposite state, timestamps the transition, returns `{ changed: false }` on repeats/unknown users, and inserts an event only when `changed` is true.

Assert timeout, 429, 5xx, and generic errors are not classified as blocked.

- [ ] **Step 2: Run repository tests and verify RED**

```powershell
node --test apps/api/test/repository.test.js
```

Expected: FAIL on missing transition methods.

- [ ] **Step 3: Implement transitions**

Use `UPDATE ... WHERE bot_blocked IS DISTINCT FROM $blocked RETURNING id`. On block set `bot_blocked_at`; on unblock set `bot_unblocked_at`. Record safe metadata `{ source }` after the state update.

Retain `markUserBotBlocked` as a compatibility wrapper for existing report/release code until all call sites are migrated.

- [ ] **Step 4: Run repository tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Write failing Telegram transition tests**

Cover private `my_chat_member` block/unblock, repeated state, group/channel ignore, unknown-user ignore, incoming-message recovery before command routing, and event-source values.

- [ ] **Step 6: Run Telegram tests and verify RED**

```powershell
node --test apps/api/test/telegram.test.js
```

Expected: FAIL because `my_chat_member` is not handled.

- [ ] **Step 7: Wire Telegram transitions**

Handle `update.my_chat_member` before message/callback routing. Accept only `chat.type === "private"`. Map inaccessible statuses to blocked and accessible statuses to unblocked, then call the repository transition. For messages, upsert first and clear a stale blocked flag before routing any command or expense flow.

- [ ] **Step 8: Run Telegram tests and verify GREEN**

Run the command from Step 6. Expected: PASS.

- [ ] **Step 9: Commit Task 6**

```powershell
git add apps/api/src/repository.js apps/api/src/telegram.js apps/api/test/repository.test.js apps/api/test/telegram.test.js
git commit -m "Track bot reachability transitions"
```

## Task 7: Canonicalize Report Delivery and Click Events

**Files:**

- Modify: `apps/api/src/reportService.js`
- Modify: `apps/api/src/reportKeyboards.js`
- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/test/reportService.test.js`
- Modify: `apps/api/test/reportKeyboards.test.js`
- Modify: `apps/api/test/repository.test.js`

- [ ] **Step 1: Write failing report tests**

Assert exact ordered success calls:

```text
sendMessage -> markReportDeliverySent -> recordAppEvent(report_delivered)
```

Assert exact ordered failure calls:

```text
markReportDeliveryFailed -> recordAppEvent(report_delivery_failed) -> optional blocked transition
```

Verify metadata is exactly `reportType`, `reportKey`, and allowlisted `errorType` for failure. Assert event-write failure never retries send.

Update keyboard expectations to include only bounded report marker fields in the Open button URL.

- [ ] **Step 2: Run report tests and verify RED**

```powershell
node --test apps/api/test/reportService.test.js apps/api/test/reportKeyboards.test.js apps/api/test/repository.test.js
```

Expected: FAIL because current code emits `weekly_report_sent`/`monthly_report_sent` and unvalidated URLs.

- [ ] **Step 3: Add delivery lookup**

Implement:

```js
hasReportDelivery(userId, reportType, reportKey)
```

as `SELECT EXISTS` over successful delivery state for that exact user/type/key. This is used by `miniAppLaunchService` before recording `report_app_clicked`.

- [ ] **Step 4: Replace report event names and ordering**

After successful delivery persistence, record `report_delivered`. After failure persistence, record `report_delivery_failed` using `reportDeliveryErrorType(error)`. Call the shared blocked transition only for `blocked`.

Keep existing generated/skipped events if they serve diagnostics, but do not count them as product activity.

- [ ] **Step 5: Add bounded report markers to keyboards**

Use `URL`/`URLSearchParams` rather than string concatenation. Include `launchSource=report`, `reportType`, and `reportKey`; preserve the existing history view parameters. Do not include source acquisition parameters.

- [ ] **Step 6: Run report tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 7: Commit Task 7**

```powershell
git add apps/api/src/reportService.js apps/api/src/reportKeyboards.js apps/api/src/repository.js apps/api/test/reportService.test.js apps/api/test/reportKeyboards.test.js apps/api/test/repository.test.js
git commit -m "Record canonical report analytics"
```

## Task 8: Extract Technical Stats and Preserve the Facade

**Files:**

- Create: `apps/api/src/technicalStatsService.js`
- Create: `apps/api/test/technicalStatsService.test.js`
- Modify: `apps/api/src/adminStatsService.js`
- Modify: `apps/api/test/adminStatsService.test.js`
- Modify: `apps/api/test/adminStatsProcessingDiagnostics.test.js`

- [ ] **Step 1: Add failing compatibility tests**

Assert the facade exposes both methods, `getAdminStats()` delegates only to product service, and `getTechnicalStats()` delegates only to technical service. Assert a failure in one does not invoke the other.

Copy current technical output expectations into `technicalStatsService.test.js` and remove Last-30-days expectations from the technical path.

- [ ] **Step 2: Run admin stats tests and verify RED**

```powershell
node --test apps/api/test/adminStatsService.test.js apps/api/test/adminStatsProcessingDiagnostics.test.js apps/api/test/technicalStatsService.test.js
```

Expected: FAIL because the technical module and method do not exist.

- [ ] **Step 3: Move existing diagnostics mechanically**

Move the current `periodStats`, event aggregation, historical fallback, diagnostic formatting, and helpers into `technicalStatsService.js`. Preserve calculations and names. Change only the period list to Today and Last 7 days and expose:

```js
createTechnicalStatsService({ pool, now })
formatTechnicalStatsSections(stats)
```

Do not add API/webhook or scheduler rows.

- [ ] **Step 4: Implement the facade**

`createAdminStatsService({ pool, now })` constructs both services and exposes separate methods. Permit injected `productStatsService` and `technicalStatsService` in tests so dependency isolation is explicit.

- [ ] **Step 5: Run admin stats tests and verify GREEN**

Run the command from Step 2. Expected: PASS with existing diagnostic coverage preserved.

- [ ] **Step 6: Commit Task 8**

```powershell
git add apps/api/src/adminStatsService.js apps/api/src/technicalStatsService.js apps/api/test/adminStatsService.test.js apps/api/test/adminStatsProcessingDiagnostics.test.js apps/api/test/technicalStatsService.test.js
git commit -m "Separate technical admin statistics"
```

## Task 9: Implement Product Aggregations

**Files:**

- Create: `apps/api/src/productStatsService.js`
- Create: `apps/api/test/productStatsService.test.js`
- Modify: `apps/api/src/adminStatsService.js`

- [ ] **Step 1: Write failing period and user-base tests**

Use a deterministic fake pool returning named query fixtures. Assert:

- Today uses existing local-day bounds; Last 3/7/30 are rolling.
- reachable and blocked use the current users table.
- deleted counts anonymous `account_deleted` events.
- all-time joined is the sum.
- active users use only the meaningful event list.
- report delivery does not make a user active.
- distinct-day thresholds and divide-by-zero behavior are correct.

- [ ] **Step 2: Run product tests and verify RED**

```powershell
node --test apps/api/test/productStatsService.test.js
```

Expected: FAIL because the product service does not exist.

- [ ] **Step 3: Implement grouped period queries**

Expose:

```js
createProductStatsService({ pool, now }).getProductStats()
```

Build a `periods` values CTE for Today/3/7/30 so event metrics are grouped by period label in one query. Use the centralized meaningful-event list as a query parameter array. Keep existing expense/draft historical fallback only where required for legacy continuity.

- [ ] **Step 4: Run period tests and verify GREEN**

Run the command from Step 2. Expected: period and user-base tests PASS.

- [ ] **Step 5: Write failing funnel, retention, habit, report, and source tests**

Fixtures must prove:

- a legacy user created before the 30-day boundary but newly pressing `/start` is excluded;
- a current user with both entry events counts once;
- all steps occur after `first_started_at`;
- activation is `expense_saved`;
- median uses percentile 0.5;
- too-new D1/D7 users are absent from denominators;
- automatic report delivery is not return activity;
- habit requires two local dates using current `users.timezone`;
- repeated report clicks do not inflate CTR;
- source order, top five, `other`, and `unknown` are deterministic.

- [ ] **Step 6: Run product tests and verify RED**

Run the command from Step 2. Expected: FAIL on missing cohort aggregates.

- [ ] **Step 7: Implement cohort CTEs and report/source aggregates**

Anchor cohort membership with `users.created_at >= $cohortStart`. Derive `first_started_at` from entry events constrained to `created_at >= users.created_at`. Use `COUNT(DISTINCT user_id)`, filtered aggregates, `PERCENTILE_CONT(0.5)`, and per-user timezone local-date conversion for habit.

Return `null` for ratios with no eligible denominator so the formatter renders `—`.

- [ ] **Step 8: Add Last-7-days Health**

Reuse the technical aggregate helper for parse/transcription/P95 data without requesting Last 30 days. Keep product and technical service failures independent at the facade boundary.

- [ ] **Step 9: Run product tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 10: Commit Task 9**

```powershell
git add apps/api/src/productStatsService.js apps/api/test/productStatsService.test.js apps/api/src/adminStatsService.js
git commit -m "Add product analytics aggregates"
```

## Task 10: Format and Route Both Admin Commands Safely

**Files:**

- Modify: `apps/api/src/adminStatsService.js`
- Modify: `apps/api/src/productStatsService.js`
- Modify: `apps/api/src/technicalStatsService.js`
- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/test/productStatsService.test.js`
- Modify: `apps/api/test/technicalStatsService.test.js`
- Modify: `apps/api/test/telegram.test.js`

- [ ] **Step 1: Write failing formatter tests**

Assert required headings, `First expense saved`, `—` for absent cohorts, escaped sources/rejects/shadow fields, and balanced `<b>`/`<code>` tags.

Create a long fixture and assert every returned chunk:

```js
for (const chunk of chunks) {
  assert.ok(chunk.html.length <= 3900);
  assert.equal(openTagCount(chunk.html, "b"), closeTagCount(chunk.html, "b"));
  assert.equal(openTagCount(chunk.html, "code"), closeTagCount(chunk.html, "code"));
  assert.ok(chunk.plainText.length > 0);
}
```

Assert no source, reject, or shadow-field row is split between chunks.

- [ ] **Step 2: Run formatter tests and verify RED**

```powershell
node --test apps/api/test/productStatsService.test.js apps/api/test/technicalStatsService.test.js
```

Expected: FAIL because section/chunk formatters are absent.

- [ ] **Step 3: Implement section formatters and chunker**

Each service returns whole logical sections. Add shared helpers in the facade:

```js
formatAdminMessageParts(sections, { maxLength: 3900 })
escapeTelegramHtml(value)
stripAllowedTelegramHtml(value)
```

Never split inside a section unless that single section exceeds 3900; for bounded Sources/Rejects/Shadow fields, split only between complete rows while repeating the section heading. Generate plain text from the same section model rather than from a failed Telegram response.

- [ ] **Step 4: Run formatter tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Write failing command tests**

Cover admin access to both commands, non-admin denial, `/admin_stats@MoneyFlowBot`, `/admin_stats_tech@MoneyFlowBot`, separate dependency absence, separate thrown-error responses, HTML parse mode, multi-part sends, and fallback plain text per part.

- [ ] **Step 6: Run Telegram tests and verify RED**

```powershell
node --test apps/api/test/telegram.test.js
```

Expected: FAIL because `/admin_stats_tech` and new unavailable strings are missing.

- [ ] **Step 7: Route both commands**

Refactor the duplicated access check into a local admin-stats command helper without changing the safe denial log. `/admin_stats` calls `getAdminStats`; `/admin_stats_tech` calls `getTechnicalStats`. Send each formatted part in order with HTML and its own plain fallback.

Use exact unavailable responses:

```text
Product stats unavailable
Technical stats unavailable
```

- [ ] **Step 8: Run Telegram tests and verify GREEN**

Run the command from Step 6. Expected: PASS.

- [ ] **Step 9: Commit Task 10**

```powershell
git add apps/api/src/adminStatsService.js apps/api/src/productStatsService.js apps/api/src/technicalStatsService.js apps/api/src/telegram.js apps/api/test/productStatsService.test.js apps/api/test/technicalStatsService.test.js apps/api/test/telegram.test.js
git commit -m "Split product and technical admin reports"
```

## Task 11: Synchronize Documentation and Add Contract Regressions

**Files:**

- Modify: `docs/DOMAIN_RULES.md`
- Modify: `docs/PRODUCT_CONTEXT.md`
- Modify: `docs/TESTING_GUIDE.md`
- Modify: `test/deploymentWorkflow.test.js`

- [ ] **Step 1: Write failing documentation contract tests**

Add narrow checks that documentation contains:

- `users.created_at` cohort anchor;
- activation as first `expense_saved`;
- D1 `[24h, 48h)` and D7 `[6d, 8d)`;
- current `users.timezone` habit grouping;
- no source backfill and deleted-user limitation;
- user release notes exclude internal SQL/index/taxonomy details.

- [ ] **Step 2: Run contract tests and verify RED**

```powershell
node --test test/deploymentWorkflow.test.js
```

Expected: FAIL because the durable docs are not yet synchronized.

- [ ] **Step 3: Update durable docs**

Add concise product/domain/testing sections matching the approved design. Do not duplicate the full design spec. Keep admin analytics out of the end-user dashboard description and preserve existing budget/report semantics.

- [ ] **Step 4: Run contract tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Commit Task 11**

```powershell
git add docs/DOMAIN_RULES.md docs/PRODUCT_CONTEXT.md docs/TESTING_GUIDE.md test/deploymentWorkflow.test.js
git commit -m "Document product analytics contracts"
```

## Task 12: Full Verification, Output Evidence, and Draft PR

**Files:**

- Modify if required by verified failures: only files already listed in this plan
- Create outside git: `C:\tmp\money-flow-product-analytics-pr.md` for the verified PR body

- [ ] **Step 1: Run all focused suites**

```powershell
node --test apps/api/test/productAnalytics.test.js apps/api/test/security.test.js apps/api/test/miniAppLaunchService.test.js apps/api/test/repository.test.js
node --test apps/api/test/reportService.test.js apps/api/test/reportKeyboards.test.js apps/api/test/telegram.test.js
node --test apps/api/test/adminStatsService.test.js apps/api/test/adminStatsProcessingDiagnostics.test.js apps/api/test/productStatsService.test.js apps/api/test/technicalStatsService.test.js
node --test apps/api/test/db.test.js test/deploymentWorkflow.test.js
```

Expected: all PASS with no warnings that indicate event-data leakage or unhandled failures.

- [ ] **Step 2: Run the full suite**

```powershell
npm.cmd test
```

Expected: exit code 0.

- [ ] **Step 3: Run final repository checks**

```powershell
git diff --check
git status --short
git diff --stat master...HEAD
```

Expected: no whitespace errors and only planned files changed.

- [ ] **Step 4: Capture safe real output examples**

Generate both formatters from test/local fixture data. Include the actual redacted HTML output and lengths in the PR body. Confirm every message part is at most 3900 characters and contains no Telegram IDs, usernames, financial values from real users, message text, feedback text, initData, or tokens.

- [ ] **Step 5: Prepare the PR body**

Include:

```markdown
## Summary
- Separates product and technical Telegram admin statistics.
- Adds first-touch Telegram/Mini App attribution and safe product events.
- Tracks bot reachability and report engagement idempotently.

## Changed Areas
- API analytics services and repository
- Telegram and authenticated Mini App entry flows
- Report delivery/click instrumentation
- Migration 008 and regression tests
- Product/domain/testing documentation

## Docs Checked/Updated
- CONTEXT.md
- docs/DECISIONS.md
- docs/DOMAIN_RULES.md
- docs/PRODUCT_CONTEXT.md
- docs/TESTING_GUIDE.md
- approved design and implementation plan

## Tests Run
- focused commands with exact results
- npm.cmd test
- git diff --check

## DB / Production Impact
- Adds nullable attribution/reachability columns and one partial unique event index.
- No backfill, production command, database write, deployment, or rollback was run.
- Rollback strategy is a reviewed forward-fix; automatic column/index removal is not included.

## Known Limitations
- Legacy source remains unknown until a valid new entry.
- Deleted-user attribution/funnel history is intentionally unrecoverable.
- Habit uses the user's current timezone for historical event grouping.
- API/webhook and scheduler error rows are omitted until safe aggregate events exist.

## User Release Notes
audience: user
version: v.1.20
category: reliability

- Admin product statistics now separate growth and engagement from technical diagnostics.
- Mini App campaign links can safely start onboarding for a new user.
```

The plan uses `v.1.20` because the current repository contract examples end at `v.1.19`. If another PR claims `v.1.20` before publication, update this single version field to the next free sequential version and rerun the release-note contract test. Do not mention service extraction, SQL, indexes, or internal event taxonomy in the user release note bullets.

- [ ] **Step 6: Commit any final verified corrections**

If verification required a correction, rerun its focused test red-green and commit only that correction. If no correction was required, do not create an empty commit.

- [ ] **Step 7: Push and open a draft PR**

```powershell
git push -u origin codex/product-analytics-design
gh pr create --draft --base master --head codex/product-analytics-design --title "Add product analytics and attribution" --body-file C:\tmp\money-flow-product-analytics-pr.md
```

Stop after the draft PR is open. Do not merge, deploy, run production migrations, access production, or modify persistent data.

## Plan Self-review

- Every approved design section maps to a task.
- Entry ordering explicitly records `bot_started`/`miniapp_opened` before `onboarding_started`.
- Onboarding-only Mini App responses explicitly omit `dashboard_opened`.
- First-touch writes are atomic and event writes remain best-effort.
- Funnel/retention/habit use `users.created_at` cohort membership.
- Account deletion stays exactly `{ source }` with `user_id = NULL` inside the existing transaction.
- Technical error rows without safe events remain omitted.
- Migration behavior, message chunks, plain fallback, privacy, and full regression are explicitly verified.
