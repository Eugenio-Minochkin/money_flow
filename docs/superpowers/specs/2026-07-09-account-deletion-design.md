# Account Deletion Design

## Context

Money Flow needs a safe "Delete my data" flow with two entry points:

- Mini App Settings -> danger zone -> Delete my data.
- Telegram command `/delete_me`.

This is a destructive privacy feature. The dangerous part is not the UI confirmation flow; it is proving that final deletion uses the authenticated Telegram identity, deletes only the current user, handles non-cascading or privacy-sensitive tables consistently, runs in one transaction, rolls back cleanly, and leaves only one safe non-identifying audit event.

## Chosen Approach

Use a repository-owned account deletion workflow.

`repository.js` owns the account deletion state machine:

```text
request -> advance -> cancel -> confirm
```

Mini App routes and Telegram handlers are thin entry points only. Both call the same repository methods so deletion behavior is shared, testable, and cannot drift between channels.

Rejected alternatives:

- A separate service module around repository: cleaner long-term, but extra ceremony for this MVP while repository already owns user-scoped SQL and transactions.
- Route-specific or Telegram-specific deletion logic: faster superficially, but duplicates the most dangerous operation and increases the chance that one path deletes or logs differently.

## Domain Language

Add `Account Deletion / Удаление данных пользователя` to `CONTEXT.md`.

Definition: an irreversible user action that, after double confirmation, deletes user-owned Money Flow data: expenses, drafts, budgets, planned payments, reserves, settings, feedback, and user-owned analytics/events. After deletion, only one non-identifying `account_deleted` audit event remains, with `user_id = NULL` and safe metadata.

Avoid treating this as logout, account deactivation, soft delete, anonymized profile cleanup, support cleanup, or admin deletion.

## Repository Contract

Add repository methods:

```js
requestAccountDeletion(telegramUserId, { source, ttlMinutes, now })
advanceAccountDeletionToTextConfirmation(telegramUserId, { source, now })
cancelAccountDeletion(telegramUserId, { source, now })
confirmAccountDeletion({ telegramUserId, source, confirmationText, now })
getPendingAccountDeletion(telegramUserId, { source, now })
```

Names may be simplified during implementation, but the state machine and final deletion contract must stay separate and directly testable.

`requestAccountDeletion(...)` must always create or return a request with `stage = 'requested'`. Callers must not be able to create an already-armed `awaiting_text` request.

`confirmAccountDeletion({ telegramUserId, source, confirmationText, now })` must not accept `userId` from client code.

The default account deletion TTL is 15 minutes and is enforced by repository methods. UI text may display the TTL, but UI is not the source of truth.

Before creating a new pending request:

1. Expire old pending requests for the same user:

```sql
UPDATE account_deletion_requests
SET status = 'expired', updated_at = now()
WHERE user_id = $1
  AND status = 'pending'
  AND expires_at <= $now;
```

2. If a non-expired pending request already exists for the same user and same source, reset it to `stage = 'requested'`, refresh `expires_at` and `updated_at`, and return it.
3. If a non-expired pending request exists for another source, return controlled error `account_deletion_already_pending`. Do not silently replace cross-source requests.

This controlled cleanup belongs in repository logic, not migration SQL. It prevents an already-expired pending row from blocking a new request through the partial unique index.

`getPendingAccountDeletion(...)` should not return a blind boolean. It should return `null` when no active pending request exists, or a small state object such as:

```js
{
  status: "pending",
  stage: "awaiting_text",
  source: "telegram",
  expiresAt
}
```

Telegram uses this to distinguish `requested`, `awaiting_text`, source mismatch, and expired states before message text can reach parser/LLM handling.

## Final Deletion Transaction

Final deletion runs in one DB transaction:

1. `SELECT * FROM users WHERE telegram_user_id = $1 FOR UPDATE`
2. `SELECT * FROM account_deletion_requests ... FOR UPDATE`
3. Validate `status`, `stage`, TTL, `source`, and `confirmationText === "DELETE"`.
4. Hard-delete user-owned `app_events`.
5. Hard-delete `feedback` by `user_id OR raw telegram_user_id`.
6. Hard-delete `release_note_deliveries` for compatibility.
7. Insert one safe audit event directly with SQL:
   - `user_id = NULL`
   - `event_name = 'account_deleted'`
   - `metadata = { "source": "miniapp" | "telegram" }`
8. `DELETE FROM users WHERE id = $userId`
9. `COMMIT`

Rollback on any failure.

Do not use `repository.recordAppEvent()` for the final `account_deleted` audit event. Insert it directly inside the deletion transaction so audit write failure rolls back the whole deletion.

The final audit event must not include:

