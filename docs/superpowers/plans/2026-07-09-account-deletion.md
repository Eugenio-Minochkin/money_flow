# Account Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build irreversible account deletion for Mini App and Telegram that hard-deletes user-owned data and leaves only one safe non-identifying audit event.

**Architecture:** `apps/api/src/repository.js` owns the account deletion state machine and the final transaction. Mini App API routes and Telegram handlers are thin callers that resolve verified Telegram identity, validate source, and render UX. The final deletion contract deletes privacy-sensitive rows inside one transaction and inserts the `account_deleted` audit event with direct SQL inside that same transaction.

**Tech Stack:** Node.js, Express-style API routes in `server.js`, PostgreSQL SQL migrations, `node:test`, Telegram Bot API helpers, Mini App HTML/CSS/vanilla JS smoke tests.

---

## File Structure

- Create `apps/api/migrations/007_account_deletion.sql`: account deletion request table, indexes, and `release_note_deliveries.user_id` FK repair to `ON DELETE CASCADE`.
- Modify `apps/api/test/db.test.js`: static migration checks for table shape, partial unique index, idempotent FK repair block, and cascade behavior SQL.
- Modify `apps/api/test/repository.test.js`: repository lifecycle tests and deletion transaction tests.
- Modify `apps/api/src/repository.js`: account deletion state machine, expiration cleanup, source guards, and final hard-delete transaction.
- Modify `apps/api/test/security.test.js`: API route security tests proving deletion endpoints use verified initData identity and reject client-sent identity.
- Modify `apps/api/src/server.js`: four Mini App endpoints under `/api/account-deletion/*`.
- Modify `apps/api/test/telegram.test.js`: `/delete_me`, callback, text confirmation, cancel, expired, and parser-bypass tests.
- Modify `apps/api/src/telegram.js`: Telegram deletion command, callback branch, and `DELETE` interception before parser/queue/event tracking.
- Modify `apps/api/src/telegramCommands.js`: add `/delete_me` to EN/RU command menus.
- Modify `apps/miniapp/test/smokeAssets.test.js`: static checks for danger-zone markup, listeners, endpoint usage, i18n keys, and deleted-state guards.
- Modify `apps/miniapp/src/index.html`: add danger-zone section inside `#settingsTab` after `#settingsForm`.
- Modify `apps/miniapp/src/app.js`: deletion state, API calls, UI listeners, deleted-state rendering, and API-call guards.
- Modify `apps/miniapp/src/styles.css`: compact danger-zone/deleted-state styling using the existing settings visual language.
- Review `docs/superpowers/specs/2026-07-09-account-deletion-design.md` during final verification; no spec edit is expected unless implementation reveals a mismatch.

## Task 1: Migration Contract

**Files:**
- Create: `apps/api/migrations/007_account_deletion.sql`
- Modify: `apps/api/test/db.test.js`

- [ ] **Step 1: Write failing migration tests**

Add these tests to `apps/api/test/db.test.js` near the existing migration SQL tests:

```js
test('migration 007 creates account deletion request contract', async () => {
  const migration = await readFile(
    new URL('../migrations/007_account_deletion.sql', import.meta.url),
    'utf8',
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS account_deletion_requests/i);
  assert.match(migration, /user_id BIGINT NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/i);
  assert.match(migration, /source TEXT NOT NULL CHECK \(source IN \('telegram', 'miniapp'\)\)/i);
  assert.match(migration, /stage TEXT NOT NULL CHECK \(stage IN \('requested', 'awaiting_text'\)\)/i);
  assert.match(migration, /status TEXT NOT NULL CHECK \(status IN \('pending', 'cancelled', 'expired'\)\)/i);
  assert.match(migration, /expires_at TIMESTAMPTZ NOT NULL/i);
  assert.match(migration, /created_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/i);
  assert.match(migration, /updated_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/i);
  assert.match(migration, /WHERE status = 'pending'/i);
});

test('migration 007 repairs release note deliveries FK idempotently', async () => {
  const migration = await readFile(
    new URL('../migrations/007_account_deletion.sql', import.meta.url),
    'utf8',
  );

  assert.match(migration, /DO \$\$/i);
  assert.match(migration, /information_schema\.table_constraints/i);
  assert.match(migration, /release_note_deliveries/i);
  assert.match(migration, /ALTER TABLE release_note_deliveries DROP CONSTRAINT/i);
  assert.match(migration, /FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/i);
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```powershell
npm.cmd test -- apps/api/test/db.test.js
```

Expected: FAIL because `apps/api/migrations/007_account_deletion.sql` does not exist.

- [ ] **Step 3: Add the migration**

Create `apps/api/migrations/007_account_deletion.sql`:

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

CREATE UNIQUE INDEX IF NOT EXISTS account_deletion_requests_one_pending_per_user
  ON account_deletion_requests(user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS account_deletion_requests_user_status_expires_idx
  ON account_deletion_requests(user_id, status, expires_at);

DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT tc.constraint_name INTO constraint_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_name = 'release_note_deliveries'
    AND kcu.column_name = 'user_id'
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE release_note_deliveries DROP CONSTRAINT %I', constraint_name);
  END IF;

  ALTER TABLE release_note_deliveries
    ADD CONSTRAINT release_note_deliveries_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
END $$;
```

- [ ] **Step 4: Run the focused tests and verify pass**

Run:

