# Unified Mini App Interactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Dashboard, History, and Plan use one compact interaction language while preserving existing expense and planned-payment mutations.

**Architecture:** Keep the shared `editModal.js` controller introduced by PR #162 as the only edit shell. Change only Mini App rendering, event binding, and CSS; derive planned-payment visual state from existing occurrence data and leave API, database, budget, and payment semantics untouched.

**Tech Stack:** Browser-native JavaScript modules, HTML, CSS custom properties, Node.js test runner.

---

### Task 1: Lock the interaction contracts with regression tests

**Files:**
- Modify: `apps/miniapp/test/planned.test.js`
- Modify: `apps/miniapp/test/smokeAssets.test.js`
- Modify: `apps/miniapp/test/editModal.test.js`

- [x] **Step 1: Write failing tests for planned visual states**

Add assertions for an exported presentation helper so fully paid, future unpaid, overdue unpaid, and partially paid recurring plans map to stable status variants without changing occurrence semantics.

- [x] **Step 2: Write failing structural tests for History and Plan**

Assert that History rows expose one tappable `data-edit-expense` surface without permanent edit/delete buttons; the expense modal contains save/delete but no footer close; planned cards use the shared category SVG, a tappable edit surface, explicit status class, and direct Pay action.

- [x] **Step 3: Write a failing modal geometry contract**

Assert that the modal top inset combines Telegram content-safe-area and fullscreen-control compensation, while its maximum height subtracts both safe edges.

- [x] **Step 4: Run the focused tests and confirm RED**

Run: `npm.cmd test -- apps/miniapp/test/planned.test.js apps/miniapp/test/editModal.test.js apps/miniapp/test/smokeAssets.test.js`

Expected: failures identify the missing row/modal/status/safe-area contracts.

### Task 2: Unify History expense interaction and modal actions

**Files:**
- Modify: `apps/miniapp/src/app.js`
- Modify: `apps/miniapp/src/styles.css`

- [x] **Step 1: Make each History expense a compact button row**

Render one focusable `data-edit-expense` row containing the shared category avatar, title and metadata, and primary/converted amounts. Remove the permanent action-button row without changing day groups or daily totals.

- [x] **Step 2: Move deletion into the expense modal**

Render `Save expense` and `Delete` in the modal action area, retain the existing localized confirmation, and route successful deletion through the same close-refresh-scroll-restore sequence used by save.

- [x] **Step 3: Remove the redundant footer close action**

Use the modal header close button, backdrop, and Escape as cancel-without-save controls.

- [x] **Step 4: Run the focused tests and confirm GREEN**

Run: `npm.cmd test -- apps/miniapp/test/editModal.test.js apps/miniapp/test/smokeAssets.test.js`

Expected: all selected tests pass.

### Task 3: Unify planned-payment cards without changing payment semantics

**Files:**
- Modify: `apps/miniapp/src/planned.js`
- Modify: `apps/miniapp/src/app.js`
- Modify: `apps/miniapp/src/i18n.js`
- Modify: `apps/miniapp/src/styles.css`
- Test: `apps/miniapp/test/planned.test.js`

- [x] **Step 1: Add the minimal presentation-state helper**

Export a helper returning `paid`, `overdue`, or `unpaid` from the existing monthly occurrences. It must classify overdue only when an unpaid occurrence is earlier than today and must not alter Pay eligibility or occurrence construction.

- [x] **Step 2: Render the shared icon and tappable edit surface**

Use `categoryIconSvg()` and `categoryColor()` in every planned card. Make the information area open the existing shared modal; keep Pay and overflow controls outside that surface.

- [x] **Step 3: Render explicit accessible statuses**

Add RU/EN labels for Paid, Unpaid, and Overdue, preserve recurring progress such as `2/3 paid`, and apply green/soft-warning/red classes that also work through existing light/dark tokens.

- [x] **Step 4: Preserve direct Pay and current undo/disable flows**

Keep the Pay button directly on unpaid cards, disabled for fully paid cards, and leave undo/disable inside the existing overflow pattern.

- [x] **Step 5: Run the focused tests and confirm GREEN**

Run: `npm.cmd test -- apps/miniapp/test/planned.test.js apps/miniapp/test/i18n.test.js apps/miniapp/test/smokeAssets.test.js`

Expected: all selected tests pass.

### Task 4: Make the modal safe-area aware and document the UI rule

**Files:**
- Modify: `apps/miniapp/src/styles.css`
- Modify: `apps/miniapp/src/index.html`
- Modify: `docs/UI_PRINCIPLES.md`

- [x] **Step 1: Constrain modal geometry to Telegram-safe bounds**

Define modal safe-top as Telegram content/safe-area top plus `--tg-fullscreen-control-extra-top`; define safe-bottom from Telegram/device insets; calculate maximum height from those two values so 375x667 and 375x812 cannot overlap top controls.

- [x] **Step 2: Align component density and focus states**

Use the same avatar size, radius, amount hierarchy, compact spacing, hover/focus treatment, and keyboard-visible outline for History and Plan rows.

- [x] **Step 3: Update the asset cache key and UI principles**

Bump the Mini App CSS/app asset version together and document tappable rows, modal-contained destructive expense actions, direct Pay, and safe-area behavior.

- [x] **Step 4: Verify responsive geometry**

Run the local Mini App and inspect 375x667 and 375x812 in light/dark and RU/EN. Record any Telegram-auth/fullscreen limitation in the PR rather than claiming unavailable evidence.

### Task 5: Verify and publish

**Files:**
- Review all files changed relative to `origin/master`.

- [x] **Step 1: Run focused Mini App verification**

Run: `npm.cmd test -- apps/miniapp/test/planned.test.js apps/miniapp/test/editModal.test.js apps/miniapp/test/i18n.test.js apps/miniapp/test/smokeAssets.test.js`

- [x] **Step 2: Run the complete repository suite and whitespace check**

Run: `npm.cmd test`

Run: `git diff --check origin/master...HEAD`

- [ ] **Step 3: Commit, push, and open a draft PR**

Use branch `codex/issue-163-unified-miniapp-interactions`; include `Closes #163`, required PR sections, `## User Release Notes`, screenshots/manual limitations, and explicit no-DB/no-production impact.

- [ ] **Step 4: Verify the exact published head**

Compare local SHA to the draft PR head, then wait for Test and PostgreSQL smoke on that exact SHA. Stop without merge or deploy.