- `telegram_user_id`
- internal `user_id`
- username
- first name
- expense amounts
- categories
- `source_text`
- feedback message
- Telegram `initData`
- request body
- deletion counts, unless fully non-identifying

Security/privacy PR wording should explicitly state: no financial data, feedback message, Telegram initData, raw Telegram ID, username, first name, source_text, or request body is written to the final audit event or logs.

## Data Ownership Rules

Hard-delete, do not anonymize, for this MVP.

Anonymization is intentionally out of scope because it is easy to get wrong and can leave user-authored text, parser metadata, financial context, or raw Telegram identifiers behind.

Manual cleanup:

- `DELETE FROM app_events WHERE user_id = $userId`
- `DELETE FROM feedback WHERE user_id = $userId OR telegram_user_id = $telegramUserId`
- `DELETE FROM release_note_deliveries WHERE user_id = $userId`

Most financial tables already reference `users(id) ON DELETE CASCADE`, so deleting the user row removes user-owned financial data. Do not touch `exchange_rates`: it is a global cache without `user_id`.

After successful deletion:

- `getUserByTelegramId(oldTelegramUserId)` returns `null`.
- `upsertTelegramUser` can create a fresh user with the same `telegram_user_id`.
- The user can go through onboarding again without conflicts from the old `telegram_user_id`.

## Migration

Add `apps/api/migrations/007_account_deletion.sql`.

Create `account_deletion_requests`:

```sql
CREATE TABLE IF NOT EXISTS account_deletion_requests (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('telegram', 'miniapp')),
  stage TEXT NOT NULL CHECK (stage IN ('requested', 'awaiting_text')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'cancelled', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Add indexes:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS account_deletion_requests_one_pending_per_user
  ON account_deletion_requests(user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS account_deletion_requests_user_status_idx
  ON account_deletion_requests(user_id, status, expires_at);
```

Fix `release_note_deliveries.user_id` to `ON DELETE CASCADE`. The current schema creates it as `user_id BIGINT REFERENCES users(id)` without cascade, so a plain `DELETE FROM users` may fail on the FK.

Use a safe `DO $$ ... $$` block that discovers the real constraint name instead of assuming it. Applying the migration twice must be safe.

Do not add deletion side effects to the migration. Expiry and cleanup behavior belongs in repository code.

Do not touch `exchange_rates`.

## Mini App API

Add endpoints near existing settings/export routes:

- `POST /api/account-deletion/request`
- `POST /api/account-deletion/advance`
- `POST /api/account-deletion/cancel`
- `POST /api/account-deletion/confirm`

All `/api/account-deletion/*` endpoints must use:

```js
apiSecurity.resolveVerifiedTelegramUserId(req)
```

Do not call `resolveTelegramUserId` for account deletion endpoints. Ignore `body.telegramUserId`, `body.userId`, query `telegramUserId`, and any similar client-sent identity fields.

Validate `source` strictly. For Mini App routes, `body.source` must be exactly `"miniapp"`. If `source` is absent or any other value, return:

```json
{ "error": "invalid_account_deletion_source" }
```

with HTTP `400`.

Expected API errors:

- `400 account_deletion_confirmation_required`
- `400 account_deletion_not_requested`
- `400 account_deletion_not_armed`
- `400 account_deletion_already_pending`
- `400 invalid_account_deletion_source`
- `410 account_deletion_expired`
- `404 user_not_found`
- `500 internal_error`

Expected API success responses:

```json
{ "status": "pending", "stage": "requested", "expiresAt": "..." }
{ "status": "pending", "stage": "awaiting_text", "expiresAt": "..." }
{ "status": "cancelled" }
{ "status": "deleted" }
```

Unexpected errors may use the existing `server.js` catch path, which returns `internal_error` and sends safe admin alert context with route and method only.

## Telegram Flow

Add `/delete_me` to `telegramCommands.js` in EN and RU command menus.

Command behavior:

1. User sends `/delete_me`.
2. Bot creates a pending delete request through `repository.requestAccountDeletion(...)`.
3. Bot sends a warning with inline buttons:
   - `I understand / Я понимаю`
   - `Cancel / Отмена`
4. Callback data:
   - `delete_me:advance`
   - `delete_me:cancel`
5. Add callback handling branch `if (action === "delete_me")` before the general fallback or unrelated callback branches.
6. After `delete_me:advance`, call `advanceAccountDeletionToTextConfirmation(...)`, ask the user to type exactly `DELETE`, and keep a visible Cancel button.
7. If the user sends `DELETE` while an active request is in `awaiting_text`, call `confirmAccountDeletion({ telegramUserId, source: "telegram", confirmationText: "DELETE", now })`.
8. If the user sends any other text while the active request is in `awaiting_text`, do not send it to parser/LLM. Reply: `Type DELETE to confirm or /delete_me to start again.`
9. If the request expired, do not delete anything and ask the user to start again.
10. If the user cancels, call `cancelAccountDeletion(...)` and reply that nothing was deleted.