```powershell
npm.cmd test -- apps/api/test/db.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit migration contract**

Run:

```powershell
git add apps/api/migrations/007_account_deletion.sql apps/api/test/db.test.js
git commit -m "Add account deletion migration"
```

## Task 2: Repository Request Lifecycle

**Files:**
- Modify: `apps/api/test/repository.test.js`
- Modify: `apps/api/src/repository.js`

- [ ] **Step 1: Write failing lifecycle tests**

Add tests in `apps/api/test/repository.test.js` next to other user-state repository tests:

```js
test('requestAccountDeletion creates a requested pending request with default ttl', async () => {
  const now = new Date('2026-07-09T10:00:00.000Z');
  const queries = [];
  const pool = fakePool(async (sql, params) => {
    queries.push({ sql, params });
    if (/UPDATE account_deletion_requests/i.test(sql)) return { rowCount: 0, rows: [] };
    if (/SELECT \* FROM users WHERE telegram_user_id/i.test(sql)) {
      return { rows: [{ id: 42, telegram_user_id: 777 }] };
    }
    if (/SELECT \* FROM account_deletion_requests/i.test(sql)) return { rows: [] };
    if (/INSERT INTO account_deletion_requests/i.test(sql)) {
      return {
        rows: [{
          id: 1,
          user_id: 42,
          source: 'miniapp',
          stage: 'requested',
          status: 'pending',
          expires_at: new Date('2026-07-09T10:15:00.000Z'),
        }],
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const repository = createRepository({ pool });

  const request = await repository.requestAccountDeletion(777, { source: 'miniapp', now });

  assert.equal(request.status, 'pending');
  assert.equal(request.stage, 'requested');
  assert.equal(request.source, 'miniapp');
  assert.equal(request.expiresAt.toISOString(), '2026-07-09T10:15:00.000Z');
  assert.match(queries[0].sql, /SET status = 'expired'/i);
  assert.match(queries.at(-1).sql, /INSERT INTO account_deletion_requests/i);
});

test('requestAccountDeletion refreshes same-source pending request', async () => {
  const now = new Date('2026-07-09T10:00:00.000Z');
  const pool = fakePool(async (sql) => {
    if (/UPDATE account_deletion_requests\s+SET status = 'expired'/i.test(sql)) return { rowCount: 0, rows: [] };
    if (/SELECT \* FROM users WHERE telegram_user_id/i.test(sql)) return { rows: [{ id: 42 }] };
    if (/SELECT \* FROM account_deletion_requests/i.test(sql)) {
      return { rows: [{ id: 5, user_id: 42, source: 'telegram', stage: 'awaiting_text', status: 'pending' }] };
    }
    if (/UPDATE account_deletion_requests\s+SET stage = 'requested'/i.test(sql)) {
      return {
        rows: [{
          id: 5,
          user_id: 42,
          source: 'telegram',
          stage: 'requested',
          status: 'pending',
          expires_at: new Date('2026-07-09T10:15:00.000Z'),
        }],
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const repository = createRepository({ pool });

  const request = await repository.requestAccountDeletion(777, { source: 'telegram', now });

  assert.equal(request.id, 5);
  assert.equal(request.stage, 'requested');
  assert.equal(request.expiresAt.toISOString(), '2026-07-09T10:15:00.000Z');
});

test('requestAccountDeletion rejects non-expired request from another source', async () => {
  const pool = fakePool(async (sql) => {
    if (/UPDATE account_deletion_requests/i.test(sql)) return { rowCount: 0, rows: [] };
    if (/SELECT \* FROM users WHERE telegram_user_id/i.test(sql)) return { rows: [{ id: 42 }] };
    if (/SELECT \* FROM account_deletion_requests/i.test(sql)) {
      return { rows: [{ id: 5, user_id: 42, source: 'telegram', stage: 'requested', status: 'pending' }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const repository = createRepository({ pool });

  await assert.rejects(
    () => repository.requestAccountDeletion(777, { source: 'miniapp', now: new Date('2026-07-09T10:00:00.000Z') }),
    { code: 'account_deletion_already_pending' },
  );
});
```

- [ ] **Step 2: Run lifecycle tests and verify failure**

Run:

```powershell
npm.cmd test -- apps/api/test/repository.test.js
```

Expected: FAIL because `requestAccountDeletion` is not defined.

- [ ] **Step 3: Add lifecycle methods**

In `apps/api/src/repository.js`, add these helper constants and methods inside the repository factory object:

```js
const ACCOUNT_DELETION_TTL_MINUTES = 15;
const ACCOUNT_DELETION_SOURCES = new Set(['miniapp', 'telegram']);

function assertAccountDeletionSource(source) {
  if (!ACCOUNT_DELETION_SOURCES.has(source)) {
    const error = new Error('Invalid account deletion source');
    error.code = 'invalid_account_deletion_source';
    throw error;
  }
}

function mapAccountDeletionRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    source: row.source,
    stage: row.stage,
    status: row.status,
    expiresAt: row.expires_at,
  };
}
```

Add methods:

```js
async function expireAccountDeletionRequests(userId, now) {
  await pool.query(
    `UPDATE account_deletion_requests
     SET status = 'expired', updated_at = $2
     WHERE user_id = $1
       AND status = 'pending'
       AND expires_at <= $2`,
    [userId, now],
  );
}

async function requestAccountDeletion(telegramUserId, { source, ttlMinutes = ACCOUNT_DELETION_TTL_MINUTES, now = new Date() }) {
  assertAccountDeletionSource(source);
  const userResult = await pool.query('SELECT * FROM users WHERE telegram_user_id = $1', [telegramUserId]);
  const user = userResult.rows[0];
  if (!user) {
    const error = new Error('User not found');
    error.code = 'user_not_found';
    throw error;
  }

  await expireAccountDeletionRequests(user.id, now);

  const pendingResult = await pool.query(
    `SELECT * FROM account_deletion_requests
     WHERE user_id = $1 AND status = 'pending'
     ORDER BY updated_at DESC, id DESC
     LIMIT 1`,
    [user.id],
  );
  const pending = pendingResult.rows[0];
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);

  if (pending && pending.source !== source) {
    const error = new Error('Account deletion already pending');
    error.code = 'account_deletion_already_pending';
    throw error;
  }

  if (pending) {
    const refreshed = await pool.query(
      `UPDATE account_deletion_requests
       SET stage = 'requested', expires_at = $2, updated_at = $3
       WHERE id = $1
       RETURNING *`,
      [pending.id, expiresAt, now],
    );
    return mapAccountDeletionRequest(refreshed.rows[0]);
  }

  const inserted = await pool.query(
    `INSERT INTO account_deletion_requests (user_id, source, stage, status, expires_at, created_at, updated_at)
     VALUES ($1, $2, 'requested', 'pending', $3, $4, $4)
     RETURNING *`,
    [user.id, source, expiresAt, now],
  );
  return mapAccountDeletionRequest(inserted.rows[0]);
}
```

Export `requestAccountDeletion`, `expireAccountDeletionRequests`, and `ACCOUNT_DELETION_TTL_MINUTES` through the repository object if the file uses an object-return pattern.

- [ ] **Step 4: Run lifecycle tests and verify pass**

Run:

```powershell
npm.cmd test -- apps/api/test/repository.test.js
```

Expected: PASS for new lifecycle tests. Existing unrelated tests must still pass.

- [ ] **Step 5: Commit lifecycle methods**

Run:

```powershell
git add apps/api/src/repository.js apps/api/test/repository.test.js
git commit -m "Add account deletion request lifecycle"
```

## Task 3: Repository Advance, Cancel, Pending Lookup, And Final Transaction

**Files:**
- Modify: `apps/api/test/repository.test.js`
- Modify: `apps/api/src/repository.js`

- [ ] **Step 1: Write failing state-machine tests**

Add these tests to `apps/api/test/repository.test.js`:

```js
test('advanceAccountDeletion moves same-source requested request to awaiting_text', async () => {
  const pool = fakePool(async (sql) => {
    if (/SELECT \* FROM users WHERE telegram_user_id/i.test(sql)) return { rows: [{ id: 42 }] };
    if (/UPDATE account_deletion_requests/i.test(sql)) {
      return {
        rows: [{
          id: 7,
          user_id: 42,
          source: 'telegram',
          stage: 'awaiting_text',
          status: 'pending',
          expires_at: new Date('2026-07-09T10:15:00.000Z'),
        }],
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const repository = createRepository({ pool });

  const request = await repository.advanceAccountDeletion(777, { source: 'telegram', now: new Date('2026-07-09T10:00:00.000Z') });

  assert.equal(request.stage, 'awaiting_text');
});

test('cancelAccountDeletion only cancels same-source pending request', async () => {
  const queries = [];
  const pool = fakePool(async (sql, params) => {
    queries.push({ sql, params });
    if (/SELECT \* FROM users WHERE telegram_user_id/i.test(sql)) return { rows: [{ id: 42 }] };
    if (/UPDATE account_deletion_requests/i.test(sql)) return { rowCount: 1, rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const repository = createRepository({ pool });

  const result = await repository.cancelAccountDeletion(777, { source: 'miniapp', now: new Date('2026-07-09T10:00:00.000Z') });

  assert.deepEqual(result, { status: 'cancelled' });
  assert.match(queries.at(-1).sql, /source = \$2/i);
});

test('getPendingAccountDeletion returns null for missing or expired requests', async () => {
  const pool = fakePool(async (sql) => {
    if (/SELECT \* FROM users WHERE telegram_user_id/i.test(sql)) return { rows: [{ id: 42 }] };
    if (/UPDATE account_deletion_requests/i.test(sql)) return { rowCount: 0, rows: [] };
    if (/SELECT \* FROM account_deletion_requests/i.test(sql)) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const repository = createRepository({ pool });

  const request = await repository.getPendingAccountDeletion(777, { source: 'telegram', now: new Date('2026-07-09T10:00:00.000Z') });

  assert.equal(request, null);
});
```

- [ ] **Step 2: Write failing final transaction tests**

Add these tests:

```js
test('confirmAccountDeletion hard-deletes user-owned data and writes safe audit in one transaction', async () => {
  const clientQueries = [];
  const client = {
    async query(sql, params) {
      clientQueries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (/SELECT \* FROM users WHERE telegram_user_id = \$1 FOR UPDATE/i.test(sql)) {
        return { rows: [{ id: 42, telegram_user_id: 777 }] };
      }
      if (/SELECT \* FROM account_deletion_requests/i.test(sql)) {
        return { rows: [{ id: 7, user_id: 42, source: 'miniapp', stage: 'awaiting_text', status: 'pending', expires_at: new Date('2026-07-09T10:15:00.000Z') }] };
      }
      if (/DELETE FROM app_events/i.test(sql)) return { rowCount: 3, rows: [] };
      if (/DELETE FROM feedback/i.test(sql)) return { rowCount: 2, rows: [] };
      if (/DELETE FROM release_note_deliveries/i.test(sql)) return { rowCount: 1, rows: [] };
      if (/INSERT INTO app_events/i.test(sql)) return { rowCount: 1, rows: [] };
      if (/DELETE FROM users/i.test(sql)) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {},
  };
  const pool = { async connect() { return client; } };
  const repository = createRepository({ pool });

  const result = await repository.confirmAccountDeletion({
    telegramUserId: 777,
    source: 'miniapp',
    confirmationText: 'DELETE',
    now: new Date('2026-07-09T10:00:00.000Z'),
  });

  assert.deepEqual(result, { status: 'deleted' });
  assert.equal(clientQueries[0].sql, 'BEGIN');
  assert.equal(clientQueries.at(-1).sql, 'COMMIT');
  assert.match(clientQueries.find((query) => /DELETE FROM app_events/i.test(query.sql)).sql, /user_id = \$1/i);
  assert.match(clientQueries.find((query) => /DELETE FROM feedback/i.test(query.sql)).sql, /user_id = \$1 OR telegram_user_id = \$2/i);
  const audit = clientQueries.find((query) => /INSERT INTO app_events/i.test(query.sql));
  assert.deepEqual(audit.params, [null, 'account_deleted', { source: 'miniapp' }, new Date('2026-07-09T10:00:00.000Z')]);
});

test('confirmAccountDeletion rolls back when the audit insert fails', async () => {
  const clientQueries = [];
  const client = {
    async query(sql) {
      clientQueries.push(sql);
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (/SELECT \* FROM users WHERE telegram_user_id = \$1 FOR UPDATE/i.test(sql)) return { rows: [{ id: 42, telegram_user_id: 777 }] };
      if (/SELECT \* FROM account_deletion_requests/i.test(sql)) return { rows: [{ id: 7, user_id: 42, source: 'telegram', stage: 'awaiting_text', status: 'pending', expires_at: new Date('2026-07-09T10:15:00.000Z') }] };
      if (/DELETE FROM app_events|DELETE FROM feedback|DELETE FROM release_note_deliveries/i.test(sql)) return { rows: [] };
      if (/INSERT INTO app_events/i.test(sql)) throw new Error('audit failed');
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {},
  };
  const pool = { async connect() { return client; } };
  const repository = createRepository({ pool });

  await assert.rejects(
    () => repository.confirmAccountDeletion({
      telegramUserId: 777,
      source: 'telegram',
      confirmationText: 'DELETE',
      now: new Date('2026-07-09T10:00:00.000Z'),
    }),
    /audit failed/,
  );
  assert.equal(clientQueries.at(-1), 'ROLLBACK');
  assert.equal(clientQueries.includes('COMMIT'), false);
});
```

- [ ] **Step 3: Run repository tests and verify failure**

Run:

```powershell
npm.cmd test -- apps/api/test/repository.test.js
```

Expected: FAIL because `advanceAccountDeletion`, `cancelAccountDeletion`, `getPendingAccountDeletion`, and `confirmAccountDeletion` are not implemented.

- [ ] **Step 4: Implement state-machine methods and transaction**

Add these methods to `apps/api/src/repository.js`:

```js
async function getUserForAccountDeletion(telegramUserId) {
  const result = await pool.query('SELECT * FROM users WHERE telegram_user_id = $1', [telegramUserId]);
  return result.rows[0] || null;
}

async function getPendingAccountDeletion(telegramUserId, { source, now = new Date() }) {
  assertAccountDeletionSource(source);
  const user = await getUserForAccountDeletion(telegramUserId);
  if (!user) return null;
  await expireAccountDeletionRequests(user.id, now);
  const result = await pool.query(
    `SELECT * FROM account_deletion_requests
     WHERE user_id = $1
       AND source = $2
       AND status = 'pending'
       AND expires_at > $3
     ORDER BY updated_at DESC, id DESC
     LIMIT 1`,
    [user.id, source, now],
  );
  return mapAccountDeletionRequest(result.rows[0]);
}

async function advanceAccountDeletion(telegramUserId, { source, now = new Date() }) {
  assertAccountDeletionSource(source);
  const user = await getUserForAccountDeletion(telegramUserId);
  if (!user) {
    const error = new Error('User not found');
    error.code = 'user_not_found';
    throw error;
  }
  await expireAccountDeletionRequests(user.id, now);
  const result = await pool.query(
    `UPDATE account_deletion_requests
     SET stage = 'awaiting_text', updated_at = $4
     WHERE user_id = $1
       AND source = $2
       AND status = 'pending'
       AND stage = 'requested'
       AND expires_at > $3
     RETURNING *`,
    [user.id, source, now, now],
  );
  if (!result.rows[0]) {
    const error = new Error('No pending account deletion request');
    error.code = 'account_deletion_not_pending';
    throw error;
  }
  return mapAccountDeletionRequest(result.rows[0]);
}

async function cancelAccountDeletion(telegramUserId, { source, now = new Date() }) {
  assertAccountDeletionSource(source);
  const user = await getUserForAccountDeletion(telegramUserId);
  if (!user) return { status: 'cancelled' };
  await pool.query(
    `UPDATE account_deletion_requests
     SET status = 'cancelled', updated_at = $3
     WHERE user_id = $1
       AND source = $2
       AND status = 'pending'`,
    [user.id, source, now],
  );
  return { status: 'cancelled' };
}

async function confirmAccountDeletion({ telegramUserId, source, confirmationText, now = new Date() }) {
  assertAccountDeletionSource(source);
  if (confirmationText !== 'DELETE') {
    const error = new Error('Invalid confirmation text');
    error.code = 'invalid_account_deletion_confirmation';
    throw error;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userResult = await client.query('SELECT * FROM users WHERE telegram_user_id = $1 FOR UPDATE', [telegramUserId]);
    const user = userResult.rows[0];
    if (!user) {
      const error = new Error('User not found');
      error.code = 'user_not_found';
      throw error;
    }

    const requestResult = await client.query(
      `SELECT * FROM account_deletion_requests
       WHERE user_id = $1
         AND status = 'pending'
       ORDER BY updated_at DESC, id DESC
       LIMIT 1
       FOR UPDATE`,
      [user.id],
    );
    const request = requestResult.rows[0];
    if (!request || request.source !== source || request.stage !== 'awaiting_text' || request.expires_at <= now) {
      const error = new Error('Account deletion is not ready to confirm');
      error.code = 'account_deletion_not_pending';
      throw error;
    }

    await client.query('DELETE FROM app_events WHERE user_id = $1', [user.id]);
    await client.query('DELETE FROM feedback WHERE user_id = $1 OR telegram_user_id = $2', [user.id, telegramUserId]);
    await client.query('DELETE FROM release_note_deliveries WHERE user_id = $1', [user.id]);
    await client.query(
      `INSERT INTO app_events (user_id, event_name, metadata, created_at)
       VALUES ($1, $2, $3, $4)`,
      [null, 'account_deleted', { source }, now],
    );
    await client.query('DELETE FROM users WHERE id = $1', [user.id]);
    await client.query('COMMIT');
    return { status: 'deleted' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

Export all four methods through the repository object.

- [ ] **Step 5: Run repository tests and verify pass**

Run:

```powershell
npm.cmd test -- apps/api/test/repository.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit repository transaction**

Run:

```powershell
git add apps/api/src/repository.js apps/api/test/repository.test.js
git commit -m "Add account deletion repository transaction"
```

## Task 4: Mini App API Endpoints

**Files:**
- Modify: `apps/api/test/security.test.js`
- Modify: `apps/api/src/server.js`

- [ ] **Step 1: Add failing API security tests**

Add tests to `apps/api/test/security.test.js` that instantiate the API route with a fake `apiSecurity` and repository. Follow the existing server-route test pattern in the file, and assert these call records:

```js
test('account deletion endpoints require verified Mini App auth and ignore client identity', async () => {
  const calls = [];
  const apiSecurity = {
    resolveVerifiedTelegramUserId(req) {
      calls.push({ method: 'resolveVerifiedTelegramUserId', args: [req] });
      return { telegramUserId: 777 };
    },
  };
  const repository = {
    async requestAccountDeletion(telegramUserId, options) {
      calls.push({ method: 'requestAccountDeletion', telegramUserId, options });
      return { status: 'pending', stage: 'requested', expiresAt: new Date('2026-07-09T10:15:00.000Z') };
    },
  };

  const response = await callApiRoute({
    method: 'POST',
    path: '/api/account-deletion/request',
    body: { source: 'miniapp', telegramUserId: 999, userId: 123 },
    apiSecurity,
    repository,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    status: 'pending',
    stage: 'requested',
    expiresAt: '2026-07-09T10:15:00.000Z',
  });
  assert.equal(calls[0].method, 'resolveVerifiedTelegramUserId');
  assert.equal(calls[0].args.length, 1);
  assert.equal(calls[1].telegramUserId, 777);
});

test('account deletion endpoints reject non-miniapp source', async () => {
  const response = await callApiRoute({
    method: 'POST',
    path: '/api/account-deletion/request',
    body: { source: 'telegram' },
    apiSecurity: { resolveVerifiedTelegramUserId: () => ({ telegramUserId: 777 }) },
    repository: {},
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, 'invalid_account_deletion_source');
});
```

If `security.test.js` does not already expose `callApiRoute`, create a small local helper in the test file that starts the app with injected dependencies and uses the same HTTP test utility used by neighboring route tests.

- [ ] **Step 2: Run API security tests and verify failure**

Run:

```powershell
npm.cmd test -- apps/api/test/security.test.js
```

Expected: FAIL because `/api/account-deletion/request` is missing.

- [ ] **Step 3: Add the routes**

In `apps/api/src/server.js`, add route handlers near the settings/export Mini App routes:

```js
function assertMiniAppDeletionSource(body) {
  if (!body || body.source !== 'miniapp') {
    return { statusCode: 400, body: { error: 'invalid_account_deletion_source' } };
  }
  return null;
}

function serializeDeletionRequest(request) {
  return {
    status: request.status,
    stage: request.stage,
    expiresAt: request.expiresAt instanceof Date ? request.expiresAt.toISOString() : new Date(request.expiresAt).toISOString(),
  };
}
```

For each route:

```js
if (req.method === 'POST' && url.pathname === '/api/account-deletion/request') {
  const body = await readJsonBody(req);
  const sourceError = assertMiniAppDeletionSource(body);
  if (sourceError) return sendJson(res, sourceError.statusCode, sourceError.body);
  const auth = apiSecurity.resolveVerifiedTelegramUserId(req);
  if (auth.error) return sendJson(res, auth.statusCode, { error: auth.error });
  const request = await repository.requestAccountDeletion(auth.telegramUserId, { source: 'miniapp' });
  return sendJson(res, 200, serializeDeletionRequest(request));
}

if (req.method === 'POST' && url.pathname === '/api/account-deletion/advance') {
  const body = await readJsonBody(req);
  const sourceError = assertMiniAppDeletionSource(body);
  if (sourceError) return sendJson(res, sourceError.statusCode, sourceError.body);
  const auth = apiSecurity.resolveVerifiedTelegramUserId(req);
  if (auth.error) return sendJson(res, auth.statusCode, { error: auth.error });
  const request = await repository.advanceAccountDeletion(auth.telegramUserId, { source: 'miniapp' });
  return sendJson(res, 200, serializeDeletionRequest(request));
}

if (req.method === 'POST' && url.pathname === '/api/account-deletion/cancel') {
  const body = await readJsonBody(req);
  const sourceError = assertMiniAppDeletionSource(body);
  if (sourceError) return sendJson(res, sourceError.statusCode, sourceError.body);
  const auth = apiSecurity.resolveVerifiedTelegramUserId(req);
  if (auth.error) return sendJson(res, auth.statusCode, { error: auth.error });
  const result = await repository.cancelAccountDeletion(auth.telegramUserId, { source: 'miniapp' });
  return sendJson(res, 200, result);
}

if (req.method === 'POST' && url.pathname === '/api/account-deletion/confirm') {
  const body = await readJsonBody(req);
  const sourceError = assertMiniAppDeletionSource(body);
  if (sourceError) return sendJson(res, sourceError.statusCode, sourceError.body);
  const auth = apiSecurity.resolveVerifiedTelegramUserId(req);
  if (auth.error) return sendJson(res, auth.statusCode, { error: auth.error });
  const result = await repository.confirmAccountDeletion({
    telegramUserId: auth.telegramUserId,
    source: 'miniapp',
    confirmationText: body.confirmationText,
  });
  return sendJson(res, 200, result);
}
```

Map known repository errors:

```js
if (error.code === 'invalid_account_deletion_source') return sendJson(res, 400, { error: error.code });
if (error.code === 'account_deletion_already_pending') return sendJson(res, 409, { error: error.code });
if (error.code === 'account_deletion_not_pending') return sendJson(res, 409, { error: error.code });
if (error.code === 'invalid_account_deletion_confirmation') return sendJson(res, 400, { error: error.code });
if (error.code === 'user_not_found') return sendJson(res, 404, { error: error.code });
```

Keep unexpected errors in the existing `internal_error` catch path.

- [ ] **Step 4: Run API security tests and verify pass**

Run:

```powershell
npm.cmd test -- apps/api/test/security.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit API endpoints**

Run:

```powershell
git add apps/api/src/server.js apps/api/test/security.test.js
git commit -m "Add verified account deletion API"
```

## Task 5: Telegram Account Deletion Flow

**Files:**
- Modify: `apps/api/test/telegram.test.js`
- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/src/telegramCommands.js`

- [ ] **Step 1: Extend Telegram fake repository**

In `apps/api/test/telegram.test.js`, add these methods to the local `fakeRepository()` object:

```js
requestAccountDeletion: async () => ({
  status: 'pending',
  stage: 'requested',
  source: 'telegram',
  expiresAt: new Date('2026-07-09T10:15:00.000Z'),
}),
advanceAccountDeletion: async () => ({
  status: 'pending',
  stage: 'awaiting_text',
  source: 'telegram',
  expiresAt: new Date('2026-07-09T10:15:00.000Z'),
}),
cancelAccountDeletion: async () => ({ status: 'cancelled' }),
getPendingAccountDeletion: async () => null,
confirmAccountDeletion: async () => ({ status: 'deleted' }),
```

- [ ] **Step 2: Add failing Telegram tests**

Add tests near existing command/callback tests:

```js
test('/delete_me starts account deletion and sends warning buttons', async () => {
  const calls = [];
  const repository = {
    ...fakeRepository(),
    async requestAccountDeletion(telegramUserId, options) {
      calls.push({ telegramUserId, options });
      return { status: 'pending', stage: 'requested', source: 'telegram', expiresAt: new Date('2026-07-09T10:15:00.000Z') };
    },
  };
  const sent = [];
  const bot = createTelegramBot({
    repository,
    telegramApi: { sendMessage: async (chatId, text, options) => sent.push({ chatId, text, options }) },
  });

  await bot.handleMessage({ message_id: 1, chat: { id: 123 }, from: { id: 777 }, text: '/delete_me' });

  assert.deepEqual(calls[0], { telegramUserId: 777, options: { source: 'telegram' } });
  assert.match(sent[0].text, /delete/i);
  assert.deepEqual(sent[0].options.reply_markup.inline_keyboard[0].map((button) => button.callback_data), ['delete_me:advance', 'delete_me:cancel']);
});

test('delete_me advance callback moves to DELETE text stage and keeps cancel button', async () => {
  const repository = {
    ...fakeRepository(),
    async advanceAccountDeletion() {
      return { status: 'pending', stage: 'awaiting_text', source: 'telegram', expiresAt: new Date('2026-07-09T10:15:00.000Z') };
    },
  };
  const edits = [];
  const bot = createTelegramBot({
    repository,
    telegramApi: { editMessageText: async (chatId, messageId, text, options) => edits.push({ chatId, messageId, text, options }), answerCallbackQuery: async () => {} },
  });

  await bot.handleCallbackQuery({ id: 'cb1', from: { id: 777 }, message: { chat: { id: 123 }, message_id: 55 }, data: 'delete_me:advance' });

  assert.match(edits[0].text, /DELETE/);
  assert.equal(edits[0].options.reply_markup.inline_keyboard[0][0].callback_data, 'delete_me:cancel');
});

test('pending DELETE text is confirmed before parser queue and final response has no app keyboard', async () => {
  const events = [];
  const repository = {
    ...fakeRepository(),
    async getPendingAccountDeletion() {
      return { status: 'pending', stage: 'awaiting_text', source: 'telegram', expiresAt: new Date('2026-07-09T10:15:00.000Z') };
    },
    async confirmAccountDeletion(args) {
      events.push({ method: 'confirmAccountDeletion', args });
      return { status: 'deleted' };
    },
    async recordAppEvent() {
      events.push({ method: 'recordAppEvent' });
    },
  };
  const queue = { enqueue: async () => events.push({ method: 'enqueue' }) };
  const sent = [];
  const bot = createTelegramBot({
    repository,
    telegramJobQueue: queue,
    telegramApi: { sendMessage: async (chatId, text, options) => sent.push({ chatId, text, options }) },
  });

  await bot.handleMessage({ message_id: 2, chat: { id: 123 }, from: { id: 777 }, text: 'DELETE' });

  assert.equal(events[0].method, 'confirmAccountDeletion');
  assert.equal(events.some((event) => event.method === 'enqueue'), false);
  assert.equal(events.some((event) => event.method === 'recordAppEvent'), false);
  assert.equal(sent[0].options?.reply_markup?.keyboard, undefined);
});
```

- [ ] **Step 3: Run Telegram tests and verify failure**

Run:

```powershell
npm.cmd test -- apps/api/test/telegram.test.js
```

Expected: FAIL because `/delete_me` and callback/text handling are missing.

- [ ] **Step 4: Add command menu entries**

In `apps/api/src/telegramCommands.js`, add:

```js
{ command: 'delete_me', description: 'Delete my data' },
```

to `DEFAULT_COMMANDS`, and add the RU localized equivalent to `RU_COMMANDS`:

```js
{ command: 'delete_me', description: 'Удалить мои данные' },
```

- [ ] **Step 5: Implement Telegram flow**

In `apps/api/src/telegram.js`, add:

```js
const ACCOUNT_DELETION_SOURCE_TELEGRAM = 'telegram';

function accountDeletionButtons(stage = 'requested') {
  if (stage === 'awaiting_text') {
    return { inline_keyboard: [[{ text: 'Cancel', callback_data: 'delete_me:cancel' }]] };
  }
  return {
    inline_keyboard: [[
      { text: 'Continue', callback_data: 'delete_me:advance' },
      { text: 'Cancel', callback_data: 'delete_me:cancel' },
    ]],
  };
}
```

In command handling before generic text enqueue:

```js
if (text === '/delete_me' || text.startsWith('/delete_me ')) {
  await repository.requestAccountDeletion(from.id, { source: ACCOUNT_DELETION_SOURCE_TELEGRAM });
  await sendTelegramMessage(chat.id, 'This permanently deletes your Money Flow data. Continue only if you are sure.', {
    reply_markup: accountDeletionButtons('requested'),
  });
  return;
}
```

In callback handling immediately after parsing `callback.data`:

```js
if (action === 'delete_me') {
  if (draftId === 'cancel') {
    await repository.cancelAccountDeletion(callback.from.id, { source: ACCOUNT_DELETION_SOURCE_TELEGRAM });
    await telegramApi.answerCallbackQuery(callback.id);
    await telegramApi.editMessageText(callback.message.chat.id, callback.message.message_id, 'Account deletion cancelled.');
    return;
  }
  if (draftId === 'advance') {
    const request = await repository.advanceAccountDeletion(callback.from.id, { source: ACCOUNT_DELETION_SOURCE_TELEGRAM });
    await telegramApi.answerCallbackQuery(callback.id);
    await telegramApi.editMessageText(
      callback.message.chat.id,
      callback.message.message_id,
      'Final step: type DELETE in this chat to permanently delete your data.',
      { reply_markup: accountDeletionButtons(request.stage) },
    );
    return;
  }
}
```

At the top of ordinary message handling, before `trackExpenseMessage`, `safeRecordAppEvent('message_received')`, and `telegramJobQueue.enqueue(...)`:

```js
const pendingDeletion = await repository.getPendingAccountDeletion(from.id, {
  source: ACCOUNT_DELETION_SOURCE_TELEGRAM,
});
if (pendingDeletion?.stage === 'awaiting_text') {
  if (text === 'DELETE') {
    await repository.confirmAccountDeletion({
      telegramUserId: from.id,
      source: ACCOUNT_DELETION_SOURCE_TELEGRAM,
      confirmationText: text,
    });
    await sendTelegramMessage(chat.id, 'Your Money Flow data has been deleted.');
    return;
  }
  await sendTelegramMessage(chat.id, 'Type DELETE to confirm or /delete_me to start again.');
  return;
}
```

- [ ] **Step 6: Run Telegram tests and verify pass**

Run:

```powershell
npm.cmd test -- apps/api/test/telegram.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit Telegram flow**

Run:

```powershell
git add apps/api/src/telegram.js apps/api/src/telegramCommands.js apps/api/test/telegram.test.js
git commit -m "Add Telegram account deletion flow"
```

## Task 6: Mini App Danger Zone UX

**Files:**
- Modify: `apps/miniapp/test/smokeAssets.test.js`
- Modify: `apps/miniapp/src/index.html`
- Modify: `apps/miniapp/src/app.js`
- Modify: `apps/miniapp/src/styles.css`

- [ ] **Step 1: Add failing smoke tests**

Add tests to `apps/miniapp/test/smokeAssets.test.js`:

```js
test('settings tab contains account deletion danger zone after settings form', () => {
  const settingsTabIndex = html.indexOf('id="settingsTab"');
  const formStart = html.indexOf('id="settingsForm"', settingsTabIndex);
  const formEnd = html.indexOf('</form>', formStart);
  const deleteSection = html.indexOf('id="deleteAccountSection"', settingsTabIndex);

  assert.ok(settingsTabIndex >= 0);
  assert.ok(formStart > settingsTabIndex);
  assert.ok(formEnd > formStart);
  assert.ok(deleteSection > formEnd);
});

test('app wires account deletion controls and endpoints', () => {
  for (const id of [
    'deleteAccountStartButton',
    'deleteAccountAdvanceButton',
    'deleteAccountCancelButton',
    'deleteAccountConfirmInput',
    'deleteAccountConfirmButton',
  ]) {
    assert.match(appJs, new RegExp(`getElementById\\('${id}'\\)`));
  }
  for (const endpoint of [
    '/api/account-deletion/request',
    '/api/account-deletion/advance',
    '/api/account-deletion/cancel',
    '/api/account-deletion/confirm',
  ]) {
    assert.match(appJs, new RegExp(endpoint.replace(/[/-]/g, '\\\\$&')));
  }
});

test('app guards data loaders after account deletion', () => {
  assert.match(appJs, /let accountDeleted = false/);
  assert.match(appJs, /if \(accountDeleted\) return;/);
  assert.match(appJs, /renderDeletedState/);
});
```

- [ ] **Step 2: Run Mini App smoke tests and verify failure**

Run:

```powershell
npm.cmd test -- apps/miniapp/test/smokeAssets.test.js
```

Expected: FAIL because danger-zone markup and JS wiring are missing.

- [ ] **Step 3: Add danger-zone markup after settings form**

In `apps/miniapp/src/index.html`, inside `#settingsTab` and after the closing `</form>` for `#settingsForm`, add:

```html
<section class="settings-section danger-zone" id="deleteAccountSection">
  <h2 data-i18n="settings.deleteAccount.title">Delete my data</h2>
  <p data-i18n="settings.deleteAccount.description">
    Permanently delete your Money Flow data. This cannot be undone.
  </p>
  <div class="delete-account-actions" id="deleteAccountRequestedState">
    <button type="button" class="danger-button" id="deleteAccountStartButton" data-i18n="settings.deleteAccount.start">
      Delete my data
    </button>
  </div>
  <div class="delete-account-actions hidden" id="deleteAccountAdvanceState">
    <button type="button" class="danger-button" id="deleteAccountAdvanceButton" data-i18n="settings.deleteAccount.advance">
      Continue
    </button>
    <button type="button" class="secondary-button" id="deleteAccountCancelButton" data-i18n="settings.deleteAccount.cancel">
      Cancel
    </button>
  </div>
  <div class="delete-account-actions hidden" id="deleteAccountConfirmState">
    <label for="deleteAccountConfirmInput" data-i18n="settings.deleteAccount.confirmLabel">
      Type DELETE to confirm
    </label>
    <input id="deleteAccountConfirmInput" autocomplete="off" />
    <button type="button" class="danger-button" id="deleteAccountConfirmButton" data-i18n="settings.deleteAccount.confirm">
      Delete permanently
    </button>
  </div>
</section>
```

- [ ] **Step 4: Add JS state and guards**

In `apps/miniapp/src/app.js`, near top-level state:

```js
let accountDeleted = false;
```

Add guards at the top of these functions:

```js
async function loadDashboard() {
  if (accountDeleted) return;
  ...
}

async function loadHistory() {
  if (accountDeleted) return;
  ...
}

async function saveSettings(event) {
  if (accountDeleted) return;
  ...
}

async function requestExpenseExport() {
  if (accountDeleted) return;
  ...
}

function switchTab(tabName) {
  if (accountDeleted) return;
  ...
}
```

Add endpoint helper:

```js
async function callAccountDeletion(endpoint, body = {}) {
  return api(endpoint, {
    method: 'POST',
    body: JSON.stringify({ source: 'miniapp', ...body }),
  });
}
```

Add render helper:

```js
function renderDeletedState() {
  accountDeleted = true;
  document.querySelectorAll('.bottom-tabs button').forEach((button) => {
    button.disabled = true;
  });
  document.querySelectorAll('#settingsForm input, #settingsForm select, #settingsForm button').forEach((control) => {
    control.disabled = true;
  });
  document.querySelectorAll('[data-history-action], [data-dashboard-action], #exportButton').forEach((control) => {
    control.disabled = true;
  });
  const section = document.getElementById('deleteAccountSection');
  if (section) {
    section.innerHTML = `
      <h2>${t('settings.deleteAccount.deletedTitle')}</h2>
      <p>${t('settings.deleteAccount.deletedDescription')}</p>
    `;
  }
}
```

Add listeners near existing settings/export listeners:

```js
document.getElementById('deleteAccountStartButton')?.addEventListener('click', async () => {
  await callAccountDeletion('/api/account-deletion/request');
  document.getElementById('deleteAccountRequestedState')?.classList.add('hidden');
  document.getElementById('deleteAccountAdvanceState')?.classList.remove('hidden');
});

document.getElementById('deleteAccountAdvanceButton')?.addEventListener('click', async () => {
  await callAccountDeletion('/api/account-deletion/advance');
  document.getElementById('deleteAccountAdvanceState')?.classList.add('hidden');
  document.getElementById('deleteAccountConfirmState')?.classList.remove('hidden');
  document.getElementById('deleteAccountConfirmInput')?.focus();
});

document.getElementById('deleteAccountCancelButton')?.addEventListener('click', async () => {
  await callAccountDeletion('/api/account-deletion/cancel');
  document.getElementById('deleteAccountAdvanceState')?.classList.add('hidden');
  document.getElementById('deleteAccountConfirmState')?.classList.add('hidden');
  document.getElementById('deleteAccountRequestedState')?.classList.remove('hidden');
});

document.getElementById('deleteAccountConfirmButton')?.addEventListener('click', async () => {
  const confirmationText = document.getElementById('deleteAccountConfirmInput')?.value || '';
  await callAccountDeletion('/api/account-deletion/confirm', { confirmationText });
  renderDeletedState();
});
```

- [ ] **Step 5: Add i18n keys and styles**

Add EN/RU i18n keys to the existing i18n dictionary in `apps/miniapp/src/app.js`:

```js
'settings.deleteAccount.title': 'Delete my data',
'settings.deleteAccount.description': 'Permanently delete your Money Flow data. This cannot be undone.',
'settings.deleteAccount.start': 'Delete my data',
'settings.deleteAccount.advance': 'Continue',
'settings.deleteAccount.cancel': 'Cancel',
'settings.deleteAccount.confirmLabel': 'Type DELETE to confirm',
'settings.deleteAccount.confirm': 'Delete permanently',
'settings.deleteAccount.deletedTitle': 'Data deleted',
'settings.deleteAccount.deletedDescription': 'Your Money Flow data has been deleted.',
```

Add RU equivalents:

```js
'settings.deleteAccount.title': 'Удалить мои данные',
'settings.deleteAccount.description': 'Навсегда удалить данные Money Flow. Это действие нельзя отменить.',
'settings.deleteAccount.start': 'Удалить мои данные',
'settings.deleteAccount.advance': 'Продолжить',
'settings.deleteAccount.cancel': 'Отмена',
'settings.deleteAccount.confirmLabel': 'Введите DELETE для подтверждения',
'settings.deleteAccount.confirm': 'Удалить навсегда',
'settings.deleteAccount.deletedTitle': 'Данные удалены',
'settings.deleteAccount.deletedDescription': 'Ваши данные Money Flow удалены.',
```

In `apps/miniapp/src/styles.css`, add:

```css
.danger-zone {
  border-top: 1px solid var(--border-color);
  margin-top: 24px;
  padding-top: 20px;
}

.danger-zone h2 {
  color: var(--danger-color);
}

.delete-account-actions {
  display: grid;
  gap: 12px;
  margin-top: 16px;
}

.danger-button {
  background: var(--danger-color);
  color: #fff;
}

.danger-button:disabled {
  opacity: 0.6;
}
```

Use existing CSS variable names if `--border-color` or `--danger-color` already exist under different local names.

- [ ] **Step 6: Run Mini App smoke tests and verify pass**

Run:

```powershell
npm.cmd test -- apps/miniapp/test/smokeAssets.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit Mini App UX**

Run:

```powershell
git add apps/miniapp/src/index.html apps/miniapp/src/app.js apps/miniapp/src/styles.css apps/miniapp/test/smokeAssets.test.js
git commit -m "Add Mini App account deletion UX"
```

## Task 7: Verification, Diff Review, And PR

**Files:**
- Review: `docs/superpowers/specs/2026-07-09-account-deletion-design.md`
- Review: all changed files

- [ ] **Step 1: Run focused backend tests**

Run:

```powershell
npm.cmd test -- apps/api/test/db.test.js apps/api/test/repository.test.js apps/api/test/security.test.js apps/api/test/telegram.test.js
```

Expected: PASS.

- [ ] **Step 2: Run focused Mini App tests**

Run:

```powershell
npm.cmd test -- apps/miniapp/test/smokeAssets.test.js
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run:

```powershell
npm.cmd test
```

Expected: PASS.

- [ ] **Step 4: Check formatting-sensitive diff**

Run:

```powershell
git diff --check
```

Expected: no output.

- [ ] **Step 5: Review final diff for privacy requirements**

Run:

```powershell
git diff origin/master...HEAD -- apps/api/src/repository.js apps/api/src/server.js apps/api/src/telegram.js apps/miniapp/src/app.js
```

Verify these facts in the diff:

```text
repository.confirmAccountDeletion accepts telegramUserId, source, confirmationText, now.
No deletion endpoint accepts userId from body/query.
Mini App routes call apiSecurity.resolveVerifiedTelegramUserId(req).
Final audit insert uses direct SQL inside BEGIN/COMMIT.
Audit metadata is exactly { source }.
feedback deletion uses user_id OR telegram_user_id.
Telegram DELETE handling runs before parser queue and message_received app event.
Successful Telegram deletion sends no appKeyboard.
```

- [ ] **Step 6: Prepare PR body**

Use this body shape:

```markdown
## Summary
- Adds account deletion request lifecycle and final hard-delete transaction.
- Adds verified Mini App deletion endpoints and Telegram `/delete_me` flow.
- Adds Mini App danger-zone UX and deleted-state guards.

## Changed Areas
- API repository and migration
- Mini App account deletion routes and UI
- Telegram command/callback/text handling
- Tests for repository, security, Telegram, migrations, and Mini App assets

## Docs Checked/Updated
- Checked `docs/superpowers/specs/2026-07-09-account-deletion-design.md`
- Updated implementation tests and migration contract

## Tests Run
- `npm.cmd test -- apps/api/test/db.test.js apps/api/test/repository.test.js apps/api/test/security.test.js apps/api/test/telegram.test.js`
- `npm.cmd test -- apps/miniapp/test/smokeAssets.test.js`
- `npm.cmd test`
- `git diff --check`

## DB/Prod Impact
- Adds `account_deletion_requests`.
- Changes `release_note_deliveries.user_id` FK to `ON DELETE CASCADE`.
- Final deletion hard-deletes user-owned `app_events`, `feedback`, `release_note_deliveries`, and the `users` row in one transaction.
- No production DB writes were run.

## Security/Privacy
- Mini App deletion endpoints use verified Telegram initData only.
- Client-sent `telegramUserId`, `userId`, and query identity fields are ignored.
- No financial data, feedback message, Telegram initData, raw Telegram ID, username, first name, source_text, or request body is written to the final audit event or logs.
- Final audit event metadata is non-identifying: `{ "source": "miniapp" | "telegram" }`.

## Release Notes Impact
- User-visible deletion feature; include in release notes.

## User Release Notes
- Added a protected delete-my-data flow in Telegram and the Mini App settings screen.

## Screenshots
- Mini App settings danger zone: attach local screenshot if a dev server was run.
- Deleted state: attach local screenshot if a dev server was run.

## Open Questions / Assumptions
- MVP hard-deletes `app_events` and `feedback`; anonymization is intentionally out of scope.
```

- [ ] **Step 7: Push branch and open draft PR**

Run:

```powershell
git status -sb
git push -u origin codex/account-deletion-design
gh pr create --draft --base master --head codex/account-deletion-design --title "Add account deletion flow" --body-file <path-to-pr-body>
```

Expected: draft PR URL.
