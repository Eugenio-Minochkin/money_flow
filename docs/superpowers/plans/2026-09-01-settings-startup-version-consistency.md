# Settings startup version consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a Telegram WebView from combining Settings HTML from one Mini App release with JavaScript or CSS from another release.

**Architecture:** The build derives one deterministic fingerprint from the source HTML template, bundled JavaScript, and stylesheet, then substitutes it into both asset URLs. The existing HTML `no-cache` response therefore always points to matching immutable assets. An inline startup guard and an app-level Settings guard expose initialization failures without recording user data.

**Tech Stack:** Node.js, esbuild, native `node:test`, Mini App HTML/ES modules.

---

### Task 1: Add regression coverage for a release-consistent Mini App build

**Files:**
- Modify: `apps/miniapp/test/productionBundle.test.js`
- Modify: `apps/miniapp/test/smokeAssets.test.js`

- [x] Add a production-build test that asserts CSS and JavaScript receive the same content-derived fingerprint.
- [x] Add a source smoke test that requires an inline startup error listener before module execution and an app-level `renderSettings` error signal.
- [x] Run the focused tests; they passed after the red regression coverage was implemented.

### Task 2: Generate matching immutable asset URLs and report Settings initialization failures

**Files:**
- Modify: `apps/miniapp/build.mjs`
- Modify: `apps/miniapp/src/index.html`
- Modify: `apps/miniapp/src/app.js`

- [x] Bundle JavaScript in memory, hash the HTML template, stylesheet, and bundle into one fingerprint, write the files, and substitute the fingerprint into the HTML template.
- [x] Register inline `error` and `unhandledrejection` listeners before the module URL; expose only a privacy-safe code/message and show a visible startup failure state.
- [x] Wrap the synchronous `renderSettings` body so failures are reported through the same startup guard before propagating to the normal top-level error handling.
- [x] Re-run the focused tests and `npm.cmd run build:miniapp`.

### Task 3: Verify the initialized Settings surface

**Files:**
- Modify: `apps/miniapp/test/productionBundle.test.js`
- Modify: `apps/miniapp/test/smokeAssets.test.js`

- [x] Add a production-build/runtime smoke helper that loads a persisted Settings fixture and asserts base/display currency values, translated follow-base text, and non-empty timezone text before reporting success.
- [x] Verify the budget handler calls `/api/settings/budget` independently of autosave state.
- [x] Run the focused Mini App tests and the complete `npm.cmd test` suite.

### Task 4: Mobile release gate

**Files:**
- No repository file required.

- [ ] Open the built candidate through Telegram iOS and confirm the four Settings controls initialize and a regular budget save reaches `/api/settings/budget`.
- [ ] Do not merge or deploy until that device check is recorded in the draft PR.
