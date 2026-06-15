# Release Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a manual Telegram admin flow for localized user-facing release digest pushes with audience filtering, duplicate prevention, and blocked-bot handling.

**Architecture:** Add a focused release notes service for formatting, audience filtering, and delivery orchestration. Keep database operations in `repository.js`, Telegram command routing in `telegram.js`, and manual creation in a small script. `audience` is the only authoritative public-send filter; `category` is metadata and helper default input.

**Tech Stack:** Node.js ESM, `node:test`, PostgreSQL through `pg`, existing Money Flow repository and Telegram bot modules.

---

## File Map

- Create `apps/api/src/releaseNotesService.js`: release note formatting, admin preview formatting, admin ID parsing, audience defaults, send orchestration, blocked-bot detection.
- Create `apps/api/test/releaseNotesService.test.js`: service-level tests for audience filtering, localization, duplicate prevention, per-user errors, blocked users, and admin parsing.
- Modify `apps/api/src/repository.js`: release note CRUD/query methods, active user query, delivery insert/check, sent marker, blocked marker.
- Modify `apps/api/test/repository.test.js`: SQL-level tests for new repository methods.
- Modify `apps/api/src/telegram.js`: add admin command gate and wire preview/send commands to release notes service.
- Modify `apps/api/test/telegram.test.js`: admin-only preview/send behavior and empty public notes messages.
- Modify `apps/api/src/config.js`: parse `ADMIN_TELEGRAM_IDS`.
- Modify `.env.example` and `.env.production.example`: document `ADMIN_TELEGRAM_IDS`.
- Modify `apps/api/migrations/001_initial.sql`: add `users.bot_blocked`, `release_notes`, `release_note_deliveries`, idempotent audience constraint handling.
- Create `apps/api/scripts/create-release-note.js`: CLI helper for manual release note creation.
- Modify `package.json`: add `release-note:create` npm script.

## Task 1: Release Notes Service Core

**Files:**
- Create: `apps/api/test/releaseNotesService.test.js`
- Create: `apps/api/src/releaseNotesService.js`

- [ ] **Step 1: Write failing tests for formatter, audience defaults, and admin parsing**

Add `apps/api/test/releaseNotesService.test.js` with tests named:

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  createReleaseNotesService,
  formatReleaseDigest,
  hiddenReleaseNoteLabel,
  isAdminTelegramId,
  normalizeReleaseNoteInput,
  parseAdminTelegramIds
} from "../src/releaseNotesService.js";

test("release note input keeps explicit user audience", () => {
  const input = normalizeReleaseNoteInput({
    version: "v.1.18",
    titleRu: "Онбординг",
    titleEn: "Onboarding",
    bodyRu: "Онбординг стал проще.",
    bodyEn: "Onboarding is now simpler.",
    audience: "user",
    category: "admin"
  });

  assert.equal(input.audience, "user");
  assert.equal(input.category, "admin");
});

test("admin and internal categories default away from user audience", () => {
  assert.equal(normalizeReleaseNoteInput({ category: "admin" }).audience, "admin");
  assert.equal(normalizeReleaseNoteInput({ category: "internal" }).audience, "internal");
  assert.equal(normalizeReleaseNoteInput({ category: "infra" }).audience, "internal");
  assert.equal(normalizeReleaseNoteInput({ category: "analytics" }).audience, "internal");
  assert.equal(normalizeReleaseNoteInput({ category: "onboarding" }).audience, "user");
});

test("digest uses Russian text for ru and unknown languages", () => {
  const note = {
    version: "v.1.18",
    body_ru: "Онбординг стал проще.\nБюджет можно написать одной фразой.",
    body_en: "Onboarding is now simpler."
  };

  assert.match(formatReleaseDigest([note], "ru"), /Что изменилось сегодня/);
  assert.match(formatReleaseDigest([note], "ru"), /• Онбординг стал проще/);
  assert.match(formatReleaseDigest([note], "fr"), /Что изменилось сегодня/);
});

