# Automatic Release Digest Design

## Goal

Make Money Flow release digests fully automatic:

1. A merged PR supplies structured user release notes.
2. A successful production deploy synchronizes those notes into PostgreSQL.
3. At 21:00 in the configured timezone, the API sends one concise localized
   digest to active Telegram users.
4. Manual admin commands remain available for preview and emergency sending,
   but are not required in the normal flow.

The automation starts with new merges after this change. It does not backfill
older pull requests.

## Architecture

The implementation has three cooperating parts:

1. The GitHub Actions deploy job identifies the PR associated with the deployed
   commit SHA.
2. After the application has deployed and passed production checks, the job
   invokes a production script:

   ```bash
   npm run release-notes:sync-pr -- --pr=<number>
   ```

3. The API process runs an in-process release digest scheduler. It checks on a
   configurable interval and starts at most one automatic digest during the
   configured local send hour.

The production script reads the PR body through the GitHub API. It does not
accept user-facing release text from commit messages.

If application deployment succeeds but release-note synchronization fails, the
GitHub Actions job fails. The deployed application is not rolled back
automatically.

## PR Release Block

User-facing PRs contain:

```markdown
## User Release Notes

audience: user
version: v.1.19
category: history

RU:
- В истории расходов появился выбор периода.

EN:
- Expense history now has a period picker.
```

Supported audiences are `user`, `admin`, and `internal`.

- `user` notes are eligible to be sent to normal users.
- `admin` and `internal` notes are stored for admin visibility but are never
  included in a user digest.
- A PR without the block creates no user-facing note. The sync step emits a
  warning.
- RU text is required for a user note.
- EN text may be omitted. When it is absent, English users receive the Russian
  fallback and preview displays a warning.
- Each PR release block must itself fit the compact message limits: no more
  than 6 RU bullets, no more than 6 EN bullets, no bullet over 120 characters,
  and no localized rendered digest over 900 characters. Invalid oversized
  blocks fail synchronization instead of creating a note that can never be
  delivered.

## Versioning

Public versions use `v.1.<patch>`, for example `v.1.18`, `v.1.19`, and
`v.1.20`. The `v0.1.18` format is not used.

Only `audience: user` advances the public version.

- If a valid available version is supplied, use it.
- If the version is missing, malformed, duplicated, or behind the current
  public version, assign the next available patch version automatically.
- `admin` and `internal` notes do not consume a public version.

The first release after this automation is deployed continues from the latest
stored public version. There is no historical PR backfill.

## Database Changes

Extend `release_notes`:

```sql
alter table release_notes
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists source_type text,
  add column if not exists source_id text,
  add column if not exists audience text not null default 'user',
  add column if not exists category text;
```

Retain or add the audience constraint:

```sql
check (audience in ('user', 'admin', 'internal'))
```

Prevent duplicate synchronization:

```sql
create unique index if not exists release_notes_source_unique
on release_notes (source_type, source_id, audience)
where source_type is not null and source_id is not null;
```

Add digest run history:

```sql
create table if not exists release_digest_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',
  trigger text not null default 'auto',
  sent_from timestamptz,
  sent_to timestamptz not null,
  version_from text,
  version_to text,
  users_count integer not null default 0,
  success_count integer not null default 0,
  error_count integer not null default 0,
  blocked_count integer not null default 0,
  error_message text,
  digest_local_date text,
  timezone text,
  constraint release_digest_runs_status_check
    check (status in ('running', 'success', 'failed', 'skipped')),
  constraint release_digest_runs_trigger_check
    check (trigger in ('auto', 'manual', 'preview', 'test'))
);
```

Prevent duplicate automatic runs:

```sql
create unique index if not exists release_digest_runs_auto_date_unique
on release_digest_runs (digest_local_date, timezone, trigger)
where trigger = 'auto' and status in ('success', 'skipped', 'running');
```

## Digest Selection

The digest is not based on the current calendar day.

For every send attempt:

