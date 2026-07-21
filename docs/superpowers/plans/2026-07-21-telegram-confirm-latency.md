# Telegram Confirm Callback Latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Acknowledge Telegram draft-confirm callbacks before expense persistence, preserve exactly-once saving, and expose privacy-minimal confirm latency metrics.

**Architecture:** Keep `saveDraftAsExpense()` as the transactional source of truth, but isolate its post-commit dashboard read so a saved expense cannot become a failed persistence outcome. Refactor only the Telegram regular-draft confirm handler into a measured state machine: early ACK, database outcome, one terminal Telegram operation, then safe outcome-appropriate background analytics/cleanup and one anonymous diagnostic event. Extend the existing technical-stats aggregate and formatter from the new event.

**Tech Stack:** Node.js ESM, PostgreSQL JSONB aggregation, Telegram Bot API client, Node test runner.

---

## File map

- `apps/api/src/repository.js` — return a successful persisted result when a post-commit dashboard snapshot is unavailable.
- `apps/api/src/telegramFormat.js` — render the reduced saved summary when no dashboard snapshot is available.
- `apps/api/src/telegram.js` — early ACK, measured terminal delivery, outcome-specific cleanup, safe background work, and anonymous confirm diagnostics.
- `apps/api/src/technicalStatsService.js` — aggregate and display Confirm flow counts and latency percentiles.
- `apps/api/test/repository.test.js` — lock in post-commit snapshot failure semantics.
- `apps/api/test/telegram.test.js` — lock in callback ordering, terminal delivery, retries, and contained best-effort failures.
- `apps/api/test/adminStatsProcessingDiagnostics.test.js` — lock in confirm aggregation and conditional formatting.

### Task 1: Preserve successful persistence when the post-commit snapshot fails

**Files:**

- Modify: `apps/api/test/repository.test.js:5073-5109`
- Modify: `apps/api/src/repository.js:2312-2391`

- [x] **Step 1: Write failing repository tests for the snapshot boundary.**

  Add a test beside `saveDraftAsExpense confirms an open draft` that makes `repo.dashboard` throw after the fake client records `COMMIT`:

  ```js
  test("saveDraftAsExpense returns saved expenses when its post-commit snapshot fails", async () => {
    const client = fakeConfirmClient({ draftRow: {
      id: 7, user_id: 1, status: "pending", base_currency: "THB", usd_thb_rate: 32.65,
      items: [{ amount: 80, currency: "THB", description: "coffee", category_slug: "food_cafe", budget_impact: "regular", needs_review: false, category_source: "parser", tags: [], spent_at: "2026-06-25T10:00:00Z" }]
    } });
    const repo = createRepository({ ...fakePool(() => ({ rows: [] })), async connect() { return client; } });
    repo.dashboard = async () => { throw new Error("snapshot unavailable"); };

    const result = await repo.saveDraftAsExpense(7, 100);

    assert.equal(result.alreadySaved, false);
    assert.equal(result.expenses.length, 1);
    assert.equal(result.dashboardSnapshot, null);
    assert.ok(client.queries.some((query) => query.sql === "COMMIT"));
  });
  ```

  Add the same assertion to the existing `already confirmed` test with a throwing `repo.dashboard`, expecting `{ alreadySaved: true, dashboardSnapshot: null }`.

- [x] **Step 2: Run the focused repository tests and verify the new test fails.**

  Run:

  ```powershell
  npm.cmd test -- apps/api/test/repository.test.js
  ```

  Expected: the new snapshot-failure expectation fails because `saveDraftAsExpense()` currently rethrows from the shared catch.

- [x] **Step 3: Isolate only the post-persistence dashboard read.**

  Add a small helper in `apps/api/src/repository.js` and use it only after the transaction has committed or an existing confirmed draft has been identified:

  ```js
  async function savedDraftSnapshotOrNull(repository, telegramUserId, draftId) {
    try {
      return (await repository.dashboard(telegramUserId)).snapshot ?? null;
    } catch (error) {
      console.warn("[repository] saved draft dashboard snapshot unavailable", {
        draftId,
        message: error.message
      });
      return null;
    }
  }
  ```

  Replace both post-persistence `await this.dashboard(telegramUserId)` calls with this helper. Do not move `COMMIT`, alter locks, change inserted-expense SQL, or catch any error before persistence finality.

- [x] **Step 4: Run the focused repository tests and verify they pass.**

  Run:

  ```powershell
  npm.cmd test -- apps/api/test/repository.test.js
  ```

  Expected: PASS, including the two null-snapshot cases and existing concurrent-confirm coverage.

- [x] **Step 5: Commit the repository boundary change.**

  ```powershell
  git add apps/api/src/repository.js apps/api/test/repository.test.js
  git commit -m "fix: preserve saved draft on snapshot failure"
  ```

