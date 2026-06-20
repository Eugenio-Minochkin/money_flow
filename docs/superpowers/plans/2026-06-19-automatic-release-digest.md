# Automatic Release Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically synchronize release notes from merged GitHub PRs and send one concise localized Telegram digest at 21:00 in the configured timezone.

**Architecture:** PostgreSQL stores idempotent PR-sourced release notes, per-user deliveries, and digest run state. A focused release service selects unsent carry-over, enforces compact-message limits, sends localized messages, and records success, failure, or skip outcomes. GitHub Actions identifies the deployed PR and invokes a production sync CLI; an in-process scheduler invokes the same service used by manual admin commands.

**Tech Stack:** Node.js 24 ESM, `node:test`, PostgreSQL via `pg`, Telegram Bot API, GitHub REST API, GitHub Actions, Docker Compose.

---

## File Structure

- Modify `apps/api/migrations/001_initial.sql`: release-note source metadata, digest run table, and unique indexes.
- Modify `apps/api/src/repository.js`: release-note selection, version lookup, idempotent source insert, digest-run lifecycle, and delivery completion queries.
- Modify `apps/api/test/repository.test.js`: SQL contract coverage for all new repository methods.
- Modify `apps/api/src/releaseNotesService.js`: compact selection, localized formatting, preview, run orchestration, and retries.
- Modify `apps/api/test/releaseNotesService.test.js`: service behavior, limits, localization, run states, and carry-over.
- Create `apps/api/src/releaseDigestScheduler.js`: timezone-aware scheduler with an in-memory lock.
- Create `apps/api/test/releaseDigestScheduler.test.js`: deterministic scheduler tick tests.
- Create `apps/api/src/githubReleaseNotes.js`: PR block parser, validation, GitHub fetch, and version normalization.
- Create `apps/api/test/githubReleaseNotes.test.js`: parser, limits, audience, and version tests.
- Create `apps/api/scripts/sync-release-notes-pr.js`: production CLI for one PR.
- Create `apps/api/test/syncReleaseNotesPrScript.test.js`: CLI argument and orchestration tests.
- Modify `apps/api/src/config.js`: scheduler and GitHub configuration.
- Modify `apps/api/src/server.js`: start scheduler and inject the release service.
- Modify `apps/api/src/telegram.js`: switch admin commands from today-based methods to since-last-run methods.
- Modify `apps/api/test/telegram.test.js`: preview and manual override contracts.
- Modify `package.json`: add `release-notes:sync-pr`.
- Modify `.env.production.example`: document scheduler and GitHub environment variables.
- Modify `.github/workflows/deploy.yml`: resolve the PR for the deployed SHA and invoke sync after production checks.
- Modify `test/deploymentWorkflow.test.js`: workflow and runbook contract assertions.

### Task 1: Add Release Source and Digest Run Persistence

**Files:**
- Modify: `apps/api/migrations/001_initial.sql`
- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/test/repository.test.js`

- [ ] **Step 1: Write failing repository tests**

Add tests that assert the exact persistence contracts:

```js
test("creates an idempotent PR-sourced release note", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [{ id: "7", source_type: "github_pr", source_id: "42", audience: "user" }] };
  }));

  const note = await repo.createReleaseNoteFromSource({
    version: "v.1.19",
    audience: "user",
    category: "history",
    titleRu: "Обновление",
    titleEn: "Update",
    bodyRu: "История стала удобнее.",
    bodyEn: "History is easier to use.",
    isPublic: true,
    sourceType: "github_pr",
    sourceId: "42"
  });

  assert.equal(note.source_id, "42");
  assert.match(queries[0].sql, /ON CONFLICT \(source_type, source_id, audience\)/);
  assert.deepEqual(queries[0].params.slice(-2), ["github_pr", "42"]);
});

test("lists unsent public notes including older carry-over", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [{ id: "1", audience: "user" }] };
  }));

  await repo.getUnsentPublicReleaseNotesSince(
    new Date("2026-06-17T14:00:00Z"),
    new Date("2026-06-19T14:00:00Z")
  );

  assert.match(queries[0].sql, /sent_at IS NULL/);
  assert.match(queries[0].sql, /created_at <= \$1/);
  assert.doesNotMatch(queries[0].sql, /created_at > \$2/);
  assert.match(queries[0].sql, /audience = 'user'/);
});

test("records release digest run lifecycle", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    if (/INSERT INTO release_digest_runs/.test(String(sql))) return { rows: [{ id: "9" }] };
    return { rows: [] };
  }));

  const run = await repo.createReleaseDigestRun({
    trigger: "auto",
    sentFrom: null,
    sentTo: new Date("2026-06-19T14:00:00Z"),
    digestLocalDate: "2026-06-19",
    timezone: "Asia/Bangkok"
  });
  await repo.markReleaseDigestRunSuccess(run.id, {
    versionFrom: "v.1.19",
    versionTo: "v.1.20",
    users: 3,
    success: 3,
    errors: 0,
    blocked: 0
  });

  assert.match(queries[0].sql, /INSERT INTO release_digest_runs/);
  assert.match(queries[1].sql, /status = 'success'/);
});
```

- [ ] **Step 2: Run repository tests and confirm RED**

Run:

```bash
node --test apps/api/test/repository.test.js
```

Expected: FAIL because `createReleaseNoteFromSource`, `getUnsentPublicReleaseNotesSince`, and digest-run methods do not exist.

- [ ] **Step 3: Add idempotent schema changes**

Append to `apps/api/migrations/001_initial.sql`:

```sql
ALTER TABLE release_notes ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE release_notes ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE release_notes ADD COLUMN IF NOT EXISTS source_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS release_notes_source_unique
  ON release_notes (source_type, source_id, audience)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS release_digest_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',
  trigger TEXT NOT NULL DEFAULT 'auto',
  sent_from TIMESTAMPTZ,
  sent_to TIMESTAMPTZ NOT NULL,
  version_from TEXT,
  version_to TEXT,
  users_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  digest_local_date TEXT,
  timezone TEXT,
  CONSTRAINT release_digest_runs_status_check
    CHECK (status IN ('running', 'success', 'failed', 'skipped')),
  CONSTRAINT release_digest_runs_trigger_check
    CHECK (trigger IN ('auto', 'manual', 'preview', 'test'))
);