test("digest uses English text for en users", () => {
  const text = formatReleaseDigest([{
    version: "v.1.18",
    body_ru: "Онбординг стал проще.",
    body_en: "Onboarding is now simpler.\nVoice works too."
  }], "en");

  assert.match(text, /Today's updates/);
  assert.match(text, /• Onboarding is now simpler/);
  assert.match(text, /• Voice works too/);
});

test("admin ids parse comma-separated env values", () => {
  assert.deepEqual(parseAdminTelegramIds("123, 456,,789"), new Set(["123", "456", "789"]));
  assert.equal(isAdminTelegramId(456, new Set(["123", "456"])), true);
  assert.equal(isAdminTelegramId(999, new Set(["123", "456"])), false);
});

test("hidden release note label includes audience and title", () => {
  assert.equal(hiddenReleaseNoteLabel({ audience: "admin", title_ru: "добавлена /admin_stats" }), "admin: добавлена /admin_stats");
});
```

- [ ] **Step 2: Run tests and verify red**

Run: `npm test apps/api/test/releaseNotesService.test.js`

Expected: FAIL because `apps/api/src/releaseNotesService.js` does not exist.

- [ ] **Step 3: Implement minimal formatter and helpers**

Create `apps/api/src/releaseNotesService.js` with exports for the tested helpers and a `createReleaseNotesService` skeleton.

- [ ] **Step 4: Run tests and verify green**

Run: `npm test apps/api/test/releaseNotesService.test.js`

Expected: PASS.

## Task 2: Repository Persistence Methods

**Files:**
- Modify: `apps/api/test/repository.test.js`
- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/migrations/001_initial.sql`

- [ ] **Step 1: Write failing repository tests**

Add tests to `apps/api/test/repository.test.js` for:

```js
test("creates a release note with audience and category", async () => {
  const repo = createRepository(fakePool((sql, params) => {
    assert.match(String(sql), /INSERT INTO release_notes/);
    assert.equal(params[0], "v.1.18");
    assert.equal(params[1], "user");
    assert.equal(params[2], "onboarding");
    return { rows: [{ id: "1", version: params[0], audience: params[1], category: params[2] }] };
  }));

  const note = await repo.createReleaseNote({
    version: "v.1.18",
    audience: "user",
    category: "onboarding",
    titleRu: "Онбординг",
    titleEn: "Onboarding",
    bodyRu: "Стало проще.",
    bodyEn: "Simpler.",
    isPublic: true
  });

  assert.equal(note.audience, "user");
});
```

Add SQL shape tests for `getTodayUnsentPublicReleaseNotes(now)`, `getTodayHiddenReleaseNotes(now)`, `getActiveUsersForReleasePush()`, `hasReleaseNoteDelivery(noteId, userId)`, `markReleaseNoteDelivered(noteId, userId)`, `markReleaseNoteSent(noteId)`, and `markUserBotBlocked(userId)`.

- [ ] **Step 2: Run targeted tests and verify red**

Run: `npm test apps/api/test/repository.test.js`

Expected: FAIL because repository methods are missing.

- [ ] **Step 3: Implement repository methods**

Add methods inside `createRepository` using existing `pool.query` style. Use local-day bounds compatible with the project’s UTC+7 helper style for "today":

```sql
released_at >= $1 and released_at < $2
```

`getTodayUnsentPublicReleaseNotes` must include `is_public = true`, `audience = 'user'`, and `sent_at is null`.

- [ ] **Step 4: Update migration**

Add idempotent SQL to create/extend `release_notes`, `release_note_deliveries`, and `users.bot_blocked`. Use a guarded `DO $$ ... $$;` block for `release_notes_audience_check` so repeated startup does not fail.

- [ ] **Step 5: Run repository tests and verify green**

Run: `npm test apps/api/test/repository.test.js`

Expected: PASS.

## Task 3: Release Send Orchestration

**Files:**
- Modify: `apps/api/test/releaseNotesService.test.js`
- Modify: `apps/api/src/releaseNotesService.js`

- [ ] **Step 1: Write failing service tests for send behavior**

Add tests for:

- no user notes means no user sends;
- `audience = admin/internal` notes are ignored by public send;
- users receive localized RU/EN/RU fallback messages;
- repeated run skips existing delivery rows;
- one send failure does not stop remaining users;
- blocked-bot error marks `bot_blocked = true`.

Use fake repository methods and a fake `sendMessage` function injected into the service.

- [ ] **Step 2: Run service tests and verify red**

Run: `npm test apps/api/test/releaseNotesService.test.js`

Expected: FAIL because orchestration is not implemented.

- [ ] **Step 3: Implement orchestration**

Implement `createReleaseNotesService({ repository, sendMessage })` with:

- `createReleaseNote(input)`;
- `previewTodayReleaseDigest(now)`;
- `sendTodayReleaseDigest(now)`;
- `sendReleaseNotesToActiveUsers(releaseNotes, options)`.

Return summary fields: `version`, `users`, `success`, `errors`, `blocked`.

- [ ] **Step 4: Run service tests and verify green**

Run: `npm test apps/api/test/releaseNotesService.test.js`

Expected: PASS.

## Task 4: Telegram Admin Commands

**Files:**
- Modify: `apps/api/test/telegram.test.js`
- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/src/config.js`
- Modify: `.env.example`
- Modify: `.env.production.example`

- [ ] **Step 1: Write failing Telegram tests**

Add tests to `apps/api/test/telegram.test.js` for:

- `/admin_release_preview` denied to non-admin users;
- `/admin_release_send` denied to non-admin users;
- preview for admin shows digest and hidden notes block;
- send for admin returns summary;
- send for admin with only hidden notes returns `Сегодня нет публичных release notes для пользователей — отправлять нечего.`

Construct `createTelegramBot({ adminTelegramIds: new Set(["100"]), releaseNotesService: fakeService })`.

- [ ] **Step 2: Run Telegram tests and verify red**

Run: `npm test apps/api/test/telegram.test.js`

Expected: FAIL because `createTelegramBot` does not accept or handle admin release command dependencies.

- [ ] **Step 3: Implement config and command handling**

In `config.js`, export `adminTelegramIds: parseAdminTelegramIds(process.env.ADMIN_TELEGRAM_IDS)`.

In `telegram.js`, import release notes helpers, pass `adminTelegramIds` and `releaseNotesService` into `createTelegramBot`, and handle admin commands before normal user flows after reading message text.

Expose or reuse `sendMessage` for service delivery without duplicating Telegram HTTP logic.

- [ ] **Step 4: Update env examples**

Add:

```text
ADMIN_TELEGRAM_IDS=
```

- [ ] **Step 5: Run Telegram tests and verify green**

Run: `npm test apps/api/test/telegram.test.js`

Expected: PASS.

## Task 5: Manual Release Note Creation Script

**Files:**
- Create: `apps/api/scripts/create-release-note.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing script smoke test if practical**

If an existing script test pattern is available, add a `node:test` case for argument parsing. If not, keep parsing in an exported function inside the script and test it from `releaseNotesService.test.js` or a new script test.

- [ ] **Step 2: Implement script**

Create a script that:

- loads `.env` through `node --env-file=.env`;
- connects using `pool`;
- creates repository;
- calls `repo.createReleaseNote(normalizeReleaseNoteInput(parsedArgs))`;
- requires at least `--version`, `--title-ru`, and `--body-ru`;
- supports `--title-en`, `--body-en`, `--audience`, `--category`, and `--private`.

- [ ] **Step 3: Add npm script**

In root `package.json`:

```json
"release-note:create": "node --env-file=.env apps/api/scripts/create-release-note.js"
```

- [ ] **Step 4: Run script help/error path**

Run: `node apps/api/scripts/create-release-note.js`

Expected: exits non-zero with a clear missing argument message and no database work.

## Task 6: Full Verification

**Files:**
- All changed files.

- [ ] **Step 1: Run all tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 2: Review git diff**

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git status --short`

Expected: only intended release digest files changed.

- [ ] **Step 3: Commit implementation**

```bash
git add apps/api/src apps/api/test apps/api/migrations apps/api/scripts package.json .env.example .env.production.example docs/superpowers/plans/2026-06-15-release-digest.md
git commit -m "Add release digest pushes"
```
