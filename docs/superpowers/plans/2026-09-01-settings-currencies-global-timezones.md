# Settings currencies and global time zones Implementation Plan

Goal: make Settings save the monthly budget independently, preserve optional display-currency intent, and provide a global searchable IANA timezone picker.

Architecture: add users.display_currency_follows_base with default false, preserving existing THB plus USD settings. Treat display_currency as the saved custom secondary preference at all times; calculate the effective display currency centrally as base_currency when follows-base is true and display_currency otherwise. Keep IANA identifiers in storage, and derive an offset and city label from a bundled Mini App catalogue.

### Task 1: Persist the display currency link

Files:
- Create: apps/api/migrations/018_display_currency_follows_base.sql
- Modify: apps/api/src/repository.js
- Test: apps/api/test/repository.test.js
- Test: apps/api/integration/postgres-smoke.js

- [ ] Write a failing test that updates base GEL, display USD, followsBase false and asserts USD plus false.
- [ ] Write a failing test that updates base GEL, custom display USD, followsBase true and asserts the persisted custom display remains USD plus true while the helper returns GEL.
- [ ] Run npm.cmd test -- apps/api/test/repository.test.js apps/api/integration/postgres-smoke.js and confirm RED.
- [ ] Add an additive boolean NOT NULL DEFAULT FALSE migration. Always normalize and persist the explicit display_currency independently of the flag; effectiveDisplayCurrency(user) returns normalized base_currency when the flag is true, otherwise the explicit display_currency. Replace every backend display conversion, SQL aggregate parameter, DTO display currency, report value, and planned-payment projection that currently reads user.display_currency with this helper or its query-safe effective value. Return the flag in all user/dashboard reads. Do not backfill existing users.
- [ ] Write a failing onboarding test for each supported onboarding path proving a new user is saved with displayCurrencyFollowsBase true unless a second display currency was explicitly selected, then set the flag explicitly in the corresponding repository and Telegram calls.
- [ ] Re-run the focused tests and confirm GREEN.
- [ ] Commit migration, repository, and test files with feat: persist display currency follow preference.

### Task 2: Give budget failures a specific reason

Files:
- Modify: apps/api/src/repository.js
- Modify: apps/api/src/server.js
- Modify: apps/api/test/repository.test.js
- Modify: apps/miniapp/src/app.js
- Modify: apps/miniapp/src/i18n.js
- Test: apps/miniapp/test/settings.test.js

- [ ] Write failing tests for a reserve-conflicting budget error carrying nextBudgetAmount, plannedAmount, reserveAmount, and minimumBudgetAmount equal to plannedAmount plus reserveAmount.
- [ ] Write a failing Mini App test proving the regular budget calls only PATCH /api/settings/budget and does not read displayCurrency.
- [ ] Run npm.cmd test -- apps/api/test/repository.test.js apps/miniapp/test/settings.test.js and confirm RED.
- [ ] Extend reserve_conflicts_with_budget_change with structured details { nextBudgetAmount, plannedAmount, reserveAmount, minimumBudgetAmount }; serialize error and details as a stable 409 contract from both settings routes. Map the dedicated budget failure to localized RU/EN text with formatted attempted and minimum values, restore only the budget input, and keep it outside Settings autosave.
- [ ] Re-run focused tests and confirm valid 70000 to 40000 save plus actionable conflict response.
- [ ] Commit with fix: explain blocked monthly budget changes.

### Task 3: Implement reload-safe optional display currency UI

Files:
- Modify: apps/miniapp/src/index.html
- Modify: apps/miniapp/src/app.js
- Modify: apps/miniapp/src/i18n.js
- Modify: apps/miniapp/src/styles.css
- Test: apps/miniapp/test/settings.test.js
- Test: apps/miniapp/test/i18n.test.js