CREATE UNIQUE INDEX IF NOT EXISTS release_digest_runs_auto_date_unique
  ON release_digest_runs (digest_local_date, timezone, trigger)
  WHERE trigger = 'auto' AND status IN ('success', 'skipped', 'running');
```

- [ ] **Step 4: Implement repository methods**

Add these methods to the repository object:

```js
async createReleaseNoteFromSource(input) {
  const result = await pool.query(
    `INSERT INTO release_notes (
       version, audience, category, title_ru, title_en, body_ru, body_en,
       is_public, source_type, source_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (source_type, source_id, audience)
       WHERE source_type IS NOT NULL AND source_id IS NOT NULL
     DO UPDATE SET source_id = EXCLUDED.source_id
     RETURNING *`,
    [
      input.version,
      input.audience,
      input.category ?? null,
      input.titleRu,
      input.titleEn ?? null,
      input.bodyRu,
      input.bodyEn ?? null,
      input.isPublic !== false,
      input.sourceType,
      input.sourceId
    ]
  );
  return result.rows[0];
},

async getLatestPublicReleaseVersion() {
  const result = await pool.query(
    `SELECT version
     FROM release_notes
     WHERE audience = 'user' AND version ~ '^v\\.1\\.[0-9]+$'
     ORDER BY split_part(version, '.', 3)::integer DESC
     LIMIT 1`
  );
  return result.rows[0]?.version ?? null;
},

async getUnsentPublicReleaseNotesSince(_since, until = new Date()) {
  const result = await pool.query(
    `SELECT *
     FROM release_notes
     WHERE created_at <= $1
       AND sent_at IS NULL
       AND is_public = true
       AND audience = 'user'
     ORDER BY created_at ASC, id ASC`,
    [until]
  );
  return result.rows;
},

async getHiddenReleaseNotesSince(since, until = new Date()) {
  const result = await pool.query(
    `SELECT *
     FROM release_notes
     WHERE created_at > COALESCE($1, '-infinity'::timestamptz)
       AND created_at <= $2
       AND audience IN ('admin', 'internal')
     ORDER BY created_at ASC, id ASC`,
    [since, until]
  );
  return result.rows;
},

async getLastSuccessfulReleaseDigestRun() {
  const result = await pool.query(
    `SELECT *
     FROM release_digest_runs
     WHERE status = 'success'
     ORDER BY sent_to DESC, id DESC
     LIMIT 1`
  );
  return result.rows[0] ?? null;
},

async getReleaseDigestRunForLocalDate(localDate, timezone) {
  const result = await pool.query(
    `SELECT *
     FROM release_digest_runs
     WHERE trigger = 'auto'
       AND digest_local_date = $1
       AND timezone = $2
       AND status IN ('running', 'success', 'skipped')
     ORDER BY id DESC
     LIMIT 1`,
    [localDate, timezone]
  );
  return result.rows[0] ?? null;
},

