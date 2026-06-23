# Admin Access Reliability Design

## Goal

Make Telegram admin-command authorization consistent, tolerant of common
`ADMIN_TELEGRAM_IDS` formats, and diagnosable without exposing the configured
environment value.

## Scope

This change covers `/admin_stats`, `/admin_release_preview`, and
`/admin_release_send`. It does not change the commands' successful responses,
release-note behavior, or statistics calculations.

## Architecture

Create `apps/api/src/adminAccess.js` as the single owner of admin access
helpers:

- `parseAdminTelegramIds(value)` parses the environment value into a `Set` of
  positive safe integer Telegram IDs.
- `isAdminTelegramId(telegramUserId, adminTelegramIds)` validates a caller
  against the parsed set. It accepts numeric or numeric-string caller IDs while
  rejecting invalid IDs.
- `normalizeBotCommand(text)` trims command text and removes a valid Telegram
  bot suffix such as `@SomeBot`.

`server.js` imports the parser from this module. `telegram.js` imports the
authorization and command-normalization helpers. Duplicate helper exports are
removed from `adminStatsService.js` and `releaseNotesService.js`, and their
tests import the shared module instead.

## Admin ID Parsing

The parser accepts these recoverable forms:

- `123456789`
- `123456789,987654321`
- `123456789 987654321`
- `123456789;987654321`
- `"123456789"`
- `[123456789, 987654321]`

Parsing uses separators and wrapper punctuation only; it does not extract
digits from arbitrary text. Every token must represent a positive
`Number.isSafeInteger` value. Invalid tokens such as `@name`, alphabetic text,
zero, negative numbers, decimals, and integers outside the safe range are
ignored.

The returned set stores numbers. `isAdminTelegramId` converts a numeric-string
caller ID to a number only after validating the full value, making it compatible
with existing test or integration callers that provide IDs as strings.

## Command Normalization

Before command dispatch, `telegram.js` normalizes text commands. A suffix is
removed only when the text has the Telegram command shape:

`/<command>@<bot_username>`

This makes both plain and suffixed forms equivalent:

- `/admin_stats`
- `/admin_stats@SomeBot`
- `/admin_release_preview@SomeBot`
- `/admin_release_send@SomeBot`

Non-command expense text remains unchanged.

## Denied Access Diagnostics

When `/admin_stats` authorization fails, the bot still sends `Access denied`
and does not call `adminStatsService.getAdminStats()`.

The server writes:

```js
console.warn("[admin] access denied", {
  command: "/admin_stats",
  fromId: from.id,
  username: from.username ?? null,
  chatId,
  adminIdsCount: adminTelegramIds.size,
  adminEnvConfigured: adminTelegramIds.size > 0
});
```

The raw `ADMIN_TELEGRAM_IDS` string is never passed to the logger. The
diagnostic field reflects whether at least one valid admin ID was parsed, which
is the actionable runtime configuration state.

Release admin commands continue to use their current denial response. They use
the same authorization helper and normalized command text.

## Error Handling and Safety

- Missing, empty, or wholly invalid configuration produces an empty set and
  disables admin access.
- Invalid individual tokens do not invalidate otherwise valid IDs.
- Authorization fails closed for invalid caller IDs or non-Set configuration.
- Logging contains Telegram request metadata but no environment secret.
- Statistics and release services are not invoked for unauthorized callers.

## Testing

Add focused unit tests for `adminAccess.js` covering every accepted format and
unsafe values.

Update Telegram tests to prove:

- `/admin_stats` accepts a configured numeric ID.
- `/admin_stats` accepts a numeric-string caller ID through the shared helper.
- `/admin_stats@BotUsername` dispatches successfully.
- suffixed release commands are normalized.
- denied `/admin_stats` access does not invoke the statistics service.
- denied access logs command, caller, chat, count, and configuration metadata.
- warning arguments do not contain the raw environment value.

Existing admin statistics and release-note tests remain responsible for their
service behavior, not admin access parsing.

## Acceptance Criteria

- A configured numeric Telegram user can run `/admin_stats`.
- Every recoverable environment format listed in issue #35 parses correctly.
- Unsafe values never grant access.
- Admin commands work with a Telegram bot username suffix.
- Unauthorized statistics requests do not calculate or send statistics.
- Denial logs are sufficient to compare the caller ID with the parsed
  configuration state and never expose the raw environment value.