- [ ] Write failing state tests for THB base plus USD display after reload, follows-base ON changing THB to GEL while retaining saved USD, follows-base OFF retaining USD, and THB plus USD plus OFF to ON to OFF returning USD.
- [ ] Run npm.cmd test -- apps/miniapp/test/settings.test.js apps/miniapp/test/i18n.test.js and confirm RED.
- [ ] Add the Same as base currency checkbox. Checked hides or disables custom display search/select and uses base as effective display without overwriting the saved custom selection; unchecked exposes that saved custom display. Render the selected option before assigning a select value so iOS cannot show an empty control.
- [ ] Include displayCurrencyFollowsBase in state, queue serialization, restoration, and API payload.
- [ ] Re-run settings, currencies, and i18n tests and confirm GREEN.
- [ ] Commit with fix: make display currency explicitly optional.

### Task 4: Bundle global timezones and use a searchable picker

Files:
- Create: apps/miniapp/src/timezones.js
- Modify: apps/miniapp/src/settings.js
- Modify: apps/miniapp/src/index.html
- Modify: apps/miniapp/src/app.js
- Modify: apps/miniapp/src/i18n.js
- Modify: apps/miniapp/src/styles.css
- Test: apps/miniapp/test/settings.test.js
- Test: apps/miniapp/test/i18n.test.js

- [ ] Write failing fallback tests requiring Tokyo, Oslo, Sydney, Sao Paulo, New York, Cape Town, and Almaty even without Intl.supportedValuesOf. Assert Asia/Bali is absent and Asia/Makassar present, every bundled persisted zone validates with Intl.DateTimeFormat in the supported runtime, and the catalogue order is offset then city.
- [ ] Write failing fixed-instant tests for America/New_York offsets UTC minus 05:00 in January and UTC minus 04:00 in July, plus Asia/Kolkata UTC plus 05:30 and at least one UTC plus 05:45 or UTC plus 09:30 zone.
- [ ] Write failing picker-search tests proving case-insensitive queries New York, New_York, America/New_York, and the current UTC offset identify the same zone.
- [ ] Run npm.cmd test -- apps/miniapp/test/settings.test.js and confirm RED.
- [ ] Commit a deterministic complete runtime-valid IANA catalogue in timezones.js that does not call Intl.supportedValuesOf, excludes Asia/Bali, and includes Asia/Makassar. Validate only catalogue entries that Intl.DateTimeFormat accepts in the supported runtime. Replace the native select with a current-value button and accessible searchable panel; normalize spaces, underscores, and case when searching city, IANA ID, and current UTC offset. Compute the offset for the supplied instant, support non-whole-hour offsets, sort by current UTC offset then city, save the unchanged IANA ID only, show the identifier as secondary text, and retain automatic detection.
- [ ] Run npm.cmd test -- apps/miniapp/test/settings.test.js apps/miniapp/test/i18n.test.js and npm.cmd run build:miniapp.
- [ ] Manually inspect at 375, 390, and 430 CSS pixels in RU/EN and light/dark, then Telegram iOS/Android/Desktop when available.
- [ ] Commit with fix: provide a global timezone picker.

### Task 5: Document, verify, and publish

Files:
- Modify: docs/DOMAIN_RULES.md
- Modify: docs/PRODUCT_CONTEXT.md
- Modify: docs/UI_PRINCIPLES.md

- [ ] Document explicit follow intent, compatible effective display currency, IANA persistence, and dynamic offset labels.
- [ ] Run npm.cmd test, npm.cmd run build:miniapp, git diff --check, and git status --short --branch.
- [ ] Commit documentation with docs: define settings currency and timezone behavior.
- [ ] Push codex/fix-settings-global-timezones and open a draft PR to master. Include migration impact and forward-fix note, client coverage, no production impact, tests, screenshots/limitations, and user release notes in RU/EN.

## Plan self-review

- [x] Budget persistence and actionable reserve/planned conflict cover acceptance criteria 5 to 7.
- [x] Existing display values, reversible intentional follow state, and onboarding defaults cover criteria 1 to 4.
- [x] Bundled global picker, dynamic DST and non-whole-hour offsets, normalized search, automatic detection, and Makassar cover criteria 8 to 11.
- [x] Localization, visual checks, documentation, and draft-only delivery cover criterion 12.