async createReleaseDigestRun(input) {
  try {
    const result = await pool.query(
      `INSERT INTO release_digest_runs (
         trigger, sent_from, sent_to, digest_local_date, timezone
       )
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.trigger, input.sentFrom, input.sentTo, input.digestLocalDate, input.timezone]
    );
    return result.rows[0];
  } catch (error) {
    if (error.code === "23505" && input.trigger === "auto") return null;
    throw error;
  }
},

async markReleaseDigestRunSuccess(id, summary) {
  await pool.query(
    `UPDATE release_digest_runs
     SET status = 'success',
         finished_at = now(),
         version_from = $2,
         version_to = $3,
         users_count = $4,
         success_count = $5,
         error_count = $6,
         blocked_count = $7
     WHERE id = $1`,
    [id, summary.versionFrom, summary.versionTo, summary.users, summary.success, summary.errors, summary.blocked]
  );
},

async markReleaseDigestRunFailed(id, error, summary = {}) {
  await pool.query(
    `UPDATE release_digest_runs
     SET status = 'failed',
         finished_at = now(),
         users_count = $2,
         success_count = $3,
         error_count = $4,
         blocked_count = $5,
         error_message = $6
     WHERE id = $1`,
    [id, summary.users ?? 0, summary.success ?? 0, summary.errors ?? 0, summary.blocked ?? 0, error.message]
  );
},

async markReleaseDigestRunSkipped(id, reason) {
  await pool.query(
    `UPDATE release_digest_runs
     SET status = 'skipped', finished_at = now(), error_message = $2
     WHERE id = $1`,
    [id, reason]
  );
}
```

- [ ] **Step 5: Run repository tests and confirm GREEN**

Run:

```bash
node --test apps/api/test/repository.test.js
```

Expected: all repository tests pass.

- [ ] **Step 6: Commit persistence layer**

```bash
git add apps/api/migrations/001_initial.sql apps/api/src/repository.js apps/api/test/repository.test.js
git commit -m "Add release digest run persistence"
```

### Task 2: Enforce Compact Localized Digest Selection

**Files:**
- Modify: `apps/api/src/releaseNotesService.js`
- Modify: `apps/api/test/releaseNotesService.test.js`

- [ ] **Step 1: Write failing formatter and selection tests**

Add:

```js
test("digest uses compact headings and Russian fallback", () => {
  const text = formatReleaseDigest([releaseNote({ body_en: null })], "en");
  assert.match(text, /What's new:/);
  assert.match(text, /Онбординг стал проще/);
  assert.ok(text.length <= 900);
});

test("selectDigestReleaseNotes keeps overflow pending", () => {
  const notes = Array.from({ length: 7 }, (_, index) => releaseNote({
    id: index + 1,
    body_ru: `Улучшение ${index + 1}.`,
    body_en: `Improvement ${index + 1}.`
  }));

  const selected = selectDigestReleaseNotes(notes);

  assert.equal(selected.length, 6);
  assert.deepEqual(selected.map((note) => note.id), [1, 2, 3, 4, 5, 6]);
});

test("release block sized note rejects bullets over 120 characters", () => {
  assert.throws(
    () => validateReleaseNoteContent({
      bodyRu: "а".repeat(121),
      bodyEn: "Short."
    }),
    /120 characters/
  );
});
```

Import the new exports:

```js
import {
  formatReleaseDigest,
  selectDigestReleaseNotes,
  validateReleaseNoteContent
} from "../src/releaseNotesService.js";
```

- [ ] **Step 2: Run service tests and confirm RED**

Run:

```bash
node --test apps/api/test/releaseNotesService.test.js
```

Expected: FAIL because compact headings and selection helpers are missing.

- [ ] **Step 3: Implement limits and compact formatting**

Add constants and helpers:

```js
export const RELEASE_DIGEST_MAX_BULLETS = 6;
export const RELEASE_DIGEST_MAX_BULLET_CHARS = 120;
export const RELEASE_DIGEST_MAX_MESSAGE_CHARS = 900;

export function validateReleaseNoteContent(input) {
  for (const [label, body] of [["RU", input.bodyRu], ["EN", input.bodyEn]]) {
    if (!body) continue;
    const lines = bodyLines(body);
    if (lines.length > RELEASE_DIGEST_MAX_BULLETS) {
      throw new Error(`${label} release notes exceed 6 bullets`);
    }
    if (lines.some((line) => line.length > RELEASE_DIGEST_MAX_BULLET_CHARS)) {
      throw new Error(`${label} release note bullet exceeds 120 characters`);
    }
  }
  return input;
}

export function selectDigestReleaseNotes(notes) {
  const selected = [];
  for (const note of notes) {
    if (selected.length >= RELEASE_DIGEST_MAX_BULLETS) break;
    const candidate = [...selected, note];
    const ru = formatReleaseDigest(candidate, "ru");
    const en = formatReleaseDigest(candidate, "en");
    if (ru.length > RELEASE_DIGEST_MAX_MESSAGE_CHARS || en.length > RELEASE_DIGEST_MAX_MESSAGE_CHARS) break;
    const ruBulletCount = candidate.flatMap((item) => bodyLinesForLanguage(item, "ru")).length;
    const enBulletCount = candidate.flatMap((item) => bodyLinesForLanguage(item, "en")).length;
    if (ruBulletCount > RELEASE_DIGEST_MAX_BULLETS || enBulletCount > RELEASE_DIGEST_MAX_BULLETS) break;
    selected.push(note);
  }
  return selected;
}

function bodyLines(body) {
  return String(body ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^•\s*/, ""))
    .filter(Boolean);
}
```

Update `formatReleaseDigest` to use:

```js
const heading = lang === "en" ? "What's new:" : "Что нового:";
const versions = notes.map((note) => note.version).filter(Boolean);
const version = versions.at(-1) ?? "";
```

Update `bodyLinesForLanguage` to call `bodyLines`.

- [ ] **Step 4: Run service tests and confirm GREEN**

Run:

```bash
node --test apps/api/test/releaseNotesService.test.js
```

Expected: all formatter tests pass.

- [ ] **Step 5: Commit compact formatting**

```bash
git add apps/api/src/releaseNotesService.js apps/api/test/releaseNotesService.test.js
git commit -m "Add compact localized release digests"
```

### Task 3: Orchestrate Since-Last-Run Preview and Sending

**Files:**
- Modify: `apps/api/src/releaseNotesService.js`
- Modify: `apps/api/test/releaseNotesService.test.js`

- [ ] **Step 1: Write failing run-orchestration tests**

Add service tests:

```js
test("send since last run creates skipped run when no public notes exist", async () => {
  const repo = fakeReleaseRepository({ notes: [] });
  const service = createReleaseNotesService({ repository: repo, sendMessage: async () => {} });

  const result = await service.sendReleaseDigestSinceLastRun(
    new Date("2026-06-19T14:00:00Z"),
    { trigger: "auto", timezone: "Asia/Bangkok", localDate: "2026-06-19" }
  );

  assert.equal(result.sent, false);
  assert.equal(result.reason, "no_public_release_notes");
  assert.deepEqual(repo.skippedRuns, [[1, "no_public_release_notes"]]);
});

test("duplicate automatic run exits without sending", async () => {
  const sent = [];
  const repo = fakeReleaseRepository({
    notes: [releaseNote()],
    duplicateAutoRun: true
  });
  const service = createReleaseNotesService({
    repository: repo,
    sendMessage: async (message) => sent.push(message)
  });

  const result = await service.sendReleaseDigestSinceLastRun(
    new Date("2026-06-19T14:00:00Z"),
    { trigger: "auto", timezone: "Asia/Bangkok", localDate: "2026-06-19" }
  );

  assert.equal(result.reason, "duplicate_auto_run");
  assert.equal(sent.length, 0);
});

test("send since last run records success and leaves overflow unsent", async () => {
  const notes = Array.from({ length: 7 }, (_, index) => releaseNote({
    id: index + 1,
    version: `v.1.${19 + index}`,
    body_ru: `Улучшение ${index + 1}.`,
    body_en: `Improvement ${index + 1}.`
  }));
  const repo = fakeReleaseRepository({
    notes,
    users: [{ id: 1, telegram_user_id: 100, interface_language: "ru" }]
  });
  const service = createReleaseNotesService({
    repository: repo,
    sendMessage: async () => ({ ok: true })
  });

  const result = await service.sendReleaseDigestSinceLastRun(
    new Date("2026-06-19T14:00:00Z"),
    { trigger: "manual", timezone: "Asia/Bangkok", localDate: "2026-06-19" }
  );

  assert.equal(result.notes, 6);
  assert.deepEqual(repo.sentNotes, [1, 2, 3, 4, 5, 6]);
  assert.doesNotMatch(JSON.stringify(repo.sentNotes), /7/);
  assert.equal(repo.successRuns.length, 1);
});

test("preview shows RU EN period hidden notes and missing EN warning", async () => {
  const repo = fakeReleaseRepository({
    lastRun: { sent_to: new Date("2026-06-18T14:00:00Z") },
    notes: [releaseNote({ body_en: null })],
    hiddenNotes: [{ audience: "internal", title_ru: "Техническое изменение" }]
  });
  const service = createReleaseNotesService({ repository: repo });

  const preview = await service.previewReleaseDigestSinceLastRun(new Date("2026-06-19T14:00:00Z"));

  assert.match(preview.text, /RU preview:/);
  assert.match(preview.text, /EN preview:/);
  assert.match(preview.text, /2026-06-18/);
  assert.match(preview.text, /internal: Техническое изменение/);
  assert.match(preview.text, /нет EN-текста/);
});
```

- [ ] **Step 2: Run service tests and confirm RED**

Run:

```bash
node --test apps/api/test/releaseNotesService.test.js
```

Expected: FAIL because since-last-run methods and run recording do not exist.

- [ ] **Step 3: Implement shared pending-range lookup**

Add:

```js
async function getPendingReleaseContext(repository, now) {
  const lastRun = await repository.getLastSuccessfulReleaseDigestRun();
  const sentFrom = lastRun?.sent_to ?? null;
  const releaseNotes = await repository.getUnsentPublicReleaseNotesSince(sentFrom, now);
  const hiddenNotes = await repository.getHiddenReleaseNotesSince(sentFrom, now);
  return {
    sentFrom,
    sentTo: now,
    releaseNotes,
    selectedNotes: selectDigestReleaseNotes(releaseNotes),
    hiddenNotes
  };
}
```

- [ ] **Step 4: Implement preview and send methods**

Replace today-based methods with:

```js
async previewReleaseDigestSinceLastRun(now = new Date()) {
  const context = await getPendingReleaseContext(repository, now);
  const missingEnglish = context.selectedNotes.some((note) => !note.body_en);
  const period = `${formatIsoMinute(context.sentFrom)} → ${formatIsoMinute(context.sentTo)}`;
  if (context.selectedNotes.length === 0) {
    return {
      hasPublicNotes: false,
      ...context,
      text: [
        "Нет новых публичных изменений для пользователей с прошлого дайджеста — отправлять нечего.",
        `Период: ${period}`,
        hiddenNotesBlock(context.hiddenNotes)
      ].filter(Boolean).join("\n\n")
    };
  }
  return {
    hasPublicNotes: true,
    ...context,
    text: [
      "Пользователям будет отправлено в следующий digest:",
      "",
      "RU preview:",
      formatReleaseDigest(context.selectedNotes, "ru"),
      "",
      "EN preview:",
      formatReleaseDigest(context.selectedNotes, "en"),
      "",
      `Период: ${period}`,
      hiddenNotesBlock(context.hiddenNotes),
      missingEnglish
        ? "⚠️ У некоторых release notes нет EN-текста. Английские пользователи получат русский fallback."
        : ""
    ].filter(Boolean).join("\n")
  };
},

async sendReleaseDigestSinceLastRun(now = new Date(), options = {}) {
  const trigger = options.trigger ?? "manual";
  const timezone = options.timezone ?? "Asia/Bangkok";
  const localDate = options.localDate ?? formatLocalDate(now, timezone);
  const context = await getPendingReleaseContext(repository, now);
  const run = await repository.createReleaseDigestRun({
    trigger,
    sentFrom: context.sentFrom,
    sentTo: context.sentTo,
    digestLocalDate: localDate,
    timezone
  });
  if (!run) {
    return { ...emptyReleaseSummary(), reason: "duplicate_auto_run" };
  }
  if (context.selectedNotes.length === 0) {
    await repository.markReleaseDigestRunSkipped(run.id, "no_public_release_notes");
    return emptyReleaseSummary();
  }
  try {
    const summary = await this.sendReleaseNotesToActiveUsers(context.selectedNotes);
    summary.notes = context.selectedNotes.length;
    summary.versionFrom = context.selectedNotes[0]?.version ?? null;
    summary.versionTo = context.selectedNotes.at(-1)?.version ?? null;
    const nonBlockedErrors = summary.errors - summary.blocked;
    if (nonBlockedErrors > 0) {
      await repository.markReleaseDigestRunFailed(run.id, new Error("release_digest_partial_failure"), summary);
    } else {
      await repository.markReleaseDigestRunSuccess(run.id, summary);
    }
    return summary;
  } catch (error) {
    await repository.markReleaseDigestRunFailed(run.id, error);
    throw error;
  }
}
```

Add the helpers used by these methods:

```js
function emptyReleaseSummary() {
  return {
    sent: false,
    reason: "no_public_release_notes",
    version: null,
    versionFrom: null,
    versionTo: null,
    notes: 0,
    users: 0,
    success: 0,
    errors: 0,
    blocked: 0
  };
}

function formatIsoMinute(value) {
  return value ? new Date(value).toISOString().slice(0, 16).replace("T", " ") : "первый digest";
}

function formatLocalDate(now, timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}
```

Use a single Telegram message per user for all selected notes. After sending,
mark one delivery row per selected note/user pair. Mark a note sent only when
`repository.countMissingReleaseNoteDeliveries(note.id)` returns zero.

- [ ] **Step 5: Add delivery-completion repository method**

Add and test:

```js
async countMissingReleaseNoteDeliveries(releaseNoteId) {
  const result = await pool.query(
    `SELECT count(*)::integer AS count
     FROM users u
     WHERE u.telegram_user_id IS NOT NULL
       AND u.onboarding_step = 'completed'
       AND u.bot_blocked = false
       AND NOT EXISTS (
         SELECT 1
         FROM release_note_deliveries d
         WHERE d.release_note_id = $1 AND d.user_id = u.id
       )`,
    [releaseNoteId]
  );
  return Number(result.rows[0]?.count ?? 0);
}
```

- [ ] **Step 6: Run service and repository tests**

Run:

```bash
node --test apps/api/test/releaseNotesService.test.js apps/api/test/repository.test.js
```

Expected: all tests pass.

- [ ] **Step 7: Commit run orchestration**

```bash
git add apps/api/src/releaseNotesService.js apps/api/test/releaseNotesService.test.js apps/api/src/repository.js apps/api/test/repository.test.js
git commit -m "Send release digests since the last run"
```

### Task 4: Add the Timezone-Aware Scheduler

**Files:**
- Create: `apps/api/src/releaseDigestScheduler.js`
- Create: `apps/api/test/releaseDigestScheduler.test.js`

- [ ] **Step 1: Write failing scheduler tests**

Create:

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  createReleaseDigestScheduler,
  releaseDigestLocalParts
} from "../src/releaseDigestScheduler.js";

test("local parts use configured timezone", () => {
  assert.deepEqual(
    releaseDigestLocalParts(new Date("2026-06-19T14:05:00Z"), "Asia/Bangkok"),
    { date: "2026-06-19", hour: 21 }
  );
});

test("disabled scheduler does not send", async () => {
  let sends = 0;
  const scheduler = createReleaseDigestScheduler({
    enabled: false,
    timezone: "Asia/Bangkok",
    sendHour: 21,
    releaseNotesService: { async sendReleaseDigestSinceLastRun() { sends += 1; } },
    repository: {}
  });
  await scheduler.tick(new Date("2026-06-19T14:00:00Z"));
  assert.equal(sends, 0);
});

test("same local date sends only once", async () => {
  let sends = 0;
  const repository = {
    existing: null,
    async getReleaseDigestRunForLocalDate() { return this.existing; }
  };
  const scheduler = createReleaseDigestScheduler({
    enabled: true,
    timezone: "Asia/Bangkok",
    sendHour: 21,
    repository,
    releaseNotesService: {
      async sendReleaseDigestSinceLastRun() {
        sends += 1;
        repository.existing = { status: "success" };
      }
    }
  });

  await scheduler.tick(new Date("2026-06-19T14:00:00Z"));
  await scheduler.tick(new Date("2026-06-19T14:15:00Z"));
  assert.equal(sends, 1);
});
```

- [ ] **Step 2: Run scheduler tests and confirm RED**

Run:

```bash
node --test apps/api/test/releaseDigestScheduler.test.js
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement scheduler module**

Create:

```js
export function releaseDigestLocalParts(now, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour)
  };
}

export function createReleaseDigestScheduler(options) {
  let running = false;
  let intervalId = null;

  async function tick(now = new Date()) {
    if (!options.enabled || running) return { skipped: true };
    const local = releaseDigestLocalParts(now, options.timezone);
    if (local.hour !== options.sendHour) return { skipped: true };
    if (await options.repository.getReleaseDigestRunForLocalDate(local.date, options.timezone)) {
      return { skipped: true };
    }
    running = true;
    try {
      return await options.releaseNotesService.sendReleaseDigestSinceLastRun(now, {
        trigger: "auto",
        timezone: options.timezone,
        localDate: local.date
      });
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (!options.enabled || intervalId) return;
      const intervalMs = options.checkIntervalMinutes * 60_000;
      setTimeout(() => tick().catch(options.onError), 10_000);
      intervalId = setInterval(() => tick().catch(options.onError), intervalMs);
    },
    stop() {
      if (intervalId) clearInterval(intervalId);
      intervalId = null;
    }
  };
}
```

- [ ] **Step 4: Run scheduler tests and confirm GREEN**

Run:

```bash
node --test apps/api/test/releaseDigestScheduler.test.js
```

Expected: all scheduler tests pass.

- [ ] **Step 5: Commit scheduler**

```bash
git add apps/api/src/releaseDigestScheduler.js apps/api/test/releaseDigestScheduler.test.js
git commit -m "Add automatic release digest scheduler"
```

### Task 5: Parse PR Release Blocks and Assign Versions

**Files:**
- Create: `apps/api/src/githubReleaseNotes.js`
- Create: `apps/api/test/githubReleaseNotes.test.js`

- [ ] **Step 1: Write failing parser and version tests**

Create:

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  nextPublicReleaseVersion,
  parseUserReleaseNotesBlock
} from "../src/githubReleaseNotes.js";

test("parses user release notes block", () => {
  const parsed = parseUserReleaseNotesBlock(`
## User Release Notes

audience: user
version: v.1.19
category: history

RU:
- История получила выбор периода.

EN:
- History now has a period picker.
`);

  assert.deepEqual(parsed, {
    audience: "user",
    version: "v.1.19",
    category: "history",
    bodyRu: "История получила выбор периода.",
    bodyEn: "History now has a period picker."
  });
});

test("missing block returns null", () => {
  assert.equal(parseUserReleaseNotesBlock("Regular PR description"), null);
});

test("next version repairs missing invalid duplicate and stale values", () => {
  assert.equal(nextPublicReleaseVersion("v.1.18", "v.1.19"), "v.1.19");
  assert.equal(nextPublicReleaseVersion("v.1.18", null), "v.1.19");
  assert.equal(nextPublicReleaseVersion("v.1.18", "v0.1.20"), "v.1.19");
  assert.equal(nextPublicReleaseVersion("v.1.19", "v.1.19"), "v.1.20");
});

test("admin notes do not require or advance a version", () => {
  const parsed = parseUserReleaseNotesBlock(`
## User Release Notes
audience: admin
RU:
- Добавлена админская команда.
`);
  assert.equal(parsed.audience, "admin");
  assert.equal(parsed.version, null);
});
```

- [ ] **Step 2: Run parser tests and confirm RED**

Run:

```bash
node --test apps/api/test/githubReleaseNotes.test.js
```

Expected: FAIL because the parser module does not exist.

- [ ] **Step 3: Implement parser and version helpers**

Create exports:

```js
import { validateReleaseNoteContent } from "./releaseNotesService.js";

const AUDIENCES = new Set(["user", "admin", "internal"]);
const VERSION_PATTERN = /^v\.1\.(\d+)$/;

export function nextPublicReleaseVersion(latestVersion, requestedVersion) {
  const latestPatch = Number(VERSION_PATTERN.exec(latestVersion ?? "")?.[1] ?? 17);
  const requestedPatch = Number(VERSION_PATTERN.exec(requestedVersion ?? "")?.[1]);
  if (Number.isInteger(requestedPatch) && requestedPatch > latestPatch) {
    return `v.1.${requestedPatch}`;
  }
  return `v.1.${latestPatch + 1}`;
}

export function parseUserReleaseNotesBlock(body) {
  const section = String(body ?? "").split(/^##\s+/m)
    .find((candidate) => candidate.trimStart().startsWith("User Release Notes"));
  if (!section) return null;

  const audience = field(section, "audience") || "internal";
  if (!AUDIENCES.has(audience)) throw new Error(`Unsupported release audience: ${audience}`);
  const category = field(section, "category") || null;
  const version = field(section, "version") || null;
  const bodyRu = languageBullets(section, "RU");
  const bodyEn = languageBullets(section, "EN") || null;
  if (!bodyRu) throw new Error("User Release Notes RU bullets are required");

  validateReleaseNoteContent({ bodyRu, bodyEn });
  return { audience, version, category, bodyRu, bodyEn };
}

function field(section, name) {
  return new RegExp(`^${name}:\\s*(.+)$`, "mi").exec(section)?.[1]?.trim() ?? "";
}

function languageBullets(section, language) {
  const match = new RegExp(`^${language}:\\s*\\n([\\s\\S]*?)(?=^[A-Z]{2}:|^##\\s|$)`, "mi").exec(section);
  if (!match) return "";
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .join("\n");
}
```

- [ ] **Step 4: Run parser tests and confirm GREEN**

Run:

```bash
node --test apps/api/test/githubReleaseNotes.test.js
```

Expected: all parser and version tests pass.

- [ ] **Step 5: Commit parser**

```bash
git add apps/api/src/githubReleaseNotes.js apps/api/test/githubReleaseNotes.test.js
git commit -m "Parse GitHub release note blocks"
```

### Task 6: Add the Production PR Synchronization CLI

**Files:**
- Modify: `apps/api/src/githubReleaseNotes.js`
- Create: `apps/api/scripts/sync-release-notes-pr.js`
- Create: `apps/api/test/syncReleaseNotesPrScript.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing CLI orchestration tests**

Create:

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  parseSyncPrArgs,
  syncReleaseNotesFromPr
} from "../scripts/sync-release-notes-pr.js";

test("parses required PR number", () => {
  assert.deepEqual(parseSyncPrArgs(["--pr=42"]), { prNumber: 42 });
  assert.throws(() => parseSyncPrArgs([]), /--pr is required/);
});

test("sync stores an idempotent user note with repaired version", async () => {
  const repository = {
    async getLatestPublicReleaseVersion() { return "v.1.18"; },
    async createReleaseNoteFromSource(input) { this.input = input; return { id: 1, ...input }; }
  };
  const result = await syncReleaseNotesFromPr({
    prNumber: 42,
    repository,
    fetchPullRequest: async () => ({
      title: "History filters",
      body: `
## User Release Notes
audience: user
RU:
- История получила выбор периода.
EN:
- History now has a period picker.
`
    })
  });

  assert.equal(result.version, "v.1.19");
  assert.equal(repository.input.sourceType, "github_pr");
  assert.equal(repository.input.sourceId, "42");
});

test("sync warns and skips PR without release block", async () => {
  const result = await syncReleaseNotesFromPr({
    prNumber: 42,
    repository: {},
    fetchPullRequest: async () => ({ title: "Internal", body: "No release block" })
  });
  assert.deepEqual(result, { synced: false, reason: "missing_release_block" });
});
```

- [ ] **Step 2: Run CLI tests and confirm RED**

Run:

```bash
node --test apps/api/test/syncReleaseNotesPrScript.test.js
```

Expected: FAIL because the sync CLI does not exist.

- [ ] **Step 3: Implement GitHub PR fetch**

Add to `githubReleaseNotes.js`:

```js
export async function fetchGitHubPullRequest({ repository, prNumber, token, fetchImpl = fetch }) {
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/pulls/${prNumber}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28"
    }
  });
  if (!response.ok) {
    throw new Error(`GitHub PR fetch failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}
```

- [ ] **Step 4: Implement sync CLI**

Create the script with exported functions and a guarded `main()`:

```js
export function parseSyncPrArgs(args) {
  const raw = args.find((arg) => arg.startsWith("--pr="))?.slice(5);
  const prNumber = Number(raw);
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error("--pr is required");
  return { prNumber };
}

export async function syncReleaseNotesFromPr({ prNumber, repository, fetchPullRequest }) {
  const pullRequest = await fetchPullRequest(prNumber);
  const parsed = parseUserReleaseNotesBlock(pullRequest.body);
  if (!parsed) return { synced: false, reason: "missing_release_block" };

  const latestVersion = await repository.getLatestPublicReleaseVersion();
  const version = parsed.audience === "user"
    ? nextPublicReleaseVersion(latestVersion, parsed.version)
    : latestVersion ?? "v.1.18";

  const note = await repository.createReleaseNoteFromSource({
    version,
    audience: parsed.audience,
    category: parsed.category,
    titleRu: pullRequest.title,
    titleEn: pullRequest.title,
    bodyRu: parsed.bodyRu,
    bodyEn: parsed.bodyEn,
    isPublic: parsed.audience === "user",
    sourceType: "github_pr",
    sourceId: String(prNumber)
  });
  return { synced: true, ...note };
}
```

In `main`, require `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, and `DATABASE_URL`,
create the repository, fetch the PR, print only PR number, audience, version,
and sync outcome, then close the DB in `finally`.

- [ ] **Step 5: Add npm script**

Add:

```json
"release-notes:sync-pr": "node apps/api/scripts/sync-release-notes-pr.js"
```

The production deploy invokes the script inside the API container with
`docker compose exec -T api npm run release-notes:sync-pr -- --pr=<number>`.
Docker Compose already injects `.env.production` into that container.

- [ ] **Step 6: Run CLI and parser tests**

Run:

```bash
node --test apps/api/test/githubReleaseNotes.test.js apps/api/test/syncReleaseNotesPrScript.test.js
```

Expected: all tests pass.

- [ ] **Step 7: Commit sync CLI**

```bash
git add apps/api/src/githubReleaseNotes.js apps/api/scripts/sync-release-notes-pr.js apps/api/test/githubReleaseNotes.test.js apps/api/test/syncReleaseNotesPrScript.test.js package.json
git commit -m "Sync release notes from GitHub PRs"
```

### Task 7: Wire Scheduler and Admin Commands into the API

**Files:**
- Modify: `apps/api/src/config.js`
- Modify: `.env.production.example`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/test/telegram.test.js`

- [ ] **Step 1: Write failing admin-command tests**

Update the fake release service and assertions:

```js
test("admin release preview uses pending notes since the last digest", async () => {
  const calls = [];
  const service = {
    async previewReleaseDigestSinceLastRun() {
      calls.push("preview");
      return { text: "next digest preview" };
    }
  };
  const bot = createTelegramBot({
    repository: fakeRepository(),
    adminTelegramIds: new Set([100]),
    releaseNotesService: service,
    telegramClient: captureTelegramClient([])
  });

  await bot.handleUpdate({ message: { chat: { id: 10 }, from: { id: 100 }, text: "/admin_release_preview" } });
  assert.deepEqual(calls, ["preview"]);
});

test("admin release send uses manual trigger", async () => {
  const calls = [];
  const service = {
    async sendReleaseDigestSinceLastRun(now, options) {
      calls.push(options);
      return { sent: false, reason: "no_public_release_notes" };
    }
  };
  const bot = createTelegramBot({
    repository: fakeRepository(),
    adminTelegramIds: new Set([100]),
    releaseNotesService: service,
    telegramClient: captureTelegramClient([])
  });

  await bot.handleUpdate({ message: { chat: { id: 10 }, from: { id: 100 }, text: "/admin_release_send" } });
  assert.equal(calls[0].trigger, "manual");
});
```

- [ ] **Step 2: Run Telegram tests and confirm RED**

Run:

```bash
node --test apps/api/test/telegram.test.js
```

Expected: FAIL because admin commands still call today-based methods.

- [ ] **Step 3: Add configuration**

Add to `config.js`:

```js
releaseDigestAutoSendEnabled: process.env.RELEASE_DIGEST_AUTO_SEND_ENABLED === "true",
releaseDigestTimezone: process.env.RELEASE_DIGEST_TIMEZONE ?? "Asia/Bangkok",
releaseDigestSendHour: Number(process.env.RELEASE_DIGEST_SEND_HOUR ?? 21),
releaseDigestCheckIntervalMinutes: Number(process.env.RELEASE_DIGEST_CHECK_INTERVAL_MINUTES ?? 15),
githubToken: process.env.GITHUB_TOKEN,
githubRepository: process.env.GITHUB_REPOSITORY
```

Add to `.env.production.example`:

```env
RELEASE_DIGEST_AUTO_SEND_ENABLED=true
RELEASE_DIGEST_TIMEZONE=Asia/Bangkok
RELEASE_DIGEST_SEND_HOUR=21
RELEASE_DIGEST_CHECK_INTERVAL_MINUTES=15
GITHUB_TOKEN=
GITHUB_REPOSITORY=Eugenio-Minochkin/money_flow
```

- [ ] **Step 4: Update admin commands**

Replace:

```js
releaseNotesService.previewTodayReleaseDigest(now())
releaseNotesService.sendTodayReleaseDigest(now())
```

with:

```js
releaseNotesService.previewReleaseDigestSinceLastRun(now())
releaseNotesService.sendReleaseDigestSinceLastRun(now(), { trigger: "manual" })
```

Change the empty message to:

```text
Нет новых публичных изменений для пользователей с прошлого дайджеста — отправлять нечего.
```

- [ ] **Step 5: Start scheduler from server**

Import `createReleaseDigestScheduler`, construct it after
`releaseNotesService`, and call `start()`:

```js
const releaseDigestScheduler = createReleaseDigestScheduler({
  enabled: config.releaseDigestAutoSendEnabled,
  timezone: config.releaseDigestTimezone,
  sendHour: config.releaseDigestSendHour,
  checkIntervalMinutes: config.releaseDigestCheckIntervalMinutes,
  repository,
  releaseNotesService,
  onError(error) {
    console.error("[release-digest] scheduler failed", error);
  }
});
releaseDigestScheduler.start();
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test apps/api/test/telegram.test.js apps/api/test/releaseDigestScheduler.test.js apps/api/test/releaseNotesService.test.js
```

Expected: all focused tests pass.

- [ ] **Step 7: Commit API wiring**

```bash
git add apps/api/src/config.js .env.production.example apps/api/src/server.js apps/api/src/telegram.js apps/api/test/telegram.test.js
git commit -m "Wire automatic release digest sending"
```

### Task 8: Integrate PR Discovery with Production Deploy

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Modify: `test/deploymentWorkflow.test.js`
- Modify: `docs/deployment-runbook.md`

- [ ] **Step 1: Write failing workflow contract test**

Add:

```js
test("deploy resolves merged PR and syncs release notes after production checks", async () => {
  const workflow = await readFile(new URL("../../../.github/workflows/deploy.yml", import.meta.url), "utf8");

  assert.match(workflow, /pulls\/\$\{?DEPLOY_SHA/);
  assert.match(workflow, /release-notes:sync-pr/);
  assert.ok(workflow.indexOf("prod-security-check.sh") < workflow.indexOf("release-notes:sync-pr"));
  assert.match(workflow, /GITHUB_TOKEN/);
});
```

Place this test in `test/deploymentWorkflow.test.js` beside the existing
workflow and runbook assertions and reuse its existing file-reading helpers.

- [ ] **Step 2: Run workflow test and confirm RED**

Run:

```bash
node --test test/deploymentWorkflow.test.js
```

Expected: FAIL because deploy does not discover or synchronize a PR.

- [ ] **Step 3: Add PR discovery step**

Before SSH deploy, add a step with `id: release_pr`:

```yaml
- name: Resolve deployed pull request
  id: release_pr
  env:
    GH_TOKEN: ${{ github.token }}
    DEPLOY_SHA: ${{ github.event.inputs.ref || github.sha }}
  run: |
    set -euo pipefail
    pr_number="$(
      gh api \
        -H 'Accept: application/vnd.github+json' \
        "/repos/${GITHUB_REPOSITORY}/commits/${DEPLOY_SHA}/pulls" \
        --jq '[.[] | select(.merged_at != null and .base.ref == "master")] | first | .number // empty'
    )"
    echo "pr_number=$pr_number" >> "$GITHUB_OUTPUT"
```

For manual deployments of an arbitrary ref with no associated PR, leave the
number empty and emit a warning after deploy. For a push to `master`, an empty
PR number is a workflow failure because normal automatic synchronization
cannot proceed.

- [ ] **Step 4: Invoke sync after production checks**

Pass `RELEASE_PR_NUMBER` into the SSH step and append after
`./scripts/prod-security-check.sh`:

```bash
if [ -n "$RELEASE_PR_NUMBER" ]; then
  docker compose --env-file .env.production -f compose.prod.yml exec -T api \
    node apps/api/scripts/sync-release-notes-pr.js --pr="$RELEASE_PR_NUMBER"
elif [ "$GITHUB_EVENT_NAME" = "push" ]; then
  echo "No merged PR associated with deployed master SHA" >&2
  exit 1
else
  echo "Warning: no PR associated with manual deploy ref; release note sync skipped" >&2
fi
```

Pass `GITHUB_EVENT_NAME` as an explicit remote environment value. Ensure the
API container receives `GITHUB_TOKEN` and `GITHUB_REPOSITORY` from
`.env.production`; do not print either value.

- [ ] **Step 5: Document the release block and production variables**

In `docs/deployment-runbook.md`, add:

```markdown
## Automatic release digest

Every user-facing PR includes a `## User Release Notes` block with `audience`,
optional `version`, optional `category`, required RU bullets, and optional EN
bullets. After production health checks, deploy synchronizes that PR into the
database. The API sends pending user notes at 21:00 in
`RELEASE_DIGEST_TIMEZONE`.

Required production variables:

- `RELEASE_DIGEST_AUTO_SEND_ENABLED`
- `RELEASE_DIGEST_TIMEZONE`
- `RELEASE_DIGEST_SEND_HOUR`
- `RELEASE_DIGEST_CHECK_INTERVAL_MINUTES`
- `GITHUB_TOKEN`
- `GITHUB_REPOSITORY`
```

- [ ] **Step 6: Run workflow contract and full test suite**

Run:

```bash
node --test test/deploymentWorkflow.test.js
npm test
git diff --check
```

Expected:

- workflow contract passes;
- all project tests pass with zero failures;
- `git diff --check` prints no output.

- [ ] **Step 7: Commit deployment integration**

```bash
git add .github/workflows/deploy.yml test/deploymentWorkflow.test.js docs/deployment-runbook.md
git commit -m "Sync release notes after production deploy"
```

### Task 9: Final Production-Oriented Verification

**Files:**
- No new files unless verification exposes a defect.

- [ ] **Step 1: Verify module imports**

Run:

```bash
node -e "import('./apps/api/src/releaseDigestScheduler.js'); import('./apps/api/src/githubReleaseNotes.js'); import('./apps/api/src/releaseNotesService.js')"
```

Expected: exit code 0 with no `SyntaxError`.

- [ ] **Step 2: Verify all tests from a clean process**

Run:

```bash
npm test
```

Expected: zero failed tests.

- [ ] **Step 3: Verify migration idempotency in Docker**

Run:

```bash
docker compose up -d postgres
npm run dev:api
```

After `/health` returns `{"ok":true,"db":true}`, stop the API process and start
it a second time. Expected: both starts migrate successfully without duplicate
constraint or index errors.

- [ ] **Step 4: Verify local sync against a fake GitHub response**

Run the exported `syncReleaseNotesFromPr` through its unit test with:

```bash
node --test apps/api/test/syncReleaseNotesPrScript.test.js
```

Expected: missing block skips, user block stores a repaired version, and repeat
sync is idempotent.

- [ ] **Step 5: Inspect final diff and status**

Run:

```bash
git diff origin/master...HEAD --stat
git status -sb
git diff --check origin/master...HEAD
```

Expected: only automatic release digest files are changed, the worktree is
clean, and the whitespace check passes.

- [ ] **Step 6: Create final implementation commit if verification required fixes**

If verification changes files, list them with `git status --short`, then stage
each listed automatic-release-digest file explicitly:

```bash
git add apps/api/src/releaseNotesService.js apps/api/test/releaseNotesService.test.js
git commit -m "Fix automatic release digest verification"
```

The example staging command applies when those two files changed. Replace the
paths with the exact files shown by `git status --short`; do not use
`git add -A`. If no files changed, do not create an empty commit.
