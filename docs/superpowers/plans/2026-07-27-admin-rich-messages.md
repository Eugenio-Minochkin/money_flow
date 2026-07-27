# Admin Rich Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver `/admin_stats` and `/admin_stats_tech` as one Telegram Rich Message while preserving the existing HTML multipart path as a safe fallback.

**Architecture:** Keep statistics services and their structured section contract unchanged. Add a pure Rich HTML renderer and a narrow `sendTelegramRichMessage` transport wrapper; make only the two admin command branches choose Rich Message or the existing multipart renderer according to size and deterministic Telegram errors.

**Tech Stack:** Node.js ESM, node:test, Telegram Bot API Rich Messages.

---

### Task 1: Rich HTML renderer

**Files:**
- Create: `apps/api/src/adminRichMessage.js`
- Test: `apps/api/test/adminRichMessage.test.js`

- [x] **Step 1: Write failing renderer tests**

```js
import { renderAdminRichMessage } from "../src/adminRichMessage.js";

test("product renderer keeps primary sections open and escapes dynamic values", () => {
  const html = renderAdminRichMessage([
    { heading: "📊 Product stats", rows: [{ segments: [{ text: "Generated: ", style: "plain" }, { text: "2026-07-27 10:00 UTC", style: "code" }] }] },
    { heading: "👥 User base", rows: [{ segments: [{ text: "Users: ", style: "plain" }, { text: "2", style: "bold" }] }] },
    { heading: "🧭 Sources", rows: [{ segments: [{ text: "source: ", style: "plain" }, { text: "a<b>&:\\"", style: "code" }] }] }
  ], { reportType: "product" });
  assert.match(html, /<h1>📊 Product stats<\\/h1>/);
  assert.match(html, /<footer>Generated: <code>2026-07-27 10:00 UTC<\\/code><\\/footer>/);
  assert.match(html, /<h2>👥 User base<\\/h2>/);
  assert.match(html, /<details><summary>🧭 Sources<\\/summary>/);
  assert.match(html, /a&lt;b&gt;&amp;:&quot;/);
});
```

- [x] **Step 2: Run the new tests and verify they fail because the renderer is missing**

Run: `npm.cmd test -- apps/api/test/adminRichMessage.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `adminRichMessage.js`.

- [x] **Step 3: Implement the renderer**

```js
export function renderAdminRichMessage(sections, { reportType }) {
  return sections.filter(hasRows).map((section, index) => renderSection(section, { reportType, index })).join("\n");
}

function renderRow(row) {
  const { label, value, styled } = semanticRow(row);
  return `<tr><td>${label}</td><td>${styled(value)}</td></tr>`;
}
```

Implement `escapeRichHtml` for `&`, `<`, `>`, `"`, and `'`; render the first heading as `h1`, the generated row as `footer`, product primary sections as `h2`, technical period headings as `h2`, technical primary groups as `h3`, and configured secondary sections as `details`. Derive table labels and values from structured segments rather than splitting arbitrary rows; preserve code and bold segment styles, and use a single `colspan="2"` row for non-semantic plain rows.

- [x] **Step 4: Run renderer tests and established formatter tests**

Run: `npm.cmd test -- apps/api/test/adminRichMessage.test.js apps/api/test/productStatsService.test.js apps/api/test/technicalStatsService.test.js`

Expected: PASS.

### Task 2: Rich Message transport and admin-command routing

**Files:**
- Modify: `apps/api/src/telegram.js:15-17,225-252,2621-2655`
- Modify: `apps/api/test/telegram.test.js:1966-2573,5833-5838`

- [x] **Step 1: Write failing transport and command tests**

```js
test("admin stats sends one rich message with the injected client", async () => {
  const calls = [];
  const bot = createTelegramBot({
    token: "test-token", miniAppUrl: "http://localhost:3000", repository: fakeRepository(),
    adminTelegramIds: new Set([100]), adminStatsService: { async getAdminStats() { return productStats; } },
    telegramClient: { async sendRichMessage(message) { calls.push(message); return { ok: true }; }, async sendMessage(message) { throw new Error(`unexpected fallback ${message.text}`); } }
  });
  await bot.handleUpdate(textUpdate("/admin_stats", 100));
  assert.equal(calls.length, 1);
  assert.match(calls[0].html, /<h1>📊 Product stats<\\/h1>/);
});
```

Cover direct `sendTelegramRichMessage` with a mocked global `fetch`: method `sendRichMessage`, one `rich_message.html` content source, `skip_entity_detection: true`, preserved `reply_markup`, and unmodified response. Cover no-token synthetic `message_id`, injected `sendRichMessage`, HTTP 400 fallback to `formatAdminMessageParts`, oversized HTML fallback before transport, and no second send for timeout, 429, or 5xx. Extend `capturingClient` with `sendRichMessage` without changing its existing `sendMessage` behavior.

