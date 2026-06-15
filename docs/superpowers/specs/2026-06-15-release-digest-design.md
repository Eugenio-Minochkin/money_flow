# Money Flow Release Digest Design

## Goal

Add a safe manual release digest flow for active Telegram bot users. Users should receive a short localized digest only when there are public, user-facing changes for the current day. Internal, admin-only, infra, analytics, deployment, security, monitoring, and refactor-only changes must not be pushed to users.

The first release using this flow maps PR #18 to user-facing version `v.1.18`. Future public user releases increment the patch number as `v.1.19`, `v.1.20`, and so on.

## Publicity Model

`release_notes.audience` is the authoritative visibility filter:

- `user`: can be sent to users.
- `admin`: visible only to admins, never sent to users.
- `internal`: internal technical change, never sent to users.

`release_notes.category` is optional metadata and does not decide public visibility. It can be used for context in admin preview. Examples: `onboarding`, `expense`, `budget`, `planned_expenses`, `mini_app`, `bugfix`, `admin`, `internal`, `infra`, `analytics`.

User release digests always query only:

```sql
is_public = true
and audience = 'user'
and sent_at is null
and released_at is today
```

If the current day has only `admin` or `internal` notes, users receive nothing.

## Database

Extend the existing migration style in `apps/api/migrations/001_initial.sql`:

```sql
alter table users add column if not exists bot_blocked boolean not null default false;

create table if not exists release_notes (
  id bigserial primary key,
  version text not null,
  audience text not null default 'user',
  category text,
  title_ru text not null,
  title_en text,
  body_ru text not null,
  body_en text,
  released_at timestamptz not null default now(),
  sent_at timestamptz,
  is_public boolean not null default true,
  constraint release_notes_audience_check check (audience in ('user', 'admin', 'internal'))
);

alter table release_notes
  add column if not exists audience text not null default 'user',
  add column if not exists category text;

create table if not exists release_note_deliveries (
  release_note_id bigint references release_notes(id),
  user_id bigint references users(id),
  sent_at timestamptz not null default now(),
  primary key (release_note_id, user_id)
);
```

If the audience constraint already exists, migration code must avoid failing on repeated startup.

## Configuration

Add `ADMIN_TELEGRAM_IDS` as an env var:

```text
ADMIN_TELEGRAM_IDS=123456789,987654321
```

Parsing rules:

- split by comma;
- trim whitespace;
- ignore empty values;
- compare as strings or safe integers against Telegram `from.id`.

If it is missing or empty, admin commands are denied for everyone. Normal bot behavior continues. The API may log a warning so deployment mistakes are visible.

## Service Boundary

Add a release notes service with these responsibilities:

- `createReleaseNote({ version, titleRu, titleEn, bodyRu, bodyEn, isPublic, audience, category })`
- `getTodayUnsentPublicReleaseNotes(now)`
- `getTodayHiddenReleaseNotes(now)` for preview-only admin/internal notes hidden from user push
- `getLatestUnsentPublicReleaseNote(now)`
- `getActiveUsersForReleasePush()`
- `sendReleaseNotesToActiveUsers(releaseNotes, options)`
- `markReleaseNoteSent(releaseNoteId)`

Active users for MVP:

- have `telegram_user_id`;
- `onboarding_step = 'completed'`;
- `bot_blocked = false`.

No `last_seen_at` filter is added unless the field already exists.

`createReleaseNote` should keep explicit `audience` as the source of truth. If `audience` is omitted and `category` is `admin`, default to `admin`; if category is `internal`, `infra`, or `analytics`, default to `internal`; otherwise default to `user`.

## Message Formatting

User digest format is localized by `users.interface_language`:

- `ru`: Russian.
- `en`: English.
- unknown language: Russian fallback.

RU:

```text
✨ Money Flow v.1.18

Что изменилось сегодня:

• Онбординг стал проще...
```

EN:

```text
✨ Money Flow v.1.18

Today's updates:

• Onboarding is now simpler...
```

Digest content must stay user-facing: no PR numbers, branches, migrations, env vars, admin commands, metrics, logs, deployment details, access/security internals, or usage analytics. Recommended length is 3-5 bullets per day.

If multiple user notes exist for the same day, send all unsent user notes as the digest content for that version group. Admin/internal notes are never included in the user message.

## Telegram Admin Commands

Add admin-only handling before normal command handling:

- `/admin_release_preview`
- `/admin_release_send`

Admin access uses `ADMIN_TELEGRAM_IDS`.

Non-admin users should not receive admin data. A short denial response is acceptable, but no release contents or internal hidden notes should be exposed.

### `/admin_release_preview`

Shows exactly what users would receive. If no public user-facing notes exist:

```text
Сегодня нет release notes — пуш пользователям отправляться не будет.
```

If there are hidden admin/internal notes, append:

```text
Скрыто из пользовательского пуша:
• admin: добавлена /admin_stats
• internal: добавлено performance tracing
```

If there are no hidden notes, omit this block.

### `/admin_release_send`

Sends all unsent public user notes for today to active users. If no public user-facing notes exist:

```text
Сегодня нет публичных release notes для пользователей — отправлять нечего.
```

After sending:

```text
Release digest отправлен.
Версия: v.1.18
Пользователей: 12
Успешно: 11
Ошибки: 1
Заблокировали бота: 1
```

The send operation must not fail globally when one user send fails.

## Delivery And Error Handling

For each `(release_note_id, user_id)` pair:

- skip if `release_note_deliveries` already contains the pair;
- send the localized message;
- insert delivery only after a successful Telegram send;
- if Telegram indicates the user blocked the bot, set `users.bot_blocked = true` and count it as blocked;
- continue sending to remaining users after any per-user failure.

After all eligible deliveries for a release note have succeeded or been skipped due to existing delivery rows, set `release_notes.sent_at`. Failed deliveries should not get delivery rows.

## Manual Creation

Add an MVP script/helper, following existing npm script style, to create a release note manually. It should support at least:

```text
npm run release-note:create -- --version="v.1.18" --title-ru="Обновление онбординга" --title-en="Onboarding update" --body-ru="..." --body-en="..." --audience=user --category=onboarding
```

The script must be able to create RU and EN content. EN title/body remain optional in the DB, but the script should accept them.

## Tests

Use test-first implementation. Required coverage:

- release note creates with RU and EN fields;
- `audience = user` note is sent to users;
- `audience = admin` note is not sent to users;
- `audience = internal` note is not sent to users;
- if today has only admin/internal notes, `/admin_release_send` tells admin there are no public user release notes;
- if today has user + admin notes, users receive only the user note;
- preview is admin-only;
- send is admin-only;
- preview shows only user-bound digest plus hidden admin/internal block;
- no release notes for today means no user sends;
- active users receive sends;
- RU users receive RU text;
- EN users receive EN text;
- unknown language users receive RU text;
- repeated send does not duplicate the same release note for a user;
- one user send failure does not stop other deliveries;
- Telegram blocked-bot error sets `bot_blocked = true`;
- existing tests still pass.

## Out Of Scope

Do not add mandatory cron/autosend in this release. Keep the service callable later by a scheduler.

Do not expose release note management in Mini App.

Do not send any user-facing "no updates today" messages.
