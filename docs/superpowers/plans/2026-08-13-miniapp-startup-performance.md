# Mini App Startup Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Mini App startup measurable and remove confirmed app-controlled latency from the Dashboard critical path without weakening reserve, financial-month, authentication, or analytics semantics.

**Architecture:** Add one privacy-safe request timing collector that flows from the `/api/dashboard` route through launch service and repository phases and emits `Server-Timing` plus one thresholded structured warning. Keep reserve reconciliation and locks unchanged until measurements justify a separate lock strategy; independently remove already-proven waits by making launch analytics best-effort after the response boundary, loading History only when its tab is opened, acknowledging Telegram from a tiny classic bootstrap, and serving version-aware cache headers.

**Tech Stack:** Node.js HTTP server and test runner, PostgreSQL repository, browser-native ES modules, Telegram WebApp SDK, `performance.mark/measure`.

---

### Task 1: Lock startup contracts with failing tests

**Files:**
- Modify: `apps/api/test/miniAppLaunchService.test.js`
- Create: `apps/api/test/startupTiming.test.js`
- Create: `apps/api/test/httpStatic.test.js`
- Modify: `apps/miniapp/test/smokeAssets.test.js`

- [ ] **Step 1: Add a delayed analytics regression**

Assert that a completed `loadDashboard()` resolves before intentionally unresolved `miniapp_opened` and `dashboard_opened` event writes, while both writes are eventually attempted and rejected writes are contained.

- [ ] **Step 2: Add timing collector contracts**

Assert stable, rounded, sanitized `Server-Timing` names; phase accumulation; total duration; and a single slow-request record without Telegram IDs, init data, tokens, or user payload.

- [ ] **Step 3: Add static cache contracts**

Serve temporary HTML, versioned JS/CSS, and unversioned module files through `createStaticHandler()` and assert HTML uses `no-cache`, explicit `?v=` assets use long-lived immutable caching, unversioned modules revalidate, and conditional ETag requests return `304`.

- [ ] **Step 4: Add frontend startup structure contracts**

Assert that `index.html` marks HTML start, records Telegram SDK availability, invokes a single early `WebApp.ready()/expand()` bootstrap before `app.js`, and that ordinary Dashboard startup does not request History until the History tab is selected.

- [ ] **Step 5: Run RED**

Run: `npm.cmd test -- apps/api/test/miniAppLaunchService.test.js apps/api/test/startupTiming.test.js apps/api/test/httpStatic.test.js apps/miniapp/test/smokeAssets.test.js`

Expected: new assertions fail because non-blocking analytics, timing collector, cache policy, early bootstrap, and lazy History are absent.

### Task 2: Instrument `/api/dashboard` and repository phases

**Files:**
- Create: `apps/api/src/startupTiming.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/src/miniAppLaunchService.js`
- Modify: `apps/api/src/repository.js`
- Test: `apps/api/test/startupTiming.test.js`
- Test: `apps/api/test/miniAppLaunchService.test.js`

- [ ] **Step 1: Implement a request-scoped timing collector**

Expose `measure(name, operation)`, `add(name, milliseconds)`, `serverTiming()`, and `finish()` with a monotonic injected clock. Allow only known phase labels and rounded non-negative durations.

- [ ] **Step 2: Time verified launch phases**

Measure auth, user upsert, report marker lookup, timezone synchronization, repository Dashboard, and scheduled post-Dashboard events without changing the response JSON.

- [ ] **Step 3: Time repository Dashboard phases**

Measure reserve reconciliation, advisory lock wait, reserve reads, budget/totals/baseline, planned/paid planned, snapshot, latest expenses, top categories, and Dashboard analytics. Preserve current ordering wherever a later calculation depends on an earlier value.

- [ ] **Step 4: Emit response and slow-request telemetry**

Set `Server-Timing` before `sendJson()`. Emit one structured warning only above the configured default threshold, containing route/status and aggregate phase durations but no user data.

- [ ] **Step 5: Run GREEN**

Run: `npm.cmd test -- apps/api/test/startupTiming.test.js apps/api/test/miniAppLaunchService.test.js apps/api/test/repository.test.js`

Expected: all selected tests pass and existing Dashboard values remain unchanged.

### Task 3: Remove confirmed waits from the critical path

**Files:**
- Modify: `apps/api/src/miniAppLaunchService.js`
- Modify: `apps/miniapp/src/app.js`
- Modify: `apps/miniapp/test/smokeAssets.test.js`
- Test: `apps/api/test/miniAppLaunchService.test.js`

- [ ] **Step 1: Schedule launch analytics best-effort**

Start `miniapp_opened`, optional `report_app_clicked`, and `dashboard_opened` writes without awaiting them. Keep onboarding singleton event semantics awaited because it is a durable once-only transition, and attach rejection handling immediately.

