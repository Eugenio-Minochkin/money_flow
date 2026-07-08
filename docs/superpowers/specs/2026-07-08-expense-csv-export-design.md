# Expense CSV Export Design

## Goal

Give the user a safe way to export confirmed expenses as a readable CSV file from Telegram or the Mini App, without broadening Money Flow into an accounting or cashflow export.

## Scope

The first export includes only confirmed rows from `expenses`, scoped to the current authenticated user. Each CSV row has `type=expense`.

The export does not include drafts, cancelled or pending confirmations, failed parses, budget top-ups, reserve events, planned-payment definitions, feedback, internal IDs, Telegram IDs, init data, raw payloads, debug fields, tokens, or environment values.

## User Flows

Telegram:

1. User sends `/export`.
2. Bot shows inline buttons for current month and all time.
3. User chooses a period.
4. Bot prepares a CSV and sends it as a Telegram document.
5. If no rows exist for the selected period, the bot sends a localized message and no file.

Mini App:

1. User opens Settings.
2. User sees a compact "Export data" section.
3. User chooses current month or all time.
4. Mini App explains that the CSV will arrive in Telegram chat.
5. Backend sends the same Telegram document flow.

## Architecture

Add a shared backend export flow used by both Telegram callbacks and a Mini App API endpoint. The flow resolves the user from trusted context only: Telegram uses callback/message `from.id`, and Mini App uses existing Telegram initData auth. Request `user_id`, `telegram_user_id`, or similar fields are ignored.

The repository fetches export rows by internal `users.id`, not request parameters. Current month uses `users.timezone` to compute local month UTC bounds. All time has no date upper/lower bound beyond the user's own rows. Rows are ordered oldest to newest.

CSV generation lives in a focused writer module. It emits UTF-8 BOM, uses the required headers, formats local expense dates as `YYYY-MM-DD`, formats creation timestamps as `YYYY-MM-DD HH:mm:ss`, and escapes quotes, commas, line breaks, and non-ASCII text correctly.

Telegram delivery uses `sendDocument`; no public download links and no persistent storage. The MVP can send an in-memory `Buffer` through the Telegram client. If the real Telegram API path needs multipart upload support, implement that inside the Telegram adapter without changing export domain behavior.

## Throttling And Large Exports

Use a shared per-user in-memory cooldown for Telegram and Mini App export requests. When throttled, return a localized "try again later" message.

Use paginated repository reads for all-time exports. Do not silently truncate. If a future hard limit is added, it must return an explicit localized "export is too large" message and no partial CSV.

## Testing

Use red-first tests for:

- CSV headers, BOM, escaping, dates, number formatting, and Russian text.
- Repository scoping by internal `users.id`, oldest-to-newest ordering, current-month bounds from `users.timezone`, and no draft/entity leakage.
- Telegram `/export` period picker, current-month/all-time document delivery, empty state, throttling, and normal parser flow unaffected.
- Mini App endpoint ignores user identifiers from request body/query and uses initData auth.
- Mini App Settings renders export controls and shows success/error states.
- Command menu includes `/export` in English and Russian.

## PR Notes

The PR description must include manual test steps for Telegram `/export`, Mini App Settings export, empty export, and security checks confirming only the current user's confirmed expenses are exported.
