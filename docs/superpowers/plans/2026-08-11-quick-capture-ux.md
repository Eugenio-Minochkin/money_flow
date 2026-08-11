# Quick Capture UX Implementation Plan

> Execution tracked below. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Save one safe Mini App Quick Entry immediately with a reversible undo, while keeping review and multi-expense input explicit.

**Architecture:** Keep drafts as the parser and persistence boundary. The quick-entry API will confirm only server-classified safe single-item drafts and return the saved expense; review and multi-item drafts remain pending for the Mini App compact review surface. The Shortcut setup UI creates and copies the existing bearer credential without displaying it, and uses the configured `IOS_SHORTCUT_URL` only when present.

**Tech Stack:** Node.js HTTP API, repository draft/expense methods, vanilla Mini App JavaScript/CSS, Node test runner.

---

### Task 1: Classify and persist safe single Quick Entries

**Files:**
- Modify: `apps/api/src/server.js:443-460`
- Add: `apps/api/src/quickCapture.js`
- Add: `apps/api/test/quickCapture.test.js`

- [x] **Step 1: Write failing API tests**

```js
test("quick entry saves one safe item immediately", async () => {
  // assert status 201, saved expense id, and one saveDraftAsExpense call
});

test("quick entry leaves review and multi-item drafts pending", async () => {
  // assert status 201 with draft and no saveDraftAsExpense call
});
```

- [x] **Step 2: Run the focused test file and verify the new assertions fail**

Run: `npm.cmd test -- apps/api/test/quickCapture.test.js`

Expected: the response has no `saved` result and safe Quick Entry is still a pending draft.

- [x] **Step 3: Implement the smallest server-side branch**

```js
const isQuickCaptureAutoSaveEligible = (items) => items.length === 1
  && items[0].needs_review !== true
  && !draftNeedsCategoryChoice(items[0]);

if (isQuickCaptureAutoSaveEligible(draft.items)) {
  const saved = await repository.saveDraftAsExpense(draft.id, auth.telegramUserId);
  return sendJson(res, 201, { saved });
}
return sendJson(res, 201, { draft });
```

- [x] **Step 4: Re-run the focused API tests**

Run: `npm.cmd test -- apps/api/test/quickCapture.test.js`

Expected: PASS.

### Task 2: Render Quick Capture results and simplify Shortcut setup

**Files:**
- Modify: `apps/miniapp/src/app.js:149-238`
- Modify: `apps/miniapp/src/index.html:303-317`
- Modify: `apps/miniapp/src/i18n.js`
- Modify: `apps/miniapp/src/styles.css`
- Modify: `apps/miniapp/test/smokeAssets.test.js`

- [x] **Step 1: Write failing Mini App asset regressions**

```js
test("Quick Entry saves safe results with undo and keeps review drafts in a compact form", async () => {
  // assert saved-result rendering, delete request, and review save action
});

test("Shortcut setup copies a new key without rendering its value", async () => {
  // assert clipboard write, setup/install states, and absence of a token input
});
```

- [x] **Step 2: Run the focused Mini App test file and verify failure**

Run: `npm.cmd test -- apps/miniapp/test/smokeAssets.test.js`

Expected: FAIL because the current handler opens the full draft editor and renders the raw key.

- [x] **Step 3: Implement compact result states**

```js
if (data.saved) renderQuickCaptureSaved(data.saved.expenses);
else renderQuickCaptureReview(data.draft);

await api(`/api/expenses/${expense.id}`, {
  method: "DELETE",
  body: { telegramUserId, language: currentLanguage }
});
```

Use the existing draft update/confirm API only from the review state. Render amount inputs for reviewable amounts and category selects for reviewable categories; do not auto-save multiple items.

- [x] **Step 4: Implement credential-free Shortcut copy UX**

```js
const { token } = await api("/api/quick-access-tokens", { method: "POST", body: { telegramUserId } });
await navigator.clipboard?.writeText(token);
showShortcutSetupState();
```

Show the install link only when the server returns `iosShortcutUrl`; do not substitute a made-up iCloud URL. Keep reset as an explicit destructive reconfiguration action.

- [x] **Step 5: Re-run the focused Mini App tests**

Run: `npm.cmd test -- apps/miniapp/test/smokeAssets.test.js`

Expected: PASS.

### Task 3: Verify and publish the draft PR

**Files:**
- Verify: `apps/api/test/quickCapture.test.js`, `apps/miniapp/test/smokeAssets.test.js`

- [x] **Step 1: Run focused API and Mini App tests**

Run: `npm.cmd test -- apps/api/test/quickCapture.test.js apps/miniapp/test/smokeAssets.test.js`

Expected: PASS.

- [x] **Step 2: Run full verification**

Run: `npm.cmd test`

Expected: 0 failures.

- [ ] **Step 3: Check the diff and create a draft PR**

Run: `git diff --check` then create a draft PR into `master`.

Expected: no whitespace errors; PR stays draft and is neither merged nor deployed.