1. Read the latest successful digest run.
2. Set `sent_from` to its `sent_to`. If no successful run exists, leave
   `sent_from` empty.
3. Set `sent_to` to the current run timestamp.
4. Select public user notes where:

   ```text
   created_at <= sent_to
   sent_at is null
   is_public = true
   audience = 'user'
   ```

5. Order notes by `created_at`, then `id`.
6. Notes created after `sent_from` are the normal new range. Older unsent notes
   are retained as carry-over for partial failures or compact-message overflow.
   They are never excluded only because the successful-run cursor advanced.
7. If there is no previous successful run, select all unsent public user notes.

Admin and internal notes use the same time range for preview only.

Required repository operations include:

- `getLastSuccessfulReleaseDigestRun()`
- `getReleaseDigestRunForLocalDate(localDate, timezone)`
- `createReleaseDigestRun(...)`
- `markReleaseDigestRunSuccess(id, summary)`
- `markReleaseDigestRunFailed(id, error)`
- `markReleaseDigestRunSkipped(id, reason)`
- `getUnsentPublicReleaseNotesSince(since, until)`
- `getHiddenReleaseNotesSince(since, until)`

## Compact Message Rules

A user digest must be short:

- no more than 6 bullet points;
- no bullet longer than 120 characters;
- no complete message longer than 900 characters;
- related changes are combined in the PR block before synchronization;
- technical implementation details are excluded.

The formatter adds complete release notes in order until adding the next note
would exceed a limit. It does not split one release note across runs. Notes
that do not fit remain unsent carry-over and are eligible for the next digest.
Delivery rows and `release_notes.sent_at` are written only for notes actually
included.

RU format:

```text
✨ Money Flow v.1.19

Что нового:

• История расходов получила выбор периода.
• Плановые платежи сохраняются на правильную дату.
```

EN format:

```text
✨ Money Flow v.1.19

What's new:

• Expense history now has a period picker.
• Planned payments are saved on the correct date.
```

The selected note set and version range are shared by the run, but each user
message is formatted separately using `users.interface_language`.

- `ru` receives Russian text.
- `en` receives English text.
- Unknown or missing language receives Russian text.
- Missing EN note text falls back to RU.

## Scheduler

Configuration:

```env
RELEASE_DIGEST_AUTO_SEND_ENABLED=true
RELEASE_DIGEST_TIMEZONE=Asia/Bangkok
RELEASE_DIGEST_SEND_HOUR=21
RELEASE_DIGEST_CHECK_INTERVAL_MINUTES=15
```

The API starts `releaseDigestScheduler` only when automatic sending is enabled.
The scheduler:

1. wakes every configured interval;
2. calculates local date and hour using `RELEASE_DIGEST_TIMEZONE`;
3. proceeds only during `RELEASE_DIGEST_SEND_HOUR`;
4. checks that no `running`, `success`, or `skipped` auto-run exists for the
   local date and timezone;
5. acquires an in-memory process lock;
6. calls `sendReleaseDigestSinceLastRun(now, { trigger: "auto" })`;
7. releases the lock in `finally`.

The database unique index is authoritative for cross-process duplicate
prevention. Ticks at 21:15 and 21:30 cannot create another automatic run.

When no user notes are eligible, the scheduler creates a `skipped` run and
sends nothing.

When `RELEASE_DIGEST_AUTO_SEND_ENABLED=false`, automatic sending is disabled
while preview and manual send continue to work.

## Sending, Runs, and Recovery

Eligible users are:

```text
telegram_user_id is not null
onboarding_step = 'completed'
bot_blocked = false
```

Existing `release_note_deliveries(release_note_id, user_id)` remains the
per-user deduplication mechanism.

- A failure for one user does not stop other users.
- Telegram blocked/forbidden responses set `users.bot_blocked=true`.
- Successfully delivered note/user pairs remain recorded if another delivery
  fails.
