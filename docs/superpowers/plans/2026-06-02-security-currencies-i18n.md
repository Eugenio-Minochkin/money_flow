# Security, Currencies, I18n Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add production security checks, more currencies with visual flags, interface language settings for Mini App and Telegram bot messages, and category cleanup based on current transactions.

**Architecture:** Keep user settings in `users`; keep currency/category constants in shared modules used by API, parser, and Mini App; keep Telegram formatting language-aware through explicit `language` arguments. Health checks should verify the database, and production security checks should be a repeatable script documented in the runbook.

**Tech Stack:** Node.js ESM, vanilla Mini App JS/CSS, Postgres migrations, Telegram Bot API, `node --test`, Docker Compose production deployment.

---

### Task 1: Production Security And Health

**Files:**
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/test/serverHealth.test.js`
- Create: `scripts/prod-security-check.sh`
- Modify: `docs/security-runbook.md`

- [ ] Write a failing test that `/health` includes `{ ok: true, db: true }` when the repository health check succeeds and returns `503` when it fails.
- [ ] Add `repository.health()` that runs `SELECT 1 AS ok`.
- [ ] Update `/health` to call `repository.health()`.
- [ ] Add `scripts/prod-security-check.sh` to check app health, strict Telegram auth rejection, webhook secret rejection, ports, and latest backup age.
- [ ] Update `docs/security-runbook.md` with the script command.

### Task 2: Currencies With Flags

**Files:**
- Create: `packages/shared/src/currencies.js`
- Create: `packages/shared/test/currencies.test.js`
- Modify: `apps/api/src/exchangeRates.js`
- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/src/expenseParser.js`
- Modify: `packages/shared/src/parser.js`
- Modify: `apps/miniapp/src/app.js`
- Modify: `apps/miniapp/src/formatters.js`

- [ ] Write failing tests for supported currencies: `THB`, `USD`, `RUB`, `IDR`, `EUR`, `BYN`, `GEL`.
- [ ] Add flags and labels to shared currency constants.
- [ ] Expand exchange rate fetching to request all supported non-THB currencies against USD and derive THB conversion.
- [ ] Store all supported currencies in `converted_amounts`.
- [ ] Render currency selects from shared constants and include flags in option labels.
- [ ] Extend parser aliases for Indonesian rupiah, euro, Belarusian ruble, and Georgian lari.

### Task 3: Interface Language Setting

**Files:**
- Modify: `apps/api/migrations/001_initial.sql`
- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/test/repository.test.js`
- Create: `apps/api/src/i18n.js`
- Modify: `apps/api/src/telegramFormat.js`
- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/test/telegramFormat.test.js`
- Modify: `apps/api/test/telegram.test.js`
- Create: `apps/miniapp/src/i18n.js`
- Modify: `apps/miniapp/src/app.js`
- Modify: `apps/miniapp/src/index.html`

- [ ] Add `users.interface_language TEXT NOT NULL DEFAULT 'en'`.
- [ ] Preserve existing production users as Russian by updating rows created before this feature to `ru`.
- [ ] Add settings dropdown with `🇬🇧 English` and `🇷🇺 Русский`.
- [ ] Make Mini App static and dynamic labels switch between Russian and English.
- [ ] Make Telegram `/start`, command totals, draft, saved summary, callbacks, and weekly report use the user's language.

### Task 4: Category Cleanup

**Files:**
- Modify: `packages/shared/src/categories.js`
- Modify: `packages/shared/test/categories.test.js`
- Modify: `apps/miniapp/src/categories.js`
- Modify: `apps/api/src/expenseParser.js`
- Modify: `packages/shared/src/parser.js`
- Modify: `apps/api/migrations/001_initial.sql`

- [ ] Add `education` category.
- [ ] Teach parser that English lessons, learning, courses, and education map to `education`.
- [ ] Migrate active planned expense `English` from `other` to `education`.
- [ ] Migrate planned expense `Оплата квартиры` from `food_cafe` to `home`.
- [ ] Keep current categories otherwise unchanged.

### Task 5: Verification And Deploy

- [ ] Run `node --check` on changed JS files.
- [ ] Run `npm test`.
- [ ] Commit and push to `master`.
- [ ] Deploy production with Docker Compose.
- [ ] Run external `/health`.
- [ ] Run `scripts/prod-security-check.sh` on production.
