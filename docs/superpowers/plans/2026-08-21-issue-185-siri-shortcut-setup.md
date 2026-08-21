# Siri & Shortcut Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the repository portion of Siri/Shortcut setup a safe, localized Mini App flow while preserving the existing capture contract.

**Architecture:** Settings remains a compact entry point and opens a dedicated bottom sheet. The existing prepare → copy → activate boundary remains the sole credential lifecycle path; only after activation does the app ask Telegram/the browser to open the configured iCloud link. The generic iCloud Shortcut and production URL are explicit external follow-ups, not part of this PR.

**Tech Stack:** Vanilla ES modules, Mini App HTML/CSS, Node test runner.

---

### Task 1: Protect the setup ordering

**Files:**
- Modify: `apps/miniapp/src/quickAccessSetup.js`
- Test: `apps/miniapp/test/quickAccessSetup.test.js`

- [x] Add a failing test which supplies a shared URL and records calls in this exact order: preparation endpoint, clipboard, activation endpoint, link opener.
- [x] Run `npm.cmd test -- apps/miniapp/test/quickAccessSetup.test.js` and verify that the test fails because no opener is called.
- [x] Extend `advanceShortcutSetup` with optional `shortcutUrl` and `openShortcut`, calling the opener only after successful activation; leave failed copy and activation results unchanged.
- [x] Re-run `npm.cmd test -- apps/miniapp/test/quickAccessSetup.test.js`.

### Task 2: Add the dedicated localized setup sheet

**Files:**
- Modify: `apps/miniapp/src/index.html`
- Modify: `apps/miniapp/src/app.js`
- Modify: `apps/miniapp/src/styles.css`
- Modify: `apps/miniapp/src/i18n.js`
- Test: `apps/miniapp/test/smokeAssets.test.js`

- [x] Add failing structural assertions for the Settings entry, accessible setup dialog, primary action, ready state, unavailable state, retry, and RU/EN copy.
- [x] Run `npm.cmd test -- apps/miniapp/test/smokeAssets.test.js` and verify the new assertions fail before the sheet exists.
- [x] Replace the inline controls with a compact Settings entry and an accessible sheet. Render pre-setup, active-key-ready, failed preparation, and missing-URL states without rendering the raw credential.
- [x] Keep reconfiguration explicit; use the existing lifecycle function and open the URL only after it returns `activated`.
- [x] Add responsive light/dark-safe styles and block tab paging behind the dialog through its existing `role="dialog"` guard.
- [x] Re-run `npm.cmd test -- apps/miniapp/test/quickAccessSetup.test.js apps/miniapp/test/smokeAssets.test.js`.

### Task 3: Document the boundary and handoff

**Files:**
- Modify: `docs/ios-shortcut.md`
- Modify: `docs/TESTING_GUIDE.md`
- Modify: `docs/PRODUCT_CONTEXT.md`

- [x] Record the end-user setup flow, the exact one-question generic Shortcut constraint, and the idempotent capture contract.
- [x] Record the authorized follow-up: create/test/share the generic Shortcut on iPhone, retain the iCloud URL, then set `IOS_SHORTCUT_URL` only with a separate production authorization.
- [x] Add narrow-width manual acceptance coverage for RU/EN and light/dark.

### Task 4: Verify and publish the repository portion

**Files:**
- Verify: changed Mini App source, tests, and docs

- [ ] Run focused tests, `npm.cmd test`, Mini App build, and `git diff --check`.
- [ ] Inspect the diff for key exposure, Smart Save/parser/API changes, and accidental production configuration.
- [ ] Create one draft PR with `Part of #185` and the required user release notes; do not use `Closes #185`.
- [ ] Wait for exact-head CI, including PostgreSQL integration smoke, before calling the repo portion ready.
