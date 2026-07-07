# Admin Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send short, safe Telegram alerts to configured admins when critical Money Flow API, Telegram, scheduler, parser, rates, or backup checks fail.

**Architecture:** Add a focused `adminAlerts.js` service that formats, sanitizes, throttles, and sends alerts through the existing Telegram sender and existing `adminTelegramIds`. Wire it only into places where errors are already caught or logged, preserving current error responses and fallback behavior. Keep full stack traces in Docker logs; Telegram receives only compact safe context.

**Tech Stack:** Node.js ESM, `node:test`, existing Telegram Bot API helper, existing config/env parsing.

---

### Task 1: Alert Service

**Files:**
- Create: `apps/api/src/adminAlerts.js`
- Create: `apps/api/test/adminAlerts.test.js`

- [x] **Step 1: Write failing tests for formatting, sending, throttling, sanitization, and failure safety**

Create `apps/api/test/adminAlerts.test.js` with tests that import `createAdminAlertService`, `formatAdminAlertMessage`, `sanitizeAlertContext`, and `serializeAlertError`.

Test cases:
- sends one compact alert to every admin ID when enabled;
- throttles repeated alerts with the same fingerprint;
- sends different fingerprints separately;
- redacts sensitive keys including `token`, `secret`, `password`, `authorization`, `cookie`, `initData`, `hash`, `signature`, `env`, `headers`, and `body`;
- truncates long messages to the configured max length;
- catches Telegram send failures, logs them, and does not throw;
- does not recurse when alert sending itself fails.

Run:

```powershell
node --test apps/api/test/adminAlerts.test.js
```

Expected: FAIL because `apps/api/src/adminAlerts.js` does not exist.

- [x] **Step 2: Implement `adminAlerts.js` minimally**

Create a service with this public API:

```js
export function createAdminAlertService({
  enabled = true,
  adminTelegramIds = new Set(),
  sendMessage,
  logger = console,
  throttleMs = 10 * 60_000,
  maxMessageLength = 900,
  now = () => new Date()
} = {}) {
  return {
    async notifyAdminError(error, context = {}) {
      // sanitize, throttle, send to every admin, absorb send failures
    },
    formatExample(error, context = {}) {
      return formatAdminAlertMessage(serializeAlertError(error), sanitizeAlertContext(context), {
        now: now(),
        maxMessageLength
      });
    },
    _clearThrottleForTests() {
      // test-only object-local cleanup is acceptable because it is not exported globally
    }
  };
}
```

Message shape:

```text
Money Flow error
source: api
route: POST /api/expenses
userId: redacted-user
error: ValidationError
message: Invalid expense payload
time: 2026-07-07T14:30:00.000Z
```

Rules:
- no HTML parse mode;
- no stack trace;
- no raw headers/body/env/initData;
- unknown errors serialize as `NonError`;
- only allow scalar safe context values after sanitization;
- fingerprint from `source`, `route` or `jobName` or `operation`, error name, and normalized message;
- cleanup throttle entries older than `throttleMs * 2`.

- [x] **Step 3: Verify service tests pass**

Run:

```powershell
node --test apps/api/test/adminAlerts.test.js
```

Expected: PASS.

### Task 2: Config and Deployment Docs

**Files:**
- Modify: `apps/api/src/config.js`
- Modify: `apps/api/test/config.test.js`
- Modify: `compose.prod.yml`
- Modify: `.env.production.example`
- Modify: `docs/deployment-runbook.md`
- Modify: `test/deploymentWorkflow.test.js`

- [x] **Step 1: Write failing config and deployment contract tests**

Update config tests to assert:
- `ADMIN_ALERTS_ENABLED=true` enables alerts;
- unset value defaults to false;
- `ADMIN_ALERT_THROTTLE_MS` defaults to `600000`;
- `ADMIN_ALERT_MAX_MESSAGE_LENGTH` defaults to `900`;
- invalid positive integer values fall back to defaults.

Update `test/deploymentWorkflow.test.js` to assert production compose and `.env.production.example` mention the admin alert env keys.

Run:

```powershell
node --test apps/api/test/config.test.js test/deploymentWorkflow.test.js
```

Expected: FAIL because config and docs do not define the new keys.

- [x] **Step 2: Implement config and docs**