### Task 2: Provide a reduced saved summary without dashboard data

**Files:**

- Modify: `apps/api/test/telegramFormat.test.js`
- Modify: `apps/api/src/telegramFormat.js:87-130`

- [x] **Step 1: Write a failing formatter test for a null snapshot.**

  Add a test that calls `formatSavedSummary(75, null, { language: "en", expenses: [{ amount_base: 75, description: "coffee", category_slug: "food_cafe" }] })` and asserts the output has the saved heading and expense line but no `Today` or `Month` dashboard blocks.

  ```js
  assert.match(text, /Saved/);
  assert.match(text, /coffee/);
  assert.doesNotMatch(text, /Today|Month/);
  ```

- [x] **Step 2: Run the formatter test and verify it fails.**

  Run:

  ```powershell
  npm.cmd test -- apps/api/test/telegramFormat.test.js
  ```

  Expected: FAIL because the formatter dereferences `snapshot.baseCurrency`.

- [x] **Step 3: Make the formatter choose the reduced summary explicitly.**

  Insert the null branch immediately before the current `const currency = snapshot.baseCurrency ?? "THB";` line; leave the following current full-summary statements in the same function and order:

  ```js
  export function formatSavedSummary(total, snapshot, options = {}) {
    const language = normalizeLanguage(options.language);
    if (!snapshot) {
      const currency = options.expenses?.[0]?.base_currency ?? "THB";
      return [
        `✅ <b>${t(language, "savedExpense")}:</b>`,
        formatSavedExpenseLines(options.expenses, total, currency, language)
      ].join("\n");
    }
  }
  ```

- [x] **Step 4: Run the formatter test and verify it passes.**

  Run:

  ```powershell
  npm.cmd test -- apps/api/test/telegramFormat.test.js
  ```

  Expected: PASS with all existing full-summary cases unchanged.

- [x] **Step 5: Commit the formatter fallback.**

  ```powershell
  git add apps/api/src/telegramFormat.js apps/api/test/telegramFormat.test.js
  git commit -m "feat: render saved summary without dashboard snapshot"
  ```

### Task 3: Refactor Telegram confirmation into a measured, single-ACK flow

**Files:**

- Modify: `apps/api/test/telegram.test.js:1237-1326,2996-3028,5395-5431`
- Modify: `apps/api/src/telegram.js:814-824,1951-2006,2720-2823`

- [x] **Step 1: Add failing Telegram tests for early acknowledgement and terminal outcomes.**

  Build a `calls` array with a deferred `saveDraftAsExpense` promise. Assert `answerCallbackQuery` with `Сохраняю…` is recorded before resolving the save, and that it is the only ACK after the handler finishes. Add cases for `alreadySaved`, `DraftCanceledError`, `CategoryRequiredError`, a generic DB error, a failed early ACK, and a committed result with `dashboardSnapshot: null`.

  ```js
  let ackObserved = false;
  repo.saveDraftAsExpense = async () => {
    assert.equal(ackObserved, true);
    return savedResult;
  };
  telegramClient.answerCallbackQuery = async (message) => {
    calls.push({ method: "answerCallbackQuery", ...message });
    ackObserved = true;
    return { ok: true };
  };
  assert.equal(calls.filter((call) => call.method === "answerCallbackQuery").length, 1);
  assert.equal(repo.events.some((event) => event.eventName === "expense_saved"), false);
  ```

  For `category_required` and generic failure, assert a direct `sendMessage`, no saved summary, and no `editMessageText` or `deleteMessage` that changes the draft card. Invoke the same callback again after changing the repository result to success and assert it can save.

- [x] **Step 2: Run the focused Telegram tests and verify they fail.**

  Run:

  ```powershell
  npm.cmd test -- apps/api/test/telegram.test.js
  ```

  Expected: FAIL because the current handler saves before ACK and answers the callback a second time on success/error.

- [x] **Step 3: Add localized copy and explicit delivery helpers.**

  Add `confirmSavingCallback` and `saveFailedMessage` to both language maps. Introduce helpers that return delivery metadata rather than throwing delivery errors into persistence classification:

  ```js
  async function deliverConfirmEditOrSend({ edit, send }) {
    const startedAt = performance.now();
    try {
      await edit();
      return { telegramUpdateSucceeded: true, telegramUpdateMode: "edit", telegramUpdateMs: elapsedMs(startedAt) };
    } catch (editError) {
      try {
        await send();
        return { telegramUpdateSucceeded: true, telegramUpdateMode: "fallback_send", telegramUpdateMs: elapsedMs(startedAt) };
      } catch (sendError) {
        console.error("[telegram] confirm result delivery failed", sendError.message);
        return { telegramUpdateSucceeded: false, telegramUpdateMode: "failed", telegramUpdateMs: elapsedMs(startedAt) };
      }
    }
  }

  async function deliverConfirmSend(send) {
    const startedAt = performance.now();
    try {
      await send();
      return { telegramUpdateSucceeded: true, telegramUpdateMode: "send", telegramUpdateMs: elapsedMs(startedAt) };
    } catch (error) {
      console.error("[telegram] confirm result delivery failed", error.message);
      return { telegramUpdateSucceeded: false, telegramUpdateMode: "failed", telegramUpdateMs: elapsedMs(startedAt) };
    }
  }
  ```