- A run with any non-blocked delivery error is marked `failed`.
- A later scheduler tick in the send hour may retry a failed auto-run. A manual
  send may also recover it. Existing delivery rows ensure that either path
  retries only missing deliveries.
- A note receives `sent_at` only after all eligible users have either received
  it or already have a delivery row.
- A successful run records counts, sent range, and version range.

The auto-run date guard applies only to automatic runs. A failed auto-run may
be recovered with `/admin_release_send`.

## Admin Commands

`/admin_release_preview` displays the pending range since the last successful
digest:

- RU preview;
- EN preview;
- the `sent_from` to `sent_to` period;
- hidden admin/internal notes in a separate block;
- a warning when any user note lacks EN text.

It creates no run record, creates no delivery rows, and does not consume notes.

`/admin_release_send` remains a manual override. It calls the same
`sendReleaseDigestSinceLastRun` path with `trigger: "manual"` and records a
manual run. It is not required in normal operation.

## GitHub Synchronization

After production deployment and security checks:

1. GitHub Actions queries the GitHub API for PRs associated with
   `github.sha`.
2. It selects the merged PR targeting `master`.
3. It invokes the production sync script with that PR number.
4. The script reads the PR body using a read-only GitHub token and repository
   name.
5. It parses and validates the release block.
6. It inserts an idempotent release note with:

   ```text
   source_type = 'github_pr'
   source_id = '<PR number>'
   ```

7. Re-running the same sync does not create another note.

Required production environment:

```env
GITHUB_TOKEN=...
GITHUB_REPOSITORY=Eugenio-Minochkin/money_flow
```

The token is never logged. Missing release blocks produce warnings rather than
invented user-facing release text.

## Testing

### Scheduler

- Disabled configuration starts no scheduler.
- The configured send hour is interpreted in the configured timezone.
- Only one auto-run is created for a local date.
- Repeated ticks in the same hour do not resend.
- No notes creates a skipped run and no messages.
- Eligible notes create a successful run and messages.
- Notes accumulated across multiple days are included.

### Selection and Visibility

- Selection is not limited to today's date and uses the last successful
  `sent_to` as the normal range boundary.
- Older unsent carry-over remains eligible after cursor advancement.
- The initial run selects all unsent public user notes.
- Only `audience=user` and `is_public=true` are sent.
- Admin and internal notes appear only in preview.
- Newly created notes after one digest are eligible for the next digest.

### Formatting and Localization

- RU, EN, unknown-language, and missing-EN fallback behavior.
- Preview warns about missing EN text.
- A single run sends different localized text to RU and EN users.
- At most 6 bullets, 120 characters per bullet, and 900 characters total.
- Overflow notes remain pending for the next digest.

### Delivery and Runs

- Success, failed, and skipped run transitions.
- Per-user delivery deduplication.
- Partial delivery retry.
- Blocked users are marked and do not abort the run.
- Manual send uses the same selection and formatting as auto-send.

### GitHub Sync

- Valid release-block parsing.
- Missing-block warning without a user note.
- User, admin, and internal audience handling.
- Explicit valid version use.
- Automatic next-version assignment for missing, invalid, duplicate, or stale
  versions.
- Only user notes advance the public version.
- Repeated PR synchronization is idempotent.
- Deploy workflow invokes sync only after successful production checks and
  fails the job if synchronization fails.

## Acceptance Criteria

- Normal releases require neither manual database inserts nor
  `/admin_release_send`.
- New merged PR release blocks are synchronized after successful deployment.
- At 21:00 `Asia/Bangkok`, one automatic digest is sent when eligible user
  notes exist.
- Nothing is sent when no new user-facing changes exist.
- The digest includes pending user changes since the last successful run.
- Admin/internal changes never reach normal users.
- Messages are concise and localized.
- Overflow notes remain pending rather than being lost.
- Repeated syncs, scheduler ticks, and sends do not create duplicates.
- Manual preview and send remain available as admin tools.
- All automated tests pass.