Add config fields:
- `adminAlertsEnabled`
- `adminAlertThrottleMs`
- `adminAlertMaxMessageLength`

Wire compose/env docs:

```env
ADMIN_ALERTS_ENABLED=false
ADMIN_ALERT_THROTTLE_MS=600000
ADMIN_ALERT_MAX_MESSAGE_LENGTH=900
```

Document that admin alerts reuse `ADMIN_TELEGRAM_IDS` and `TELEGRAM_BOT_TOKEN`; no new bot token is required.

- [x] **Step 3: Verify config and deployment tests pass**

Run:

```powershell
node --test apps/api/test/config.test.js test/deploymentWorkflow.test.js
```

Expected: PASS.

### Task 3: Runtime Wiring

**Files:**
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/src/releaseDigestScheduler.js`
- Modify: `apps/api/src/reportScheduler.js`
- Modify: `apps/api/src/exchangeRates.js`
- Modify: `apps/api/test/telegram.test.js`
- Modify: `apps/api/test/releaseDigestScheduler.test.js`
- Modify: `apps/api/test/reportScheduler.test.js`
- Modify: `apps/api/test/exchangeRates.test.js`

- [x] **Step 1: Write failing integration tests**

Add focused tests proving:
- queued Telegram processing failures call `notifyAdminError` with `source: "telegram"` and `operation: "queued_job"`;
- parser/LLM failures call `notifyAdminError` with `source: "parser"` and `operation: "expense_parse"`;
- scheduler failures call `notifyAdminError` through scheduler `onError` hooks while still absorbing failures;
- exchange rate provider failures call `notifyAdminError` with `source: "rates"` while still falling back to manual rates;
- API 500 handling calls `notifyAdminError` with `source: "api"`, route and method.

Run focused tests for the touched files.

Expected: FAIL because `notifyAdminError` is not wired.

- [x] **Step 2: Wire admin alert service in `server.js`**

Create `adminAlertService` after `adminTelegramIds` is parsed:

```js
const adminAlertService = createAdminAlertService({
  enabled: config.adminAlertsEnabled && Boolean(config.telegramBotToken),
  adminTelegramIds,
  sendMessage: (message) => sendTelegramMessage({
    token: config.telegramBotToken,
    ...message
  }),
  logger: console,
  throttleMs: config.adminAlertThrottleMs,
  maxMessageLength: config.adminAlertMaxMessageLength
});
```

Pass `adminAlertService` to Telegram bot, schedulers, and exchange rate provider. In the top-level API catch, call `void adminAlertService.notifyAdminError(error, { source: "api", method: req.method, route: routeKeyFromRequest(req) })` before sending `500`.

- [x] **Step 3: Wire existing catch blocks without changing behavior**

Rules:
- keep existing `console.error` calls;
- use `void notifyAdminError(...)` in response paths where alert send must not block users;
- use `await notifyAdminError(...)` only inside scheduler error handlers that already await error hooks;
- do not swallow errors that currently rethrow;
- do not alert for expected 4xx domain responses.

- [x] **Step 4: Verify integration tests pass**

Run:

```powershell
node --test apps/api/test/adminAlerts.test.js apps/api/test/telegram.test.js apps/api/test/releaseDigestScheduler.test.js apps/api/test/reportScheduler.test.js apps/api/test/exchangeRates.test.js apps/api/test/config.test.js test/deploymentWorkflow.test.js
```

Expected: PASS.

### Task 4: PR Readiness

**Files:**
- Modify: PR body only after push

- [x] **Step 1: Run final verification**

Run:

```powershell
npm.cmd test
git diff --check
git status -sb
```

Expected: full suite passes, no whitespace errors, only intended files changed.

- [x] **Step 2: Include safe alert sample in PR description**

Use the actual sample from `adminAlertService.formatExample(new Error("Invalid expense payload"), { source: "api", method: "POST", route: "/api/expenses", userId: "redacted-user" })` or from the formatter test output.

The PR body must explicitly say:
- sample is short enough for Telegram;
- no token/env/initData/cookies/authorization/header/body/financial detail is included;
- admin alerts reuse `ADMIN_TELEGRAM_IDS`.

- [ ] **Step 3: Open draft PR**

Push `codex/admin-error-alerts` and open a draft PR into `master`. Do not merge or deploy.