- [x] **Step 4: Implement one `handleConfirmDraft` state machine.**

  At entry capture `startedAt`, attempt exactly one early ACK in `try/catch`, and set `callbackAckMs` from entry through that attempt. Time `saveDraftAsExpense` as `dbSaveMs`; map its result/errors to the five database outcomes. Use the delivery helpers for every terminal operation, calculate `userResultMs` immediately afterward, and never call `answerCallback` again.

  ```js
  const background = [];
  if (outcome === "success" && !result.alreadySaved) {
    background.push(safeRecordAppEvent(repository, user?.id, "expense_draft_confirmed", { draftType: "regular" }));
    background.push(...result.expenses.map(() => safeRecordAppEvent(repository, user?.id, "expense_saved", { draftType: "regular" })));
  }
  if (["success", "already_saved", "cancelled"].includes(outcome)) {
    background.push(runSafeConfirmCleanup({
      repository,
      telegramUserId,
      target: { type: "draft", id: Number(draftId), itemIndex: undefined },
      fallbackChatId: chatId,
      token,
      telegramClient,
      now
    }));
  }
  await Promise.allSettled(background);
  await safeRecordAppEvent(repository, null, "draft_confirm_processing_completed", diagnosticMetadata);
  ```

  `runSafeConfirmCleanup` must measure wall-clock `cleanupMs`, catch and log its own errors, and only close/deactivate sessions for `success`, `already_saved`, and `cancelled`. `category_required` and `failed` deliberately leave the session and card alone. Set `summaryBuildMs: null` and `expenseCount: 0` for all three unsuccessful database outcomes. Compute `totalMs` before attempting the diagnostic event.

- [x] **Step 5: Add focused non-blocking/failure tests and make the implementation pass them.**

  Use deferred analytics and cleanup promises. Resolve the terminal Telegram operation first and assert the saved summary exists before resolving either deferred task. Make `recordAppEvent`, cleanup, and the final anonymous diagnostic write reject in separate tests; attach `process.once("unhandledRejection", fail)` and assert the handler resolves with its terminal result. Assert the diagnostic event is invoked once with `userId === null`, contains no identifier metadata, and contains `callbackAckMs`, `userResultMs`, `totalMs`, delivery mode/success, nullable summary timing, and the correct outcome.

  Run:

  ```powershell
  npm.cmd test -- apps/api/test/telegram.test.js
  ```

  Expected: PASS, including legacy `confirm:<id>` and `d:<id>:confirm` routes.

- [x] **Step 6: Commit the confirm-flow refactor.**

  ```powershell
  git add apps/api/src/telegram.js apps/api/test/telegram.test.js
  git commit -m "feat: acknowledge telegram draft confirms early"
  ```

### Task 4: Aggregate and render Confirm flow diagnostics

**Files:**

- Modify: `apps/api/test/adminStatsProcessingDiagnostics.test.js:6-105`
- Modify: `apps/api/src/technicalStatsService.js:32-52,103-162,206-472,511-536`

- [x] **Step 1: Write failing stats tests for counts, nullable metrics, and rendering.**

  Extend the fake event row with confirm aliases and assert the SQL includes `draft_confirm_processing_completed`, each outcome, `callbackAckMs`, `userResultMs`, and `telegramUpdateMs`. Assert the mapped period exposes separate success/already-saved/cancelled/category-required/failed values, and assert their sum equals attempts. Add formatter cases for populated and zero-attempt periods.

  ```js
  assert.match(text, /Confirm: 10 attempts \/ success 5 \/ already saved 2 \/ cancelled 1 \/ category required 1 \/ failed 1/);
  assert.match(text, /Confirm P95: ack 0\.4s \/ result 1\.7s \/ total 2\.1s/);
  assert.doesNotMatch(emptyText, /Confirm:/);
  assert.doesNotMatch(textWithoutUpdateMetric, /Telegram update/);
  ```