- [x] **Step 2: Run the new command/transport tests and verify they fail**

Run: `npm.cmd test -- apps/api/test/telegram.test.js --test-name-pattern="rich message|admin stats"`

Expected: FAIL because `sendRichMessage` is not called and `sendTelegramRichMessage` is not exported.

- [x] **Step 3: Implement the narrow transport and routing**

```js
export async function sendTelegramRichMessage({ token, chatId, html, replyMarkup = null, telegramClient = null }) {
  if (telegramClient) return telegramClient.sendRichMessage({ chatId, html, replyMarkup });
  if (!token) return { ok: true, result: { message_id: nextLogMessageId() } };
  return telegramRequest(token, "sendRichMessage", {
    chat_id: chatId,
    rich_message: { html, skip_entity_detection: true },
    reply_markup: replyMarkup
  });
}
```

Import `renderAdminRichMessage`; route `/admin_stats` and `/admin_stats_tech` through an `sendAdminStats` helper that uses an explicit Rich HTML limit, falls back to existing `formatAdminMessageParts` before sending if oversized, falls back only on a classified HTTP 400, and logs only command, report type, status/class, and a fixed safe reason. Rethrow ambiguous errors so the existing unavailable-message handling remains the only response; do not modify `sendMessage`, `editMessageText`, callbacks, or reminder helpers.

- [x] **Step 4: Run focused command and transport tests**

Run: `npm.cmd test -- apps/api/test/telegram.test.js`

Expected: PASS, including unchanged non-admin access and callback tests.

### Task 3: Regression coverage and verification

**Files:**
- Modify: `apps/api/test/adminRichMessage.test.js`
- Modify: `apps/api/test/telegram.test.js`

- [x] **Step 1: Add failing technical completeness tests**

```js
test("technical renderer keeps diagnostic groups distinct and collapses secondary groups", () => {
  const html = renderAdminRichMessage(formatTechnicalStatsSections(technicalStatsFixture), { reportType: "technical" });
  for (const metric of ["Confirm flow attempts", "P95 callback ACK", "Local acceptance", "LLM fallback", "Critical shadow", "Rejects", "Shadow fields"]) assert.match(html, new RegExp(metric));
  assert.match(html, /<h3>📨 Today — Traffic<\\/h3>/);
  assert.match(html, /<details><summary>✅ Today — Confirm flow<\\/summary>/);
  assert.match(html, /<hr\\/>/);
});
```

- [x] **Step 2: Run renderer and service-format tests to verify failure**

Run: `npm.cmd test -- apps/api/test/adminRichMessage.test.js apps/api/test/adminStatsService.test.js apps/api/test/adminStatsProcessingDiagnostics.test.js apps/api/test/productStatsService.test.js apps/api/test/technicalStatsService.test.js`

Expected: FAIL only if any current structured metric is omitted or escaped incorrectly.

- [x] **Step 3: Adjust only renderer mappings until all diagnostic metrics pass**

```js
const TECHNICAL_OPEN_GROUPS = new Set(["Traffic", "Errors", "Processing"]);
const TECHNICAL_COLLAPSED_GROUPS = new Set(["Confirm flow", "Processing stages", "Parser routing and averages", "Review", "Shadow", "Rejects", "Shadow fields"]);
```

Do not edit stats services, SQL, metric labels, parser schemas, admin access, planned-payment reminder code, or Telegram callbacks.

- [x] **Step 4: Run all required verification**

Run: `npm.cmd test -- apps/api/test/adminStatsService.test.js apps/api/test/adminStatsProcessingDiagnostics.test.js apps/api/test/productStatsService.test.js apps/api/test/technicalStatsService.test.js apps/api/test/adminRichMessage.test.js apps/api/test/telegram.test.js`

Run: `npm.cmd test`

Expected: both commands PASS.

- [ ] **Step 5: Review the final diff and open a draft PR**

Run: `git diff --check; git diff -- apps/api/src/adminRichMessage.js apps/api/src/telegram.js apps/api/test/adminRichMessage.test.js apps/api/test/telegram.test.js docs/superpowers/plans/2026-07-27-admin-rich-messages.md`

Expected: no whitespace errors; no SQL, migration, production configuration, or planned-payment reminder changes. The draft PR must link `Closes #135`, declare no DB/prod impact, include the focused/full test outcomes, and include the required user-release-notes block only if user-facing release notes are applicable.