- [ ] **Step 2: Make History lazy and race-safe**

Remove `loadHistory()` from ordinary `load()`. Add a shared in-flight promise and loaded key so the first History tab activation loads it once, deep-link History still waits for its first load, and filters or explicit mutation refreshes continue to request fresh data.

- [ ] **Step 3: Run focused regression tests**

Run: `npm.cmd test -- apps/api/test/miniAppLaunchService.test.js apps/miniapp/test/history.test.js apps/miniapp/test/smokeAssets.test.js`

Expected: analytics failure cannot delay/fail Dashboard and initial Dashboard does not fetch History.

### Task 4: Acknowledge Telegram early and instrument the browser startup

**Files:**
- Modify: `apps/miniapp/src/index.html`
- Create: `apps/miniapp/src/startupTiming.js`
- Modify: `apps/miniapp/src/app.js`
- Modify: `apps/miniapp/test/smokeAssets.test.js`

- [ ] **Step 1: Add the tiny classic bootstrap**

Immediately after the Telegram SDK, mark SDK availability and call `WebApp.ready()` and `expand()` once. Record bootstrap state on a namespaced global so the ES module does not duplicate those calls or listeners.

- [ ] **Step 2: Add compact frontend marks**

Record app evaluation, dashboard request/response/render, History request/finish, and usable Dashboard total. Expose compact timing data only when `?debugStartup=1`; production console remains quiet.

- [ ] **Step 3: Preserve Telegram setup**

Keep safe-area, theme, fullscreen, swipe, and Home Screen setup in the main module, but remove duplicate `ready()/expand()` calls.

- [ ] **Step 4: Run focused Mini App tests**

Run: `npm.cmd test -- apps/miniapp/test/smokeAssets.test.js apps/miniapp/test/history.test.js apps/miniapp/test/tabPager.test.js`

Expected: startup marks and early readiness are present without duplicate Telegram initialization.

### Task 5: Add version-aware static caching

**Files:**
- Modify: `apps/api/src/http.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/miniapp/src/index.html`
- Test: `apps/api/test/httpStatic.test.js`
- Test: `apps/miniapp/test/smokeAssets.test.js`

- [ ] **Step 1: Pass request cache context to the static handler**

Provide request headers and the parsed URL so the handler can distinguish HTML, explicit `?v=` assets, and unversioned ES module imports.

- [ ] **Step 2: Emit safe cache headers and validators**

Use `Cache-Control: no-cache` for HTML and unversioned assets, `public, max-age=31536000, immutable` only for explicit versioned assets, plus deterministic ETag and Last-Modified validators. Return `304` for matching validators without reading a stale body.

- [ ] **Step 3: Advance the root asset version**

Keep the existing synchronized app/CSS cache-buster contract while ensuring new deploys select the changed roots; imports continue to revalidate rather than being dangerously immutable.

- [ ] **Step 4: Run focused cache tests**

Run: `npm.cmd test -- apps/api/test/httpStatic.test.js apps/miniapp/test/smokeAssets.test.js`

Expected: cache policy and invalidation tests pass.

### Task 6: Verify domain safety and publish diagnostic evidence

**Files:**
- Modify: `docs/TESTING_GUIDE.md`
- Modify: `docs/UI_PRINCIPLES.md`
- Modify: `docs/superpowers/plans/2026-08-13-miniapp-startup-performance.md`

- [ ] **Step 1: Run focused financial tests**

Run: `npm.cmd test -- apps/api/test/miniAppLaunchService.test.js apps/api/test/repository.test.js apps/miniapp/test/history.test.js apps/miniapp/test/smokeAssets.test.js`

Expected: reserve, planned-payment, budget, auth, analytics, History, and cache regressions pass.

- [ ] **Step 2: Run disposable PostgreSQL integration when available**

Run: `npm.cmd run test:integration:postgres`

Expected: reserve create/read, month rollover, current budget/topups, planned payments, snapshots, and real SQL smoke pass. Do not point this command at a persistent database.

- [ ] **Step 3: Capture local before/after timings**

Use the debug startup marks and `Server-Timing` header against the repository's local acceptance sandbox with synthetic data. Record the exact environment and avoid presenting local timings as Telegram production evidence.

- [ ] **Step 4: Run full verification**

Run: `npm.cmd test`

Run: `git diff --check`

Expected: full suite passes and the diff is clean.

- [ ] **Step 5: Publish a draft PR only**

Include `Closes #166`, measured root-cause evidence available in this environment, before/after breakdown, retained performance hooks, tests, DB/prod impact, `## User Release Notes`, and explicit manual gaps for real Telegram mobile video/timings. Do not merge or deploy.