- [x] **Step 2: Run the focused stats test and verify it fails.**

  Run:

  ```powershell
  npm.cmd test -- apps/api/test/adminStatsProcessingDiagnostics.test.js
  ```

  Expected: FAIL because the event aliases and Confirm flow formatter do not yet exist.

- [x] **Step 3: Extend the JSONB aggregate with explicit numeric guards.**

  Add `COUNT(*) FILTER` aliases for attempts and every `metadata->>'outcome'` value. For every time metric use the current regex guarded pattern so absent JSON or JSON `null` is excluded:

  ```sql
  AVG(CASE WHEN metadata->>'userResultMs' ~ '^[0-9]+(\.[0-9]+)?$'
      THEN (metadata->>'userResultMs')::numeric END)
    FILTER (WHERE event_name = 'draft_confirm_processing_completed')::float AS avg_confirm_user_result_ms,
  PERCENTILE_CONT(0.95) WITHIN GROUP (
    ORDER BY CASE WHEN metadata->>'userResultMs' ~ '^[0-9]+(\.[0-9]+)?$'
      THEN (metadata->>'userResultMs')::numeric END
  ) FILTER (WHERE event_name = 'draft_confirm_processing_completed'
      AND metadata->>'userResultMs' ~ '^[0-9]+(\.[0-9]+)?$')::float AS p95_confirm_user_result_ms
  ```

  Add the matching callback ACK, total, DB save, and Telegram update aliases; map every alias through `nullableNumeric`/`secondsOrNull` in `periodStats`.

- [x] **Step 4: Render one optional Confirm flow group.**

  Add a `formatConfirmFlow(period)` that returns `[]` when `confirmAttempts === 0`; otherwise return the outcome reconciliation line and only the latency lines whose metrics are non-null. Spread it into `formatPeriod`, add `/^Confirm/` to a distinct `Confirm flow` group in `formatTechnicalStatsSections`, and add its emoji mapping.

  ```js
  function formatConfirmFlow(period) {
    if (period.confirmAttempts === 0) return [];
    const lines = [
      `Confirm: ${period.confirmAttempts} attempts / success ${period.confirmSuccess} / already saved ${period.confirmAlreadySaved} / cancelled ${period.confirmCancelled} / category required ${period.confirmCategoryRequired} / failed ${period.confirmFailed}`
    ];
    if (period.p95ConfirmAckSeconds != null || period.p95ConfirmUserResultSeconds != null || period.p95ConfirmTotalSeconds != null) {
      lines.push(`Confirm P95: ack ${formatSeconds(period.p95ConfirmAckSeconds)} / result ${formatSeconds(period.p95ConfirmUserResultSeconds)} / total ${formatSeconds(period.p95ConfirmTotalSeconds)}`);
    }
    return lines;
  }
  ```

- [x] **Step 5: Run the focused stats test and verify it passes.**

  Run:

  ```powershell
  npm.cmd test -- apps/api/test/adminStatsProcessingDiagnostics.test.js
  ```

  Expected: PASS; no empty Confirm flow section and no fabricated zero P95 metrics.

- [x] **Step 6: Commit the observability implementation.**

  ```powershell
  git add apps/api/src/technicalStatsService.js apps/api/test/adminStatsProcessingDiagnostics.test.js
  git commit -m "feat: report telegram confirm latency"
  ```

### Task 5: Verify the integrated behavior and prepare the draft PR

**Files:**

- Modify: none unless a failing verification identifies a direct regression in Tasks 1-4.

- [x] **Step 1: Run the three focused suites together.**

  ```powershell
  npm.cmd test -- apps/api/test/repository.test.js apps/api/test/telegram.test.js apps/api/test/adminStatsProcessingDiagnostics.test.js
  ```

  Expected: PASS.

- [x] **Step 2: Run the complete regression suite and diff checks.**

  ```powershell
  npm.cmd test
  git diff --check origin/master...HEAD
  git status --short --branch
  ```

  Expected: full suite passes, no whitespace errors, and only the planned source/test/spec/plan files differ from `origin/master`.

- [x] **Step 3: Prepare PR evidence.**

  Include the old versus new order (`save → analytics → cleanup → ACK` versus `ACK → save → terminal result → safe background work`), a safe `/admin_stats_tech` sample, the early-ACK order test, no DB migration/prod configuration impact, release rollback as the rollback path, and this user release note:

  ```markdown
  ## User Release Notes

  - После нажатия «Сохранить» Telegram сразу подтверждает действие и снимает spinner; итог сохранения появляется следом.
  ```

- [ ] **Step 4: Publish a draft PR into `master` and stop.**

  Use the repository GitHub publication workflow to push `codex/telegram-confirm-latency`, create a draft PR, and include the evidence from Step 3. Do not merge, deploy, access production, or perform database writes.