The pending `awaiting_text` check must run in `handleMessage` before:

- `trackExpenseMessage`
- `safeRecordAppEvent("message_received")`
- `telegramJobQueue.enqueue(...)`
- parser/LLM flow

After successful Telegram deletion, do not send `appKeyboard` or any response that assumes the user still exists. Send only the final "data deleted" message.

## Mini App UX

Place the danger-zone section inside `#settingsTab`, after `</form>` of `#settingsForm`, not inside the settings form.

Do not reuse the settings submit flow for account deletion. Do not call `saveSettings()`, `loadDashboard()`, `loadHistory()`, `renderSettings()`, or `requestExpenseExport()` after successful deletion.

UX:

1. User clicks `Delete my data`.
2. UI calls `/api/account-deletion/request` and reveals a warning panel.
3. Warning explains that expenses, budgets, planned payments, drafts, settings, feedback, and related data will be deleted, and that nothing is deleted until the second confirmation.
4. User clicks `I understand`.
5. UI calls `/api/account-deletion/advance`, then shows `Type DELETE`.
6. `Delete permanently / Удалить навсегда` is disabled until input is exactly `DELETE`.
7. `Cancel` is available on both stages and calls `/api/account-deletion/cancel`.
8. After success, render a static deleted state:
   - `Your Money Flow data has been deleted. To start again, send /start to the bot.`
9. Do not reload dashboard/history or old user data after success.

After successful deletion:

- set an in-memory flag, for example `accountDeleted = true`;
- render a static deleted state;
- hide or disable `.bottom-tabs`;
- disable `#settingsForm` controls;
- disable export buttons;
- disable planned/history/dashboard action buttons;
- prevent `switchTab()`, `loadDashboard()`, `loadHistory()`, `saveSettings()`, and `requestExpenseExport()` from making API calls when `accountDeleted === true`.

Use the existing vanilla JS/CSS structure and existing `api(...)` client. Do not add a new frontend framework or heavy test stack for this feature.

The visual companion may be used later only if the danger-zone layout needs comparison or polish.

## i18n And Copy

Add RU/EN Mini App keys for:

- `settings.dangerZone`
- `settings.deleteDataTitle`
- `settings.deleteDataHint`
- `settings.deleteDataButton`
- `settings.deleteDataWarningTitle`
- `settings.deleteDataWarningBody`
- `settings.deleteDataUnderstand`
- `settings.deleteDataTypeDelete`
- `settings.deleteDataConfirmButton`
- `settings.deleteDataCancel`
- `settings.deleteDataDeletedTitle`
- `settings.deleteDataDeletedBody`
- `toast.accountDeletionRequested`
- `toast.accountDeletionCancelled`
- `toast.accountDeletionExpired`
- `toast.accountDeletionFailed`

Final destructive button label:

- EN: `Delete permanently`
- RU: `Удалить навсегда`

## Testing Strategy

Use TDD. Write focused failing tests before production code.

### Repository Tests

Cover:

- `requestAccountDeletion` creates a pending request and does not delete the user.
- Expired pending request is marked expired before creating a new pending request.
- Repeated same-source request resets the existing pending request to `requested`, refreshes TTL, and does not delete data.
- Repeated cross-source request returns `account_deletion_already_pending` and does not replace or advance the existing request.
- `requestAccountDeletion` never creates `awaiting_text`.
- `advanceAccountDeletionToTextConfirmation` moves stage to `awaiting_text`.
- Source mismatch does not allow advance, cancel, or confirm.
- A pending request for `source = 'miniapp'` cannot be confirmed through `source = 'telegram'`, and vice versa.
- `getPendingAccountDeletion` returns stage/source/expiresAt details, not just boolean.
- `confirmAccountDeletion` does not delete without a pending request.
- `confirmAccountDeletion` does not delete while stage is still `requested`.
- `confirmAccountDeletion` accepts only exact `DELETE`.
- `confirmAccountDeletion` does not delete after TTL expiry.
- `confirmAccountDeletion` deletes only the current user.
- Other users' data remains.
- `app_events` for the deleting user are hard-deleted.
- `feedback` is hard-deleted by `user_id OR telegram_user_id`.
- `release_note_deliveries` does not block deletion.
- `exchange_rates` remains untouched.
- The operation rolls back on transaction error.
- `account_deleted` audit metadata contains only `source` and no Telegram ID, user ID, counts, source text, feedback text, or financial context.
- After deletion, `getUserByTelegramId(oldTelegramUserId)` returns `null`.
- After deletion, `upsertTelegramUser` can create a fresh user with the same `telegram_user_id`.

