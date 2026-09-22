# Mini App UX And Brand Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve Mini App readability, brand consistency, Settings scanability, and action clarity without changing APIs, persistence, or financial calculations.

**Architecture:** Keep the existing HTML/CSS/vanilla-JS structure and existing settings autosave and currency option helpers. Make one coherent frontend-only pass: token and typography adjustments, DOM reordering, a disclosure wrapper around the existing currency controls, and localized action copy. Preserve every existing financial and destructive confirmation boundary.

**Tech Stack:** HTML, CSS, vanilla JavaScript, Node.js test runner.

---

### Task 1: Lock the intended DOM contracts with focused tests

**Files:**
- Modify: `apps/miniapp/test/smokeAssets.test.js`
- Modify: `apps/miniapp/test/i18n.test.js`

- [x] Update the dashboard order assertion to require urgent recovery and planned notices before `latestExpensesSection`, followed by `monthlyForecast`, `budgetPlan`, and analytics.
- [x] Update the Settings structure assertion to require Budget, Currencies, Quick Access, Notifications, and Interface in that order, with export inside `dataPrivacySection`.
- [x] Add markup assertions for collapsed base/display currency controls that retain the existing search inputs and native selects.
- [x] Change the RU/EN planned-payment action expectations to `Отметить оплату` and `Mark paid`.
- [x] Run `node --test apps/miniapp/test/smokeAssets.test.js apps/miniapp/test/i18n.test.js` and confirm the new assertions fail before implementation.

### Task 2: Improve hierarchy and Settings scanability

**Files:**
- Modify: `apps/miniapp/src/index.html`
- Modify: `apps/miniapp/src/app.js`
- Modify: `apps/miniapp/src/i18n.js`

- [x] Move `latestExpensesSection` directly below the recovery block and planned notice; keep urgent states above it and secondary disclosures below it.
- [x] Reorder Settings to Budget, Currencies, Quick Access, Notifications, and Interface.
- [x] Move `expenseExportBlock` into the existing `dataPrivacySection` and revise the privacy copy so it no longer says export is “above”.
- [x] Wrap each existing currency search plus native select in a compact disclosure whose summary shows the confirmed current currency.
- [x] Update the currency summary after initial render, change, follow-base changes, and autosave rollback. Clear a disclosure’s search filter when it closes so the selected option cannot remain filtered out.
- [x] Keep `currencyOptions`, `createSettingsSaveQueue`, budget confirmation, and follow-base semantics unchanged.
- [x] Change the planned-payment direct action to `Отметить оплату` / `Mark paid`, including the matching in-progress copy; leave the completed state `Оплачено` / `Paid`.

### Task 3: Apply a restrained brand and readability pass

**Files:**
- Modify: `apps/miniapp/src/styles.css`

- [x] Keep the warm light surface and graphite dark surface, and align primary accent tokens with the supplied calm green brand direction in `:root`, light, and dark themes.
- [x] Add a separate decorative gold token and use it only for a small ribbon detail. Do not reuse warning amber for decoration.
- [x] Replace remaining decorative hard-coded teal values touched by this change with the existing semantic tokens, while preserving red/amber/green state meanings.
- [x] Remove the unserved `Inter` face from the font stack and use the system stack without a new dependency.
- [x] Raise important dashboard/card microcopy from 10–11 px to 11–12 px at narrow widths; keep compact navigation, heatmap, calendar, and deep analytics labels unchanged.
- [x] Reduce ordinary heading and button weights to about 700 while retaining stronger hierarchy for primary monetary amounts.
- [x] Style currency disclosures as compact rows with at least 42 px summary targets and no horizontal overflow.

### Task 4: Verify behavior and visual output

**Files:**
- Modify if required by final behavior: `apps/miniapp/test/smokeAssets.test.js`
- Modify if required by final copy: `apps/miniapp/test/i18n.test.js`

- [x] Run `node --test apps/miniapp/test/smokeAssets.test.js apps/miniapp/test/settings.test.js apps/miniapp/test/currencies.test.js apps/miniapp/test/planned.test.js apps/miniapp/test/dashboardCards.test.js apps/miniapp/test/themeBackground.test.js apps/miniapp/test/i18n.test.js`.
- [x] Run `npm.cmd run build:miniapp`, `npm.cmd test`, and `git diff --check`.
- [ ] Seed only the guarded local demo database with `npm.cmd run dev:reset`, run the local API, and capture synthetic before/after review images at 375, 390, and 430 CSS px. Blocked in this run because the local Docker engine did not become ready; static local screenshots were captured instead.
- [x] Verify no horizontal scrolling, clipped labels, or hidden currency disclosures at 375, 390, and 430 CSS pixels. Autosave rollback remains covered by focused tests; Telegram-device verification was unavailable and is recorded as a pre-merge check.

### Task 5: Publish a reviewable draft PR

**Files:**
- Modify: this plan, checking completed steps and recording material visual decisions.

- [x] Review the final diff for unrelated changes and secrets.
- [ ] Commit the scoped files on `codex/miniapp-ux-brand-polish`, push the branch, and open a draft PR into `master`.
- [ ] Include summary, changed areas, docs checked, exact tests, no DB/API/production impact, synthetic before/after artifacts, limitations, and the required `## User Release Notes` block.
- [ ] Verify the PR head SHA and CI for the exact final commit. Stop before merge or deploy and present the PR plus visible result to the user.