### Telegram Tests

Cover:

- `/delete_me` sends warning and does not delete data.
- First callback `delete_me:advance` does not delete data.
- `DELETE` without first callback does not delete data.
- Happy path `/delete_me` -> button -> `DELETE` calls repository deletion.
- Wrong text in pending stage does not reach expense parser.
- `delete_me:cancel` cancels the request and deletes nothing.
- Expired request deletes nothing.
- Final success message is sent after deletion.
- Final success message does not include Mini App keyboard.
- Failure sending final Telegram message does not cause recursive error behavior.

### API And Security Tests

Cover:

- All account deletion endpoints require verified Telegram initData.
- Endpoints do not trust `telegramUserId`, `userId`, or query identity fields.
- Missing or mismatched initData returns an error.
- Missing or non-`miniapp` source returns `400 invalid_account_deletion_source`.
- Successful Mini App flow returns `{ "status": "deleted" }`.

### Mini App Smoke Tests

Use existing Mini App smoke/i18n/settings asset tests. Do not add a heavy new frontend test stack.

Cover:

- `index.html` contains `#deleteAccountSection` inside `#settingsTab`.
- `#deleteAccountSection` appears after `</form>` of `#settingsForm`, not inside it.
- `app.js` wires `#deleteAccountStartButton`, `#deleteAccountAdvanceButton`, `#deleteAccountCancelButton`, `#deleteAccountConfirmInput`, and `#deleteAccountConfirmButton`.
- `app.js` uses `/api/account-deletion/request`, `/advance`, `/cancel`, and `/confirm`.
- i18n has RU/EN keys for all visible danger-zone and deleted-state copy.
- `app.js` has an `accountDeleted` guard that prevents `loadDashboard`, `loadHistory`, `saveSettings`, and export actions after success.

### Migration Smoke Tests

If local disposable Postgres is available, cover:

- Applying `007` twice is safe.
- `release_note_deliveries.user_id` FK becomes `ON DELETE CASCADE`.
- Deleting a user with `release_note_deliveries` no longer fails.
- `account_deletion_requests` partial unique index allows only one pending request per user.

## Verification

Run focused tests first, then the full suite:

```powershell
npm.cmd test -- apps/api/test/repository.test.js
npm.cmd test -- apps/api/test/telegram.test.js
npm.cmd test -- apps/api/test/security.test.js
npm.cmd test -- apps/miniapp/test/smokeAssets.test.js apps/miniapp/test/i18n.test.js apps/miniapp/test/settings.test.js
npm.cmd test
```

Run Postgres integration smoke if disposable local Postgres is available and migration SQL needs live verification:

```powershell
$env:DATABASE_URL = "postgres://postgres:postgres@localhost:5432/money_flow_test"
npm.cmd run test:integration:postgres
```

Do not run any manual DELETE against production, staging, or persistent/user-data databases.

## PR Requirements

The PR body must include:

- Summary.
- Changed areas.
- Docs checked/updated.
- Tests run.
- DB/prod impact.
- Rollback/forward-fix notes.
- Release notes impact.
- Screenshots or manual QA notes for Mini App UI.
- Open questions or assumptions.

DB impact wording:

- Adds `account_deletion_requests`.
- Changes `release_note_deliveries.user_id` FK to `ON DELETE CASCADE`.
- Final deletion removes user-owned rows only after double confirmation.

Rollback/forward-fix wording:

- Schema is additive except the FK cascade correction.
- Pending requests are harmless if code is rolled back.
- Explicit `release_note_deliveries` delete remains compatible with the FK cascade.

Every user-visible PR must include `## User Release Notes` in RU and EN.

## Acceptance Criteria

- Mini App Settings has a danger-zone `Delete my data` block after the settings form.
- `/delete_me` is added to Telegram command menus.
- `/delete_me` alone deletes nothing.
- First confirm deletes nothing.
- Final deletion is possible only after exact `DELETE`.
- `DELETE` without an active armed request deletes nothing.
- Pending request expires after 15 minutes.
- Source mismatch blocks advance/cancel/confirm.
- User-owned data for the current user is deleted.
- Other users' data remains.
- `feedback` is deleted by `user_id OR telegram_user_id`.
- `app_events` for the current user are hard-deleted before user deletion.
- `release_note_deliveries` does not block user deletion.
- `exchange_rates` and other global lookup/cache tables are untouched.
- Final deletion runs in a transaction and rolls back on failure.
- Mini App deletion endpoints require verified initData and ignore client-sent identity fields.
- User can restart onboarding after deletion with the same `telegram_user_id`.
- Final audit/logging contains no financial data, Telegram initData, raw Telegram ID, username, first name, source text, feedback message, request body, tokens, or secrets.
