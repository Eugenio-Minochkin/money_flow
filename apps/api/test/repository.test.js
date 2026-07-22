import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createExchangeRateProvider } from "../src/exchangeRates.js";
import { createRepository, shouldInvalidateExpenseSnapshot } from "../src/repository.js";
import * as repositoryModule from "../src/repository.js";
import { formatSavedSummary } from "../src/telegramFormat.js";

test("records app events with JSON metadata", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [] };
  }));

  await repo.recordAppEvent(7, "message_received", { inputType: "text" });

  assert.match(queries[0].sql, /INSERT INTO app_events/);
  assert.deepEqual(queries[0].params, [7, "message_received", JSON.stringify({ inputType: "text" })]);
});

test("records singleton onboarding events with conflict protection", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [], rowCount: 0 };
  }));

  const result = await repo.recordAppEventOnce(7, "onboarding_started", { source: "telegram" });

  assert.deepEqual(result, { recorded: false });
  assert.match(queries[0].sql, /INSERT INTO app_events/);
  assert.match(queries[0].sql, /ON CONFLICT DO NOTHING/);
  assert.deepEqual(queries[0].params, [7, "onboarding_started", JSON.stringify({ source: "telegram" })]);
});

test("rejects repeatable events through the singleton event boundary", async () => {
  const repo = createRepository(fakePool(() => {
    throw new Error("database should not be called");
  }));

  await assert.rejects(
    () => repo.recordAppEventOnce(7, "bot_started"),
    { code: "invalid_singleton_event" }
  );
});

test("upsertTelegramUser assigns first-touch in one atomic statement", async () => {
  const queries = [];
  const seenAt = new Date("2026-07-10T10:00:00.000Z");
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return {
      rows: [{
        id: 7,
        telegram_user_id: params[0],
        acquisition_source: "friend_alex",
        is_new: false
      }]
    };
  }));

  await repo.upsertTelegramUser({
    id: 100,
    firstName: "New name",
    username: "new_user",
    acquisitionSource: " EXPAT_CM ",
    acquisitionSeenAt: seenAt
  });

  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /INSERT INTO users/);
  assert.match(queries[0].sql, /acquisition_source = COALESCE\(users\.acquisition_source, EXCLUDED\.acquisition_source\)/);
  assert.match(queries[0].sql, /acquisition_first_seen_at = COALESCE\(users\.acquisition_first_seen_at, EXCLUDED\.acquisition_first_seen_at\)/);
  assert.deepEqual(queries[0].params, [100, "New name", "new_user", 45000, "expat_cm", seenAt]);
});

test("concurrent first-touch upserts use only the same atomic statement", async () => {
  const queries = [];
  const repo = createRepository(fakePool(async (sql, params) => {
    queries.push({ sql: String(sql), params });
    await Promise.resolve();
    return { rows: [{ id: 7, telegram_user_id: params[0], is_new: false }] };
  }));

  await Promise.all([
    repo.upsertTelegramUser({ id: 100, acquisitionSource: "friend_alex" }),
    repo.upsertTelegramUser({ id: 100, acquisitionSource: "expat_cm" })
  ]);

  assert.equal(queries.length, 2);
  assert.equal(queries.every(({ sql }) => /INSERT INTO users/.test(sql)), true);
  assert.equal(queries.some(({ sql }) => /^SELECT/i.test(sql.trim())), false);
});

test("creates feedback with durable user and source metadata", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return {
      rows: [{
        id: 9,
        user_id: params[0],
        telegram_user_id: params[1],
        message: params[2],
        status: params[3],
        source: params[4]
      }]
    };
  }));

  const feedback = await repo.createFeedback({
    userId: 7,
    telegramUserId: 100,
    message: "  Please make category editing easier  ",
    source: "bot"
  });

  assert.equal(feedback.id, 9);
  assert.equal(feedback.user_id, 7);
  assert.equal(feedback.telegram_user_id, 100);
  assert.equal(feedback.message, "Please make category editing easier");
  assert.equal(feedback.status, "new");
  assert.equal(feedback.source, "bot");
  assert.match(queries[0].sql, /INSERT INTO feedback/);
  assert.match(queries[0].sql, /RETURNING \*/);
  assert.deepEqual(queries[0].params, [7, 100, "Please make category editing easier", "new", "bot"]);
  const event = queries.find((query) => query.sql.includes("INSERT INTO app_events"));
  assert.deepEqual(event.params, [7, "feedback_sent", JSON.stringify({ source: "telegram" })]);
  assert.doesNotMatch(event.params[2], /category editing/i);
});

test("requestAccountDeletion expires old pending request before creating a new pending request", async () => {
  const now = new Date("2026-07-09T10:00:00.000Z");
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    queries.push({ sql: query, params });
    if (query.includes("SELECT * FROM users WHERE telegram_user_id")) {
      return { rows: [{ id: 42, telegram_user_id: "777" }] };
    }
    if (query.includes("UPDATE account_deletion_requests") && query.includes("status = 'expired'")) {
      return { rowCount: 1, rows: [] };
    }
    if (query.includes("SELECT * FROM account_deletion_requests")) return { rows: [] };
    if (query.includes("INSERT INTO account_deletion_requests")) {
      return {
        rows: [{
          id: 9,
          user_id: params[0],
          source: params[1],
          stage: "requested",
          status: "pending",
          expires_at: params[2]
        }]
      };
    }
    throw new Error(`Unexpected SQL: ${query}`);
  }));

  const request = await repo.requestAccountDeletion(777, { source: "miniapp", now });

  assert.equal(request.status, "pending");
  const expireIndex = queries.findIndex((query) => query.sql.includes("status = 'expired'"));
  const insertIndex = queries.findIndex((query) => query.sql.includes("INSERT INTO account_deletion_requests"));
  assert.ok(expireIndex > -1, "expected expired request cleanup");
  assert.ok(expireIndex < insertIndex, "expected cleanup before insert");
  assert.equal(queries[expireIndex].params[0], 42);
  assert.equal(queries[expireIndex].params[1], now);
});

test("requestAccountDeletion creates requested stage with default 15 minute ttl", async () => {
  const now = new Date("2026-07-09T10:00:00.000Z");
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    queries.push({ sql: query, params });
    if (query.includes("SELECT * FROM users WHERE telegram_user_id")) {
      return { rows: [{ id: 42, telegram_user_id: "777" }] };
    }
    if (query.includes("UPDATE account_deletion_requests")) return { rowCount: 0, rows: [] };
    if (query.includes("SELECT * FROM account_deletion_requests")) return { rows: [] };
    if (query.includes("INSERT INTO account_deletion_requests")) {
      return {
        rows: [{
          id: 1,
          user_id: params[0],
          source: params[1],
          stage: "requested",
          status: "pending",
          expires_at: params[2],
          created_at: params[3],
          updated_at: params[3]
        }]
      };
    }
    throw new Error(`Unexpected SQL: ${query}`);
  }));

  const request = await repo.requestAccountDeletion(777, { source: "miniapp", now });

  assert.equal(request.status, "pending");
  assert.equal(request.stage, "requested");
  assert.equal(request.source, "miniapp");
  assert.equal(request.expiresAt.toISOString(), "2026-07-09T10:15:00.000Z");
  const insertQuery = queries.find((query) => query.sql.includes("INSERT INTO account_deletion_requests"));
  assert.match(insertQuery.sql, /'requested'/);
  assert.equal(insertQuery.params[0], 42);
  assert.equal(insertQuery.params[1], "miniapp");
});

test("requestAccountDeletion refreshes same-source pending request to requested stage", async () => {
  const now = new Date("2026-07-09T10:00:00.000Z");
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    if (query.includes("SELECT * FROM users WHERE telegram_user_id")) return { rows: [{ id: 42 }] };
    if (query.includes("UPDATE account_deletion_requests") && query.includes("status = 'expired'")) return { rows: [] };
    if (query.includes("SELECT * FROM account_deletion_requests")) {
      return { rows: [{ id: 5, user_id: 42, source: "telegram", stage: "awaiting_text", status: "pending" }] };
    }
    if (query.includes("UPDATE account_deletion_requests") && query.includes("stage = 'requested'")) {
      return {
        rows: [{
          id: params[0],
          user_id: 42,
          source: "telegram",
          stage: "requested",
          status: "pending",
          expires_at: params[1]
        }]
      };
    }
    throw new Error(`Unexpected SQL: ${query}`);
  }));

  const request = await repo.requestAccountDeletion(777, { source: "telegram", now });

  assert.equal(request.stage, "requested");
  assert.equal(request.expiresAt.toISOString(), "2026-07-09T10:15:00.000Z");
});

test("requestAccountDeletion rejects a different-source active pending request", async () => {
  const repo = createRepository(fakePool((sql) => {
    const query = String(sql);
    if (query.includes("SELECT * FROM users WHERE telegram_user_id")) return { rows: [{ id: 42 }] };
    if (query.includes("UPDATE account_deletion_requests")) return { rows: [] };
    if (query.includes("SELECT * FROM account_deletion_requests")) {
      return { rows: [{ id: 5, user_id: 42, source: "telegram", stage: "requested", status: "pending" }] };
    }
    throw new Error(`Unexpected SQL: ${query}`);
  }));

  await assert.rejects(
    () => repo.requestAccountDeletion(777, { source: "miniapp", now: new Date("2026-07-09T10:00:00.000Z") }),
    { code: "account_deletion_already_pending" }
  );
});

test("advanceAccountDeletion only advances same-source requested active request", async () => {
  const now = new Date("2026-07-09T10:00:00.000Z");
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    queries.push({ sql: query, params });
    if (query.includes("UPDATE account_deletion_requests")) {
      return {
        rows: [{
          id: 5,
          user_id: 42,
          source: params[1],
          stage: "awaiting_text",
          status: "pending",
          expires_at: new Date("2026-07-09T10:15:00.000Z")
        }]
      };
    }
    throw new Error(`Unexpected SQL: ${query}`);
  }));

  const request = await repo.advanceAccountDeletion(777, { source: "telegram", now });

  assert.equal(request.stage, "awaiting_text");
  assert.equal(request.status, "pending");
  assert.equal(request.source, "telegram");
  assert.match(queries[0].sql, /stage = 'requested'/);
  assert.match(queries[0].sql, /expires_at > \$3/);
  assert.match(queries[0].sql, /users\.telegram_user_id = \$1/);
  assert.equal(queries[0].params[0], 777);
  assert.equal(queries[0].params[1], "telegram");
  assert.equal(queries[0].params[2], now);
});

test("cancelAccountDeletion scopes by source and returns cancelled status", async () => {
  const now = new Date("2026-07-09T10:00:00.000Z");
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    queries.push({ sql: query, params });
    if (query.includes("UPDATE account_deletion_requests")) {
      return {
        rows: [{
          id: 5,
          user_id: 42,
          source: params[1],
          stage: "requested",
          status: "cancelled",
          expires_at: new Date("2026-07-09T10:15:00.000Z")
        }]
      };
    }
    throw new Error(`Unexpected SQL: ${query}`);
  }));

  const result = await repo.cancelAccountDeletion(777, { source: "miniapp", now });

  assert.deepEqual(result, { status: "cancelled" });
  assert.match(queries[0].sql, /account_deletion_requests\.source = \$2/);
  assert.match(queries[0].sql, /users\.telegram_user_id = \$1/);
  assert.equal(queries[0].params[0], 777);
  assert.equal(queries[0].params[1], "miniapp");
  assert.equal(queries[0].params[2], now);
});

test("cancelAccountDeletion is idempotent when no pending row is updated", async () => {
  const repo = createRepository(fakePool((sql) => {
    const query = String(sql);
    if (query.includes("UPDATE account_deletion_requests")) return { rows: [] };
    throw new Error(`Unexpected SQL: ${query}`);
  }));

  const result = await repo.cancelAccountDeletion(777, {
    source: "telegram",
    now: new Date("2026-07-09T10:00:00.000Z")
  });

  assert.deepEqual(result, { status: "cancelled" });
});

test("getPendingAccountDeletion returns null without active same-source request and an object when active", async () => {
  const now = new Date("2026-07-09T10:00:00.000Z");
  let active = false;
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    if (query.includes("SELECT account_deletion_requests.*")) {
      if (!active) return { rows: [] };
      return {
        rows: [{
          id: 5,
          user_id: 42,
          source: params[1],
          stage: "requested",
          status: "pending",
          expires_at: new Date("2026-07-09T10:15:00.000Z")
        }]
      };
    }
    throw new Error(`Unexpected SQL: ${query}`);
  }));

  assert.equal(await repo.getPendingAccountDeletion(777, { source: "telegram", now }), null);
  active = true;
  const request = await repo.getPendingAccountDeletion(777, { source: "telegram", now });

  assert.deepEqual(Object.keys(request).sort(), ["expiresAt", "source", "stage", "status"].sort());
  assert.equal(request.status, "pending");
  assert.equal(request.stage, "requested");
  assert.equal(request.source, "telegram");
  assert.equal(request.expiresAt.toISOString(), "2026-07-09T10:15:00.000Z");
});

test("confirmAccountDeletion hard-deletes user-owned data and writes safe audit in one transaction", async () => {
  const now = new Date("2026-07-09T10:00:00.000Z");
  const { repository, queries } = confirmAccountDeletionRepository({
    request: { source: "miniapp", stage: "awaiting_text", expires_at: new Date("2026-07-09T10:15:00.000Z") }
  });

  const result = await repository.confirmAccountDeletion({
    telegramUserId: 777,
    source: "miniapp",
    confirmationText: "DELETE",
    now
  });

  assert.deepEqual(result, { status: "deleted" });
  assert.equal(queries[0].sql, "BEGIN");
  assert.equal(queries.at(-1).sql, "COMMIT");
  assert.match(queries[1].sql, /SELECT \* FROM users WHERE telegram_user_id = \$1 FOR UPDATE/i);
  assert.deepEqual(queries[1].params, [777]);
  assert.match(queries[2].sql, /SELECT \* FROM account_deletion_requests/i);
  assert.match(queries[2].sql, /FOR UPDATE/i);
  const appEventsDeleteIndex = queries.findIndex((query) => /DELETE FROM app_events/i.test(query.sql));
  const feedbackDeleteIndex = queries.findIndex((query) => /DELETE FROM feedback/i.test(query.sql));
  const deliveriesDeleteIndex = queries.findIndex((query) => /DELETE FROM release_note_deliveries/i.test(query.sql));
  const auditIndex = queries.findIndex((query) => /INSERT INTO app_events/i.test(query.sql));
  const userDeleteIndex = queries.findIndex((query) => /DELETE FROM users/i.test(query.sql));
  const commitIndex = queries.findIndex((query) => query.sql === "COMMIT");
  assert.ok(appEventsDeleteIndex > 2, "expected app_events delete after locked selects");
  assert.ok(feedbackDeleteIndex > appEventsDeleteIndex, "expected feedback delete after app_events delete");
  assert.ok(deliveriesDeleteIndex > feedbackDeleteIndex, "expected release note deliveries delete before audit");
  assert.ok(auditIndex > deliveriesDeleteIndex, "expected audit insert after user-owned deletes");
  assert.ok(userDeleteIndex > auditIndex, "expected user delete after audit insert");
  assert.ok(commitIndex > userDeleteIndex, "expected commit after user delete");
  assert.match(queries[appEventsDeleteIndex].sql, /WHERE user_id = \$1/i);
  assert.deepEqual(queries[appEventsDeleteIndex].params, [42]);
  assert.match(queries[feedbackDeleteIndex].sql, /WHERE user_id = \$1 OR telegram_user_id = \$2/i);
  assert.deepEqual(queries[feedbackDeleteIndex].params, [42, 777]);
  assert.deepEqual(queries[deliveriesDeleteIndex].params, [42]);
  const audit = queries[auditIndex];
  assert.deepEqual(audit.params, [null, "account_deleted", { source: "miniapp" }, now]);
  assert.deepEqual(Object.keys(audit.params[2]), ["source"]);
});

test("confirmAccountDeletion rolls back without deleting when pending request source mismatches", async () => {
  const { repository, queries } = confirmAccountDeletionRepository({
    request: { source: "telegram", stage: "awaiting_text", expires_at: new Date("2026-07-09T10:15:00.000Z") }
  });

  await assert.rejects(
    () => repository.confirmAccountDeletion({
      telegramUserId: 777,
      source: "miniapp",
      confirmationText: "DELETE",
      now: new Date("2026-07-09T10:00:00.000Z")
    }),
    { code: "account_deletion_not_pending" }
  );

  assert.equal(queries.at(-1).sql, "ROLLBACK");
  assert.equal(queries.some((query) => /^DELETE FROM /i.test(query.sql)), false);
  assert.equal(queries.some((query) => query.sql === "COMMIT"), false);
});

test("confirmAccountDeletion rolls back without deleting when request is not awaiting text", async () => {
  const { repository, queries } = confirmAccountDeletionRepository({
    request: { source: "telegram", stage: "requested", expires_at: new Date("2026-07-09T10:15:00.000Z") }
  });

  await assert.rejects(
    () => repository.confirmAccountDeletion({
      telegramUserId: 777,
      source: "telegram",
      confirmationText: "DELETE",
      now: new Date("2026-07-09T10:00:00.000Z")
    }),
    { code: "account_deletion_not_pending" }
  );

  assert.equal(queries.at(-1).sql, "ROLLBACK");
  assert.equal(queries.some((query) => /^DELETE FROM /i.test(query.sql)), false);
});

test("confirmAccountDeletion rolls back without deleting when request is expired", async () => {
  const { repository, queries } = confirmAccountDeletionRepository({
    request: { source: "telegram", stage: "awaiting_text", expires_at: new Date("2026-07-09T09:59:59.000Z") }
  });

  await assert.rejects(
    () => repository.confirmAccountDeletion({
      telegramUserId: 777,
      source: "telegram",
      confirmationText: "DELETE",
      now: new Date("2026-07-09T10:00:00.000Z")
    }),
    { code: "account_deletion_expired" }
  );

  assert.equal(queries.at(-1).sql, "ROLLBACK");
  assert.equal(queries.some((query) => /^DELETE FROM /i.test(query.sql)), false);
});

test("confirmAccountDeletion rejects confirmation text other than exact DELETE", async () => {
  const repository = createRepository({
    async connect() {
      throw new Error("should not start transaction");
    }
  });

  await assert.rejects(
    () => repository.confirmAccountDeletion({
      telegramUserId: 777,
      source: "telegram",
      confirmationText: "delete",
      now: new Date("2026-07-09T10:00:00.000Z")
    }),
    { code: "invalid_account_deletion_confirmation" }
  );
});

test("confirmAccountDeletion rolls back when the audit insert fails", async () => {
  const { repository, queries } = confirmAccountDeletionRepository({ failAudit: true });

  await assert.rejects(
    () => repository.confirmAccountDeletion({
      telegramUserId: 777,
      source: "telegram",
      confirmationText: "DELETE",
      now: new Date("2026-07-09T10:00:00.000Z")
    }),
    /audit failed/
  );

  assert.equal(queries.at(-1).sql, "ROLLBACK");
  assert.equal(queries.some((query) => query.sql === "COMMIT"), false);
  assert.equal(queries.some((query) => /DELETE FROM users/i.test(query.sql)), false);
});

test("confirmAccountDeletion preserves original audit error when rollback fails", async () => {
  const { repository, queries } = confirmAccountDeletionRepository({ failAudit: true, failRollback: true });

  await assert.rejects(
    () => repository.confirmAccountDeletion({
      telegramUserId: 777,
      source: "telegram",
      confirmationText: "DELETE",
      now: new Date("2026-07-09T10:00:00.000Z")
    }),
    /audit failed/
  );

  assert.equal(queries.at(-1).sql, "ROLLBACK");
  assert.equal(queries.some((query) => query.sql === "COMMIT"), false);
});

test("app event logging failures do not reject user operations", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const repo = createRepository(fakePool(() => {
      throw new Error("events unavailable");
    }));

    await assert.doesNotReject(() => repo.recordAppEvent(7, "message_received", { inputType: "text" }));
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings[0][0], "[events] record failed");
  assert.deepEqual(warnings[0][1], {
    userId: 7,
    eventName: "message_received",
    message: "events unavailable"
  });
});

test("creates new Telegram users at the language onboarding step", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [{ id: 1, telegram_user_id: params[0], onboarding_step: "language", is_new: true }] };
  }));

  const user = await repo.upsertTelegramUser({ id: 100, firstName: "M", username: "mino" });

  assert.equal(user.onboarding_step, "language");
  assert.match(queries[0].sql, /onboarding_step/);
  assert.match(queries[0].sql, /'language'/);
});

test("updates onboarding language and advances to budget setup", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [{ telegram_user_id: params[1], interface_language: params[0], onboarding_step: "budget_setup", onboarding_data: {} }] };
  }));

  const user = await repo.updateOnboardingLanguage(100, "ru");

  assert.equal(user.interface_language, "ru");
  assert.equal(user.onboarding_step, "budget_setup");
  assert.match(queries[0].sql, /interface_language = \$1/);
  assert.match(queries[0].sql, /onboarding_step = 'budget_setup'/);
  assert.match(queries[0].sql, /onboarding_data = '\{\}'::jsonb/);
});

test("stores temporary onboarding data as jsonb", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [{ telegram_user_id: params[1], onboarding_data: JSON.parse(params[0]) }] };
  }));

  const user = await repo.updateOnboardingData(100, { currency: "USD" });

  assert.deepEqual(user.onboarding_data, { currency: "USD" });
  assert.match(queries[0].sql, /onboarding_data = \$1::jsonb/);
  assert.equal(queries[0].params[0], JSON.stringify({ currency: "USD" }));
});

test("completes onboarding budget setup and clears temporary data", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return {
      rows: [{
        telegram_user_id: params[3],
        base_currency: params[0],
        monthly_budget_amount: params[1],
        onboarding_step: params[2],
        onboarding_data: {}
      }]
    };
  }));

  const user = await repo.completeOnboardingBudgetSetup(100, {
    baseCurrency: "USD",
    monthlyBudgetAmount: 2000,
    nextStep: "completed"
  });

  assert.equal(user.base_currency, "USD");
  assert.equal(Number(user.monthly_budget_amount), 2000);
  assert.equal(user.onboarding_step, "completed");
  assert.match(queries[0].sql, /onboarding_data = '\{\}'::jsonb/);
});

test("updates monthly budget for a Telegram user", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql, params });
    return { rows: [{ id: 1, monthly_budget_amount: "60000" }] };
  }));

  const user = await repo.updateMonthlyBudget(100, 60000);

  assert.equal(Number(user.monthly_budget_amount), 60000);
  assert.equal(queries[0].params[0], 60000);
  assert.equal(queries[0].params[1], 100);
  const event = queries.find((query) => query.sql.includes("INSERT INTO app_events"));
  assert.deepEqual(event.params, [1, "budget_changed", JSON.stringify({ source: "settings" })]);
  assert.doesNotMatch(event.params[2], /60000/);
});

test("recreates an invalidated daily snapshot from the updated monthly budget", async () => {
  let monthlyBudget = 42000;
  let storedDayBudget = 785;
  let totalsCall = 0;
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    if (query.includes("WITH existing_user AS") && query.includes("UPDATE users u")) {
      monthlyBudget = Number(params[0]);
      return { rows: [{ id: "1", telegram_user_id: "100", monthly_budget_amount: monthlyBudget, budget_changed: true }] };
    }
    if (query.includes("DELETE FROM daily_budget_snapshots")) {
      storedDayBudget = null;
      return { rows: [] };
    }
    if (query.startsWith("SELECT * FROM users")) {
      return {
        rows: [{
          id: "1",
          telegram_user_id: "100",
          monthly_budget_amount: String(monthlyBudget),
          base_currency: "THB",
          display_currency: "USD",
          usd_thb_rate: "32.65"
        }]
      };
    }
    if (query.includes("FROM monthly_budget_overrides")) return { rows: [] };
    if (query.includes("FROM daily_budget_snapshots")) {
      return storedDayBudget == null
        ? { rows: [] }
        : { rows: [{ budget_amount_base: storedDayBudget, budget_display_amount: 0 }] };
    }
    if (query.includes("INSERT INTO daily_budget_snapshots")) {
      storedDayBudget = Number(params[2]);
      return { rows: [{ budget_amount_base: params[2], budget_display_amount: params[3] }] };
    }
    if (query.includes("COALESCE(SUM(amount_base)") && query.includes("FILTER")) {
      totalsCall += 1;
      const total = totalsCall === 1 ? 383 : totalsCall === 3 ? 42811 : 383;
      return {
        rows: [{
          total,
          regular_total: total,
          planned_total: 0,
          large_oneoff_total: 0,
          display_total: 0,
          regular_display_total: 0,
          planned_display_total: 0,
          large_oneoff_display_total: 0
        }]
      };
    }
    if (query.includes("FROM planned_expenses")) {
      return {
        rows: [{
          id: "5",
          amount_base: "1977",
          recurrence: "monthly",
          due_day: 30,
          due_days: [30],
          paid_count: 0,
          paid_occurrence_dates: [],
          paid_occurrences: {}
        }]
      };
    }
    if (query.includes("planned_expense_payments")) return { rows: [] };
    if (query.includes("FROM expenses") && query.includes("ORDER BY spent_at")) return { rows: [] };
    if (query.includes("GROUP BY category_slug")) return { rows: [] };
    return { rows: [] };
  }));
  const now = new Date("2026-06-23T10:00:00+07:00");

  await repo.updateMonthlyBudget(100, 48000, now);
  const dashboard = await repo.dashboard(100, now);

  assert.equal(storedDayBudget, 449.38);
  assert.equal(dashboard.snapshot.dayPlanLimit, 449.38);
  assert.equal(dashboard.snapshot.dayRemaining, 66.38);
  assert.equal(dashboard.snapshot.safeToSpendPerDay, 401.5);
});

test("updateMonthlyBudget deletes daily_budget_snapshots for current day after user update", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [{ id: 7, monthly_budget_amount: "60000" }] };
  }));

  await repo.updateMonthlyBudget(100, 60000);

  const deleteQuery = queries.find((query) => query.sql.includes("DELETE FROM daily_budget_snapshots"));
  assert.ok(deleteQuery, "expected a DELETE FROM daily_budget_snapshots query");
  assert.match(deleteQuery.sql, /WHERE user_id = \$1 AND day_key = \$2/);
  assert.equal(deleteQuery.params[0], 7);
  assert.match(String(deleteQuery.params[1]), /^\d{4}-\d{2}-\d{2}$/);
});

test("updates user budget and display currency settings", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    queries.push({ sql: query, params });
    if (query.startsWith("SELECT * FROM users")) {
      return {
        rows: [{
          id: 7,
          telegram_user_id: "100",
          monthly_budget_amount: "45000",
          base_currency: "USD",
          budget_advice_enabled: true,
          daily_entry_reminder_enabled: true
        }]
      };
    }
    return {
      rows: [{
        id: 7,
        monthly_budget_amount: params[0],
        base_currency: params[1],
        display_currency: params[2],
        usd_thb_rate: params[3],
        weekly_budget_amount: params[4],
        interface_language: params[5],
        budget_advice_enabled: params[6],
        daily_entry_reminder_enabled: params[7],
        interface_theme: params[8],
        timezone: params[9]
      }]
    };
  }));

  const user = await repo.updateUserSettings(100, {
    monthlyBudgetAmount: 60000,
    weeklyBudgetAmount: 12000,
    baseCurrency: "THB",
    displayCurrency: "GEL",
    usdThbRate: 36.5,
    interfaceLanguage: "ru",
    budgetAdviceEnabled: false,
    interfaceTheme: "light",
    timezone: "America/New_York"
  });

  assert.equal(Number(user.monthly_budget_amount), 60000);
  assert.equal(Number(user.weekly_budget_amount), 12000);
  assert.equal(user.display_currency, "GEL");
  assert.equal(user.interface_language, "ru");
  assert.equal(user.budget_advice_enabled, false);
  assert.equal(user.interface_theme, "light");
  assert.equal(user.timezone, "America/New_York");
  assert.equal(Number(user.usd_thb_rate), 36.5);
  assert.equal(user.daily_entry_reminder_enabled, true);
  const updateQuery = queries.find((query) => query.sql.startsWith("UPDATE users"));
  assert.equal(updateQuery.params[3], 36.5);
  assert.equal(updateQuery.params[4], 12000);
  assert.equal(updateQuery.params[5], "ru");
  assert.equal(updateQuery.params[6], false);
  assert.equal(updateQuery.params[7], true);
  assert.equal(updateQuery.params[8], "light");
  assert.equal(updateQuery.params[9], "America/New_York");
  assert.equal(updateQuery.params[10], 100);
  const events = queries
    .filter((query) => query.sql.includes("INSERT INTO app_events"))
    .map((query) => [query.params[1], JSON.parse(query.params[2])]);
  assert.deepEqual(events, [
    ["currency_changed", { currency: "THB", source: "settings" }],
    ["budget_changed", { source: "settings" }]
  ]);
});

test("updateUserSettings preserves disabled budget advice when omitted", async () => {
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    if (query.startsWith("SELECT * FROM users")) {
      return { rows: [{ id: 7, telegram_user_id: "100", base_currency: "THB", budget_advice_enabled: false, daily_entry_reminder_enabled: true }] };
    }
    return { rows: [{ id: 7, budget_advice_enabled: params[6], daily_entry_reminder_enabled: params[7] }] };
  }));

  const user = await repo.updateUserSettings(100, {
    monthlyBudgetAmount: 60000,
    baseCurrency: "THB",
    displayCurrency: "USD",
    usdThbRate: 32.65,
    interfaceLanguage: "en",
    interfaceTheme: "dark"
  });

  assert.equal(user.budget_advice_enabled, false);
});

test("updateUserSettings explicitly saves budget advice boolean when included", async () => {
  for (const budgetAdviceEnabled of [true, false]) {
    const repo = createRepository(fakePool((sql, params) => {
      const query = String(sql);
      if (query.startsWith("SELECT * FROM users")) {
        return { rows: [{ id: 7, telegram_user_id: "100", base_currency: "THB", budget_advice_enabled: !budgetAdviceEnabled, daily_entry_reminder_enabled: true }] };
      }
      return { rows: [{ id: 7, budget_advice_enabled: params[6] }] };
    }));

    const user = await repo.updateUserSettings(100, {
      monthlyBudgetAmount: 60000,
      baseCurrency: "THB",
      displayCurrency: "USD",
      usdThbRate: 32.65,
      interfaceLanguage: "en",
      interfaceTheme: "dark",
      budgetAdviceEnabled
    });

    assert.equal(user.budget_advice_enabled, budgetAdviceEnabled);
  }
});

test("updateUserSettings saves disabled daily entry reminder from payload", async () => {
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    if (query.startsWith("SELECT * FROM users")) {
      return { rows: [{ id: 7, telegram_user_id: "100", base_currency: "THB", budget_advice_enabled: true, daily_entry_reminder_enabled: true }] };
    }
    return { rows: [{ id: 7, daily_entry_reminder_enabled: params[7] }] };
  }));

  const user = await repo.updateUserSettings(100, {
    monthlyBudgetAmount: 60000,
    baseCurrency: "THB",
    displayCurrency: "USD",
    usdThbRate: 32.65,
    interfaceLanguage: "en",
    interfaceTheme: "dark",
    dailyEntryReminderEnabled: false
  });

  assert.equal(user.daily_entry_reminder_enabled, false);
});

test("updateUserSettings preserves daily entry reminder when omitted", async () => {
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    if (query.startsWith("SELECT * FROM users")) {
      return { rows: [{ id: 7, telegram_user_id: "100", base_currency: "THB", budget_advice_enabled: true, daily_entry_reminder_enabled: false }] };
    }
    return { rows: [{ id: 7, daily_entry_reminder_enabled: params[7] }] };
  }));

  const user = await repo.updateUserSettings(100, {
    monthlyBudgetAmount: 60000,
    baseCurrency: "THB",
    displayCurrency: "USD",
    usdThbRate: 32.65,
    interfaceLanguage: "en",
    interfaceTheme: "dark"
  });

  assert.equal(user.daily_entry_reminder_enabled, false);
});

test("falls back to Bangkok when settings timezone is invalid", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    queries.push({ sql: query, params });
    if (query.startsWith("SELECT * FROM users")) {
      return { rows: [{ id: 7, telegram_user_id: "100", base_currency: "THB", budget_advice_enabled: true, daily_entry_reminder_enabled: true }] };
    }
    return { rows: [{ timezone: params[9] }] };
  }));

  const user = await repo.updateUserSettings(100, {
    monthlyBudgetAmount: 60000,
    weeklyBudgetAmount: "",
    baseCurrency: "THB",
    displayCurrency: "USD",
    usdThbRate: 36.5,
    interfaceLanguage: "en",
    budgetAdviceEnabled: true,
    interfaceTheme: "dark",
    timezone: "Mars/Olympus"
  });

  assert.equal(user.timezone, "Asia/Bangkok");
  const updateQuery = queries.find((query) => query.sql.startsWith("UPDATE users"));
  assert.match(updateQuery.sql, /timezone = \$10/);
});

test("updateUserSettings deletes daily_budget_snapshots for current day after settings update", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    queries.push({ sql: query, params });
    if (query.startsWith("SELECT * FROM users")) {
      return { rows: [{ id: 7, telegram_user_id: "100", base_currency: "THB", budget_advice_enabled: true, daily_entry_reminder_enabled: true }] };
    }
    if (query.startsWith("UPDATE users")) {
      return { rows: [{ id: 7, monthly_budget_amount: params[0] }] };
    }
    return { rows: [] };
  }));

  await repo.updateUserSettings(100, {
    monthlyBudgetAmount: 60000,
    baseCurrency: "THB",
    displayCurrency: "USD",
    usdThbRate: 32.65,
    interfaceLanguage: "en",
    budgetAdviceEnabled: true,
    interfaceTheme: "dark"
  });

  const deleteQuery = queries.find((query) => query.sql.includes("DELETE FROM daily_budget_snapshots"));
  assert.ok(deleteQuery, "expected a DELETE FROM daily_budget_snapshots query");
  assert.match(deleteQuery.sql, /WHERE user_id = \$1 AND day_key = \$2/);
  assert.equal(deleteQuery.params[0], 7);
  assert.match(String(deleteQuery.params[1]), /^\d{4}-\d{2}-\d{2}$/);
});

test("persists dark interface theme without normalizing it back to light", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    queries.push({ sql: query, params });
    if (query.startsWith("SELECT * FROM users")) {
      return { rows: [{ id: 7, telegram_user_id: "100", base_currency: "THB", budget_advice_enabled: true, daily_entry_reminder_enabled: true }] };
    }
    if (query.startsWith("UPDATE users")) {
      return {
        rows: [{
          monthly_budget_amount: params[0],
          base_currency: params[1],
          display_currency: params[2],
          usd_thb_rate: params[3],
          weekly_budget_amount: params[4],
          interface_language: params[5],
          budget_advice_enabled: params[6],
          daily_entry_reminder_enabled: params[7],
          interface_theme: params[8]
        }]
      };
    }
    return { rows: [] };
  }));

  const user = await repo.updateUserSettings(100, {
    monthlyBudgetAmount: 60000,
    baseCurrency: "THB",
    displayCurrency: "USD",
    usdThbRate: 32.65,
    interfaceLanguage: "en",
    budgetAdviceEnabled: true,
    interfaceTheme: "dark"
  });

  assert.equal(user.interface_theme, "dark");
  const updateQuery = queries.find((query) => query.sql.startsWith("UPDATE users"));
  assert.equal(updateQuery.params[8], "dark");
});

test("updates only the current month budget override for a Telegram user", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    if (String(sql).startsWith("SELECT * FROM users")) {
      return { rows: [{ id: "1", telegram_user_id: "100", base_currency: "THB" }] };
    }
    if (String(sql).startsWith("INSERT INTO monthly_budget_overrides")) {
      return {
        rows: [{
          user_id: params[0],
          month_key: params[1],
          budget_amount_base: params[2],
          is_partial_month: params[4]
        }]
      };
    }
    return { rows: [] };
  }));

  const override = await repo.setCurrentMonthBudget(100, {
    amount: 12000,
    currency: "THB",
    isPartialMonth: true
  }, new Date("2026-06-12T10:00:00+07:00"));

  assert.equal(Number(override.budget_amount_base), 12000);
  assert.equal(override.month_key, "2026-06");
  assert.equal(override.is_partial_month, true);
  assert.ok(!queries.some((query) => /UPDATE users\s+SET monthly_budget_amount/i.test(query.sql)));
});

test("setCurrentMonthBudget deletes daily_budget_snapshots after override upsert", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    if (String(sql).startsWith("SELECT * FROM users")) {
      return { rows: [{ id: 7, telegram_user_id: "100", base_currency: "THB" }] };
    }
    if (String(sql).startsWith("INSERT INTO monthly_budget_overrides")) {
      return { rows: [{ user_id: params[0], month_key: params[1], budget_amount_base: params[2] }] };
    }
    return { rows: [] };
  }));

  await repo.setCurrentMonthBudget(100, {
    amount: 12000,
    currency: "THB"
  }, new Date("2026-06-12T10:00:00+07:00"));

  const deleteQuery = queries.find((query) => query.sql.includes("DELETE FROM daily_budget_snapshots"));
  assert.ok(deleteQuery, "expected a DELETE FROM daily_budget_snapshots query");
  assert.match(deleteQuery.sql, /WHERE user_id = \$1 AND day_key = \$2/);
  assert.equal(deleteQuery.params[0], 7);
  assert.equal(deleteQuery.params[1], "2026-06-12");
});

test("checks database health", async () => {
  const repo = createRepository(fakePool((sql) => {
    assert.match(sql, /SELECT 1 AS ok/);
    return { rows: [{ ok: 1 }] };
  }));

  assert.deepEqual(await repo.health(), { db: true });
});

test("creates a release note with audience and category", async () => {
  const repo = createRepository(fakePool((sql, params) => {
    assert.match(String(sql), /INSERT INTO release_notes/);
    assert.equal(params[0], "v.1.18");
    assert.equal(params[1], "user");
    assert.equal(params[2], "onboarding");
    assert.equal(params[3], "Онбординг");
    assert.equal(params[4], "Onboarding");
    assert.equal(params[5], "Стало проще.");
    assert.equal(params[6], "Simpler.");
    assert.equal(params[7], true);
    return {
      rows: [{
        id: "1",
        version: params[0],
        audience: params[1],
        category: params[2],
        title_ru: params[3],
        title_en: params[4],
        body_ru: params[5],
        body_en: params[6],
        is_public: params[7]
      }]
    };
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
  assert.equal(note.category, "onboarding");
});

test("release digest persistence schema includes source metadata and run constraints", async () => {
  const migration = await readFile(
    new URL("../migrations/001_initial.sql", import.meta.url),
    "utf8"
  );

  assert.match(migration, /ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS source_type TEXT/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS source_id TEXT/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS release_notes_source_unique/);
  assert.match(migration, /ON release_notes \(source_type, source_id, audience\)/);
  assert.match(migration, /ROW_NUMBER\(\) OVER \(\s*PARTITION BY version/);
  assert.match(migration, /UPDATE release_notes\s+SET version = 'v\.1\.' \|\| next_patch/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS release_notes_public_version_unique/);
  assert.match(migration, /ON release_notes \(version\)/);
  assert.match(migration, /WHERE audience = 'user' AND is_public = true/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS release_digest_runs/);
  assert.match(migration, /CHECK \(status IN \('running', 'success', 'failed', 'skipped'\)\)/);
  assert.match(migration, /CHECK \(trigger IN \('auto', 'manual', 'preview', 'test'\)\)/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS release_digest_runs_auto_date_unique/);
  assert.match(migration, /WHERE trigger = 'auto' AND status IN \('success', 'skipped', 'running'\)/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS release_digest_runs_single_running_unique/);
  assert.match(migration, /ON release_digest_runs \(\(1\)\) WHERE status = 'running'/);
  assert.match(migration, /skipped_count INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /ALTER TABLE release_digest_runs\s+ADD COLUMN IF NOT EXISTS skipped_count INTEGER NOT NULL DEFAULT 0/);
});

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
  assert.match(queries[0].sql, /DO UPDATE SET source_id = EXCLUDED\.source_id/);
  assert.deepEqual(queries[0].params.slice(-2), ["github_pr", "42"]);
});

test("exposes release note insert database errors unchanged", async () => {
  const databaseError = Object.assign(new Error("duplicate public version"), {
    code: "23505",
    constraint: "release_notes_public_version_unique"
  });
  const repo = createRepository(fakePool(() => {
    throw databaseError;
  }));

  await assert.rejects(
    repo.createReleaseNoteFromSource({
      version: "v.1.19",
      audience: "user",
      category: "history",
      titleRu: "Update",
      titleEn: "Update",
      bodyRu: "Improvement.",
      bodyEn: "Improvement.",
      isPublic: true,
      sourceType: "github_pr",
      sourceId: "42"
    }),
    (error) => error === databaseError
  );
});

test("returns the latest public release version", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [{ version: "v.1.21" }] };
  }));

  assert.equal(await repo.getLatestPublicReleaseVersion(), "v.1.21");
  assert.match(queries[0].sql, /audience = 'user'/);
  assert.match(queries[0].sql, /is_public = true/);
  assert.match(queries[0].sql, /version ~ '\^v\\\.1\\\.\[0-9\]\+\$'/);
  assert.match(queries[0].sql, /split_part\(version, '\.', 3\)::numeric DESC/);
  assert.doesNotMatch(queries[0].sql, /::integer/);
  assert.deepEqual(queries[0].params, []);
});

test("returns null when no public release version exists", async () => {
  const repo = createRepository(fakePool(() => ({ rows: [] })));

  assert.equal(await repo.getLatestPublicReleaseVersion(), null);
});

test("lists unsent public notes including older carry-over", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [{ id: "1", audience: "user" }] };
  }));
  const since = new Date("2026-06-17T14:00:00Z");
  const until = new Date("2026-06-19T14:00:00Z");

  await repo.getUnsentPublicReleaseNotesSince(since, until);

  assert.match(queries[0].sql, /sent_at IS NULL/);
  assert.match(queries[0].sql, /created_at <= \$1/);
  assert.doesNotMatch(queries[0].sql, /created_at > \$2/);
  assert.match(queries[0].sql, /is_public = true/);
  assert.match(queries[0].sql, /audience = 'user'/);
  assert.deepEqual(queries[0].params, [until]);
});

test("lists hidden release notes inside the requested range", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [{ id: "2", audience: "internal" }] };
  }));
  const since = new Date("2026-06-17T14:00:00Z");
  const until = new Date("2026-06-19T14:00:00Z");

  const notes = await repo.getHiddenReleaseNotesSince(since, until);

  assert.equal(notes[0].audience, "internal");
  assert.match(queries[0].sql, /created_at > COALESCE\(\$1, '-infinity'::timestamptz\)/);
  assert.match(queries[0].sql, /created_at <= \$2/);
  assert.match(queries[0].sql, /audience IN \('admin', 'internal'\)/);
  assert.deepEqual(queries[0].params, [since, until]);
});

test("returns the last successful release digest run", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [{ id: "8", status: "success" }] };
  }));

  const run = await repo.getLastSuccessfulReleaseDigestRun();

  assert.equal(run.id, "8");
  assert.match(queries[0].sql, /status = 'success'/);
  assert.match(queries[0].sql, /ORDER BY sent_to DESC, id DESC/);
  assert.deepEqual(queries[0].params, []);
});

test("finds an automatic release digest run for a local date", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [{ id: "9", status: "running" }] };
  }));

  const run = await repo.getReleaseDigestRunForLocalDate("2026-06-19", "Asia/Bangkok");

  assert.equal(run.id, "9");
  assert.match(queries[0].sql, /trigger = 'auto'/);
  assert.match(queries[0].sql, /status IN \('running', 'success', 'skipped'\)/);
  assert.deepEqual(queries[0].params, ["2026-06-19", "Asia/Bangkok"]);
});

test("records release digest run lifecycle", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    if (/INSERT INTO release_digest_runs/.test(String(sql))) return { rows: [{ id: "9" }] };
    return { rows: [] };
  }));
  const sentTo = new Date("2026-06-19T14:00:00Z");

  const run = await repo.createReleaseDigestRun({
    trigger: "auto",
    sentFrom: null,
    sentTo,
    digestLocalDate: "2026-06-19",
    timezone: "Asia/Bangkok"
  });
  await repo.markReleaseDigestRunSuccess(run.id, {
    versionFrom: "v.1.19",
    versionTo: "v.1.20",
    users: 3,
    success: 3,
    errors: 0,
    skipped: 0,
    blocked: 0
  });
  await repo.markReleaseDigestRunFailed(run.id, new Error("Telegram unavailable"), {
    users: 3,
    success: 1,
    errors: 2,
    skipped: 4,
    blocked: 1
  });
  await repo.markReleaseDigestRunSkipped(run.id, "no_public_release_notes");

  assert.match(queries[0].sql, /WITH recovered AS/);
  assert.match(queries[0].sql, /UPDATE release_digest_runs/);
  assert.match(queries[0].sql, /status = 'running'/);
  assert.match(queries[0].sql, /started_at < now\(\) - interval '2 hours'/);
  assert.match(queries[0].sql, /error_message = 'stale_running_run_recovered'/);
  assert.match(queries[0].sql, /INSERT INTO release_digest_runs/);
  assert.deepEqual(queries[0].params, ["auto", null, sentTo, "2026-06-19", "Asia/Bangkok"]);
  assert.match(queries[1].sql, /status = 'success'/);
  assert.match(queries[1].sql, /skipped_count = \$7/);
  assert.deepEqual(queries[1].params, ["9", "v.1.19", "v.1.20", 3, 3, 0, 0, 0]);
  assert.match(queries[2].sql, /status = 'failed'/);
  assert.match(queries[2].sql, /skipped_count = \$5/);
  assert.deepEqual(queries[2].params, ["9", 3, 1, 2, 4, 1, "Telegram unavailable"]);
  assert.match(queries[3].sql, /status = 'skipped'/);
  assert.deepEqual(queries[3].params, ["9", "no_public_release_notes"]);
});

test("stale running recovery and new run insert share one atomic query", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [{ id: "10", status: "running" }] };
  }));

  const run = await repo.createReleaseDigestRun({
    trigger: "manual",
    sentFrom: null,
    sentTo: new Date("2026-06-19T16:00:00Z"),
    digestLocalDate: "2026-06-19",
    timezone: "Asia/Bangkok"
  });

  assert.equal(run.id, "10");
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /WITH recovered AS \(\s*UPDATE release_digest_runs/);
  assert.match(queries[0].sql, /status = 'failed'/);
  assert.match(queries[0].sql, /finished_at = now\(\)/);
  assert.match(queries[0].sql, /error_message = 'stale_running_run_recovered'/);
  assert.match(queries[0].sql, /started_at < now\(\) - interval '2 hours'/);
  assert.match(queries[0].sql, /INSERT INTO release_digest_runs/);
});

test("duplicate automatic release digest run returns null", async () => {
  const duplicate = Object.assign(new Error("duplicate"), {
    code: "23505",
    constraint: "release_digest_runs_auto_date_unique"
  });
  const repo = createRepository(fakePool(() => {
    throw duplicate;
  }));

  const run = await repo.createReleaseDigestRun({
    trigger: "auto",
    sentFrom: null,
    sentTo: new Date("2026-06-19T14:00:00Z"),
    digestLocalDate: "2026-06-19",
    timezone: "Asia/Bangkok"
  });

  assert.equal(run, null);
});

test("concurrent running release digest run returns null", async () => {
  const duplicate = Object.assign(new Error("duplicate"), {
    code: "23505",
    constraint: "release_digest_runs_single_running_unique"
  });
  const repo = createRepository(fakePool(() => {
    throw duplicate;
  }));

  const run = await repo.createReleaseDigestRun({
    trigger: "manual",
    sentFrom: null,
    sentTo: new Date("2026-06-19T14:00:00Z"),
    digestLocalDate: "2026-06-19",
    timezone: "Asia/Bangkok"
  });

  assert.equal(run, null);
});

test("unrelated automatic release digest unique violation is not swallowed", async () => {
  const duplicate = Object.assign(new Error("duplicate"), {
    code: "23505",
    constraint: "other_unique_constraint"
  });
  const repo = createRepository(fakePool(() => {
    throw duplicate;
  }));

  await assert.rejects(
    repo.createReleaseDigestRun({
      trigger: "auto",
      sentFrom: null,
      sentTo: new Date("2026-06-19T14:00:00Z"),
      digestLocalDate: "2026-06-19",
      timezone: "Asia/Bangkok"
    }),
    duplicate
  );
});

test("duplicate manual release digest run error is not swallowed", async () => {
  const duplicate = Object.assign(new Error("duplicate"), { code: "23505" });
  const repo = createRepository(fakePool(() => {
    throw duplicate;
  }));

  await assert.rejects(
    repo.createReleaseDigestRun({
      trigger: "manual",
      sentFrom: null,
      sentTo: new Date("2026-06-19T14:00:00Z"),
      digestLocalDate: "2026-06-19",
      timezone: "Asia/Bangkok"
    }),
    duplicate
  );
});

test("lists today's unsent public user release notes only", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [{ id: "1", version: "v.1.18", audience: "user" }] };
  }));

  const notes = await repo.getTodayUnsentPublicReleaseNotes(new Date("2026-06-15T18:00:00+07:00"));

  assert.equal(notes[0].audience, "user");
  assert.match(queries[0].sql, /audience = 'user'/);
  assert.match(queries[0].sql, /is_public = true/);
  assert.match(queries[0].sql, /sent_at IS NULL/i);
  assert.equal(queries[0].params[0].toISOString(), "2026-06-14T17:00:00.000Z");
  assert.equal(queries[0].params[1].toISOString(), "2026-06-15T17:00:00.000Z");
});

test("lists today's hidden release notes for preview", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql) => {
    queries.push(String(sql));
    return { rows: [{ id: "2", audience: "admin", title_ru: "добавлена /admin_stats" }] };
  }));

  const notes = await repo.getTodayHiddenReleaseNotes(new Date("2026-06-15T18:00:00+07:00"));

  assert.equal(notes[0].audience, "admin");
  assert.match(queries[0], /audience IN \('admin', 'internal'\)/);
});

test("lists active users for release push", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql) => {
    queries.push(String(sql));
    return { rows: [{ id: "1", telegram_user_id: "100", interface_language: "ru" }] };
  }));

  const users = await repo.getActiveUsersForReleasePush();

  assert.equal(users[0].telegram_user_id, "100");
  assert.match(queries[0], /telegram_user_id IS NOT NULL/);
  assert.match(queries[0], /onboarding_step = 'completed'/);
  assert.match(queries[0], /bot_blocked = false/);
});

test("records release note deliveries and sent markers", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    if (String(sql).startsWith("SELECT 1 FROM release_note_deliveries")) return { rows: [{ exists: 1 }] };
    return { rows: [] };
  }));

  assert.equal(await repo.hasReleaseNoteDelivery(1, 2), true);
  await repo.markReleaseNoteDelivered(1, 2);
  await repo.markReleaseNoteSent(1);

  assert.match(queries[0].sql, /SELECT 1 FROM release_note_deliveries/);
  assert.deepEqual(queries[0].params, [1, 2]);
  assert.match(queries[1].sql, /INSERT INTO release_note_deliveries/);
  assert.match(queries[2].sql, /UPDATE release_notes SET sent_at = now\(\)/);
});

test("records multiple release note deliveries atomically", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [] };
  }));

  await repo.markReleaseNotesDelivered([1, 2, 3], 7);

  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /INSERT INTO release_note_deliveries/);
  assert.match(queries[0].sql, /SELECT release_note_id, \$2/);
  assert.match(queries[0].sql, /unnest\(\$1::bigint\[\]\)/);
  assert.match(queries[0].sql, /ON CONFLICT DO NOTHING/);
  assert.deepEqual(queries[0].params, [[1, 2, 3], 7]);
});

test("counts active users missing a release note delivery", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [{ count: 2 }] };
  }));

  const count = await repo.countMissingReleaseNoteDeliveries(7);

  assert.equal(count, 2);
  assert.match(queries[0].sql, /FROM users u/);
  assert.match(queries[0].sql, /u\.telegram_user_id IS NOT NULL/);
  assert.match(queries[0].sql, /u\.onboarding_step = 'completed'/);
  assert.match(queries[0].sql, /u\.bot_blocked = false/);
  assert.match(queries[0].sql, /NOT EXISTS/);
  assert.match(queries[0].sql, /d\.release_note_id = \$1 AND d\.user_id = u\.id/);
  assert.deepEqual(queries[0].params, [7]);
});

test("records blocked and unblocked events only for real state transitions", async () => {
  const queries = [];
  let transitions = 0;
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    if (String(sql).includes("UPDATE users")) {
      transitions += 1;
      return { rows: transitions === 1 ? [{ id: 1 }] : [] };
    }
    return { rows: [] };
  }));

  assert.deepEqual(await repo.setUserBotBlocked(1, { blocked: true, source: "telegram_status", now: new Date("2026-07-10T10:00:00Z") }), { changed: true });
  assert.deepEqual(await repo.setUserBotBlocked(1, { blocked: true, source: "telegram_status", now: new Date("2026-07-10T10:01:00Z") }), { changed: false });

  assert.match(queries[0].sql, /bot_blocked IS DISTINCT FROM/);
  assert.match(queries[0].sql, /bot_blocked_at/);
  assert.deepEqual(queries[0].params, [1, true, new Date("2026-07-10T10:00:00Z")]);
  assert.deepEqual(queries[1].params, [1, "bot_blocked", JSON.stringify({ source: "telegram_status" })]);
  assert.equal(queries.filter((query) => query.sql.includes("INSERT INTO app_events")).length, 1);
});

test("saving the same monthly budget does not record meaningful activity", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [{ id: 1, monthly_budget_amount: "60000", budget_changed: false }] };
  }));

  const user = await repo.updateMonthlyBudget(100, 60000);

  assert.equal(Number(user.monthly_budget_amount), 60000);
  assert.match(queries[0].sql, /existing_user AS/);
  assert.match(queries[0].sql, /IS DISTINCT FROM/);
  assert.equal(queries.some((query) => query.sql.includes("INSERT INTO app_events")), false);
  assert.equal(queries.some((query) => query.sql.includes("DELETE FROM daily_budget_snapshots")), false);
});

test("clears blocked state by Telegram id without creating unknown users", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    if (String(sql).includes("UPDATE users")) return { rows: [{ id: 7 }] };
    return { rows: [] };
  }));

  assert.deepEqual(await repo.clearTelegramUserBotBlocked(100, { source: "incoming_message", now: new Date("2026-07-10T10:00:00Z") }), { changed: true });

  assert.match(queries[0].sql, /telegram_user_id = \$1/);
  assert.deepEqual(queries[0].params, [100, new Date("2026-07-10T10:00:00Z")]);
  assert.deepEqual(queries[1].params, [7, "bot_unblocked", JSON.stringify({ source: "incoming_message" })]);
});

test("records app events with json metadata", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [] };
  }));

  await repo.recordAppEvent(1, "timezone_missing", { timezoneUsed: "Asia/Bangkok" });

  assert.match(queries[0].sql, /INSERT INTO app_events/);
  assert.deepEqual(queries[0].params, [1, "timezone_missing", JSON.stringify({ timezoneUsed: "Asia/Bangkok" })]);
});

test("records no-spending marks and reminder deliveries idempotently", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    if (String(sql).startsWith("SELECT 1 FROM no_spending_marks")) return { rows: [] };
    if (String(sql).startsWith("SELECT 1 FROM daily_reminder_deliveries")) return { rows: [{ exists: 1 }] };
    if (String(sql).startsWith("INSERT INTO daily_reminder_deliveries")) {
      return { rows: [{ id: 10, status: params[4] }] };
    }
    return { rows: [] };
  }));

  assert.equal(await repo.hasNoSpendingMark(1, "2026-06-25"), false);
  await repo.createNoSpendingMark(1, "2026-06-25", "Asia/Bangkok");
  assert.equal(await repo.hasDailyReminderDelivery(1, "2026-06-25", "daily_empty_day"), true);
  const delivery = await repo.recordDailyReminderDelivery({
    userId: 1,
    localDate: "2026-06-25",
    timezoneUsed: "Asia/Bangkok",
    reminderType: "daily_empty_day",
    status: "sent",
    sentAt: new Date("2026-06-25T15:00:00Z")
  });

  assert.match(queries[1].sql, /INSERT INTO no_spending_marks/);
  assert.match(queries[3].sql, /INSERT INTO daily_reminder_deliveries/);
  assert.equal(delivery.status, "sent");
});

test("lists reminder candidates excluding blocked and onboarding users", async () => {
  const repo = createRepository(fakePool((sql) => {
    assert.match(String(sql), /daily_entry_reminder_enabled = true/);
    assert.match(String(sql), /bot_blocked = false/);
    assert.match(String(sql), /onboarding_step = 'completed'/);
    return { rows: [{ id: 1, telegram_user_id: 100, timezone: "Asia/Bangkok" }] };
  }));

  const users = await repo.listDailyReminderCandidates();

  assert.equal(users[0].id, 1);
});

test("creates report deliveries idempotently with JSON metadata", async () => {
  const generatedAt = new Date("2026-07-06T09:00:00Z");
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [{ id: 10, status: params[6], metadata: JSON.parse(params[11]) }] };
  }));

  const delivery = await repo.createReportDelivery({
    userId: 1,
    reportType: "weekly",
    periodKey: "2026-W27",
    periodStartUtc: new Date("2026-06-29T00:00:00Z"),
    periodEndUtc: new Date("2026-07-06T00:00:00Z"),
    timezoneUsed: "UTC",
    status: "pending",
    generatedAt,
    metadata: { total_spent: 100 }
  });

  assert.equal(delivery.status, "pending");
  assert.deepEqual(delivery.metadata, { total_spent: 100 });
  assert.match(queries[0].sql, /INSERT INTO report_deliveries/);
  assert.match(queries[0].sql, /ON CONFLICT \(user_id, report_type, period_key\) DO NOTHING/);
  assert.deepEqual(queries[0].params, [
    1,
    "weekly",
    "2026-W27",
    new Date("2026-06-29T00:00:00Z"),
    new Date("2026-07-06T00:00:00Z"),
    "UTC",
    "pending",
    generatedAt,
    null,
    null,
    null,
    JSON.stringify({ total_spent: 100 })
  ]);
});

test("claims report delivery by inserting or updating retryable rows to pending", async () => {
  const generatedAt = new Date("2026-07-06T09:00:00Z");
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [{ id: 10, status: "pending", metadata: JSON.parse(params[7]) }] };
  }));

  const delivery = await repo.claimReportDelivery({
    userId: 1,
    reportType: "weekly",
    periodKey: "2026-W27",
    periodStartUtc: new Date("2026-06-29T00:00:00Z"),
    periodEndUtc: new Date("2026-07-06T00:00:00Z"),
    timezoneUsed: "UTC",
    generatedAt,
    force: false,
    metadata: { total_spent: 100 }
  });

  assert.equal(delivery.status, "pending");
  assert.deepEqual(delivery.metadata, { total_spent: 100 });
  assert.match(queries[0].sql, /INSERT INTO report_deliveries/);
  assert.match(queries[0].sql, /ON CONFLICT \(user_id, report_type, period_key\) DO UPDATE/);
  assert.match(queries[0].sql, /WHERE report_deliveries.status = 'failed' OR \$9 = true/);
  assert.equal(queries[0].params[8], false);
});

test("force claim can update any existing report delivery to pending", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [{ id: 11, status: "pending" }] };
  }));

  await repo.claimReportDelivery({
    userId: 1,
    reportType: "weekly",
    periodKey: "2026-W27",
    periodStartUtc: new Date("2026-06-29T00:00:00Z"),
    periodEndUtc: new Date("2026-07-06T00:00:00Z"),
    timezoneUsed: "UTC",
    generatedAt: new Date("2026-07-06T09:00:00Z"),
    force: true,
    metadata: {}
  });

  assert.match(queries[0].sql, /WHERE report_deliveries.status = 'failed' OR \$9 = true/);
  assert.equal(queries[0].params[8], true);
});

test("updates report deliveries as sent failed and skipped", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [{ id: 10 }] };
  }));

  await repo.markReportDeliverySent({
    userId: 1,
    reportType: "weekly",
    periodKey: "2026-W27",
    telegramMessageId: 222,
    sentAt: new Date("2026-07-06T09:01:00Z"),
    metadata: { total_spent: 100 }
  });
  await repo.markReportDeliveryFailed({
    userId: 1,
    reportType: "weekly",
    periodKey: "2026-W27",
    errorCode: "403",
    errorMessage: "Forbidden",
    metadata: { blocked: true }
  });
  await repo.markReportDeliverySkipped({
    userId: 1,
    reportType: "monthly",
    periodKey: "2026-06",
    skipReason: "no_activity",
    metadata: { checked: true }
  });

  assert.match(queries[0].sql, /UPDATE report_deliveries/);
  assert.match(queries[0].sql, /status = 'sent'/);
  assert.match(queries[0].sql, /telegram_message_id = \$4/);
  assert.deepEqual(queries[0].params, [1, "weekly", "2026-W27", 222, new Date("2026-07-06T09:01:00Z"), JSON.stringify({ total_spent: 100 })]);
  assert.match(queries[1].sql, /status = 'failed'/);
  assert.deepEqual(queries[1].params, [1, "weekly", "2026-W27", "403", "Forbidden", JSON.stringify({ blocked: true })]);
  assert.match(queries[2].sql, /status = 'skipped'/);
  assert.deepEqual(queries[2].params, [1, "monthly", "2026-06", "no_activity", JSON.stringify({ checked: true })]);
});

test("builds report data with paid actual planned amount and unpaid planned occurrences", async () => {
  const queries = [];
  const user = {
    id: 1,
    telegram_user_id: 100,
    monthly_budget_amount: 50000,
    base_currency: "THB",
    display_currency: "THB",
    timezone: "Asia/Bangkok",
    interface_language: "en"
  };
  const repo = createRepository(fakePool((sql) => {
    const query = String(sql);
    queries.push(query);
    if (query.includes("FROM expenses") && query.includes("ORDER BY spent_at ASC")) {
      return {
        rows: [
          {
            id: "10",
            amount_base: 450,
            converted_amounts: { THB: 450 },
            description: "Internet actual",
            category_slug: "utilities",
            budget_impact: "planned",
            spent_at: new Date("2026-06-05T05:00:00Z"),
            local_date: "2026-06-05"
          }
        ]
      };
    }
    if (query.includes("FROM planned_expenses") && query.includes("JOIN users")) {
      return {
        rows: [{
          id: "7",
          description: "Internet",
          amount_base: 1200,
          recurrence: "twice_monthly",
          due_day: 5,
          due_days: [5, 20],
          timezone: "Asia/Bangkok",
          paid_count: 1,
          paid_occurrence_dates: ["2026-06-05"],
          paid_occurrences: { "2026-06-05": { expense_id: "10" } }
        }]
      };
    }
    if (query.includes("FROM planned_expense_payments") && query.includes("JOIN planned_expenses")) {
      return {
        rows: [{
          expense_id: "10",
          name: "Internet",
          planned_amount_base: 1200,
          amount_base: 450,
          occurrence_date: "2026-06-05",
          local_date: "2026-06-05"
        }]
      };
    }
    if (query.includes("FROM budget_topups") && query.includes("occurred_at")) return { rows: [] };
    if (query.includes("GROUP BY category_slug")) return { rows: [{ category_slug: "utilities", total: 450 }] };
    if (query === "SELECT timezone FROM users WHERE telegram_user_id = $1") return { rows: [{ timezone: "Asia/Bangkok" }] };
    if (query.includes("FROM monthly_budget_overrides")) return { rows: [] };
    if (query.includes("COALESCE(SUM(amount_base)") && query.includes("month_key")) return { rows: [{ total: 0 }] };
    if (query.includes("FROM budget_topups") && query.includes("month_key")) return { rows: [] };
    if (query.includes("FROM month_baselines")) return { rows: [] };
    return { rows: [] };
  }));

  const report = await repo.buildReportDataForDelivery(user, "monthly", {
    periodKey: "2026-06",
    periodStartUtc: new Date("2026-05-31T17:00:00Z"),
    periodEndUtc: new Date("2026-06-30T17:00:00Z"),
    timezoneUsed: "Asia/Bangkok",
    localStartDate: "2026-06-01",
    localEndDate: "2026-06-30"
  }, new Date("2026-07-01T03:00:00Z"));

  assert.equal(report.metrics.totalSpent, 450);
  assert.equal(report.metrics.plannedPaidTotal, 450);
  assert.deepEqual(report.plannedPayments.map((payment) => ({
    name: payment.name,
    amount: payment.amount,
    paid: payment.paid,
    dueDate: payment.dueDate
  })), [
    { name: "Internet", amount: 450, paid: true, dueDate: "2026-06-05" },
    { name: "Internet", amount: 1200, paid: false, dueDate: "2026-06-20" }
  ]);
  const paidFactsQuery = queries.find((query) => query.includes("FROM planned_expense_payments") && query.includes("JOIN planned_expenses"));
  assert.ok(paidFactsQuery);
  assert.doesNotMatch(paidFactsQuery, /planned_expenses\.active = true/);
});

test("report excludes unpaid weekly occurrences before starts_on", async () => {
  const user = {
    id: 1,
    telegram_user_id: 100,
    monthly_budget_amount: 50000,
    base_currency: "THB",
    display_currency: "THB",
    timezone: "America/New_York",
    interface_language: "en"
  };
  const repo = createRepository(fakePool((sql) => {
    const query = String(sql);
    if (query.includes("FROM expenses") && query.includes("ORDER BY spent_at ASC")) return { rows: [] };
    if (query.includes("FROM planned_expenses") && query.includes("JOIN users")) {
      return {
        rows: [{
          id: "7",
          description: "weekly class",
          amount_base: 1000,
          recurrence: "weekly",
          weekday: 3,
          starts_on: "2026-07-23",
          timezone: "America/New_York",
          paid_count: 0,
          paid_occurrence_dates: [],
          paid_occurrences: {}
        }]
      };
    }
    if (query.includes("FROM planned_expense_payments") && query.includes("JOIN planned_expenses")) return { rows: [] };
    if (query.includes("FROM budget_topups") && query.includes("occurred_at")) return { rows: [] };
    if (query.includes("GROUP BY category_slug")) return { rows: [] };
    if (query === "SELECT timezone FROM users WHERE telegram_user_id = $1") return { rows: [{ timezone: user.timezone }] };
    if (query.includes("FROM monthly_budget_overrides")) return { rows: [] };
    if (query.includes("COALESCE(SUM(amount_base)") && query.includes("month_key")) return { rows: [{ total: 0 }] };
    if (query.includes("FROM budget_topups") && query.includes("month_key")) return { rows: [] };
    if (query.includes("FROM month_baselines")) return { rows: [] };
    return { rows: [] };
  }));

  const report = await repo.buildReportDataForDelivery(user, "monthly", {
    periodKey: "2026-07",
    periodStartUtc: new Date("2026-07-01T04:00:00Z"),
    periodEndUtc: new Date("2026-08-01T04:00:00Z"),
    timezoneUsed: user.timezone,
    localStartDate: "2026-07-01",
    localEndDate: "2026-07-31"
  }, new Date("2026-08-01T05:00:00Z"));

  assert.deepEqual(report.plannedPayments.map((payment) => payment.dueDate), ["2026-07-29"]);
});

test("report data includes display equivalents for budget amount and remaining", async () => {
  const user = {
    id: 1,
    telegram_user_id: 100,
    monthly_budget_amount: 50000,
    base_currency: "THB",
    display_currency: "USD",
    usd_thb_rate: 40,
    timezone: "Asia/Bangkok",
    interface_language: "en"
  };
  const repo = createRepository(fakePool((sql) => {
    const query = String(sql);
    if (query.includes("FROM expenses") && query.includes("ORDER BY spent_at ASC")) {
      return {
        rows: [{
          id: "10",
          amount_base: 48000,
          converted_amounts: { USD: 1200 },
          description: "month spend",
          category_slug: "other",
          budget_impact: "regular",
          spent_at: new Date("2026-06-15T05:00:00Z"),
          local_date: "2026-06-15"
        }]
      };
    }
    if (query.includes("FROM planned_expenses") && query.includes("JOIN users")) return { rows: [] };
    if (query.includes("FROM planned_expense_payments") && query.includes("JOIN planned_expenses")) return { rows: [] };
    if (query.includes("FROM budget_topups") && query.includes("occurred_at")) return { rows: [] };
    if (query.includes("GROUP BY category_slug")) return { rows: [] };
    if (query === "SELECT timezone FROM users WHERE telegram_user_id = $1") return { rows: [{ timezone: "Asia/Bangkok" }] };
    if (query.includes("FROM monthly_budget_overrides")) return { rows: [] };
    if (query.includes("COALESCE(SUM(amount_base)") && query.includes("month_key")) return { rows: [{ total: 0 }] };
    if (query.includes("FROM budget_topups") && query.includes("month_key")) return { rows: [] };
    if (query.includes("FROM month_baselines")) return { rows: [] };
    return { rows: [] };
  }));

  const report = await repo.buildReportDataForDelivery(user, "monthly", {
    periodKey: "2026-06",
    periodStartUtc: new Date("2026-05-31T17:00:00Z"),
    periodEndUtc: new Date("2026-06-30T17:00:00Z"),
    timezoneUsed: "Asia/Bangkok",
    localStartDate: "2026-06-01",
    localEndDate: "2026-06-30"
  }, new Date("2026-07-01T03:00:00Z"));

  assert.deepEqual(report.budget.display, {
    currency: "USD",
    amount: 1250,
    baseBudget: 1250,
    topupsTotal: 0,
    remaining: 50
  });
});

test("report notable expenses include regular one-offs above threshold and exclude paid planned expenses", async () => {
  const user = {
    id: 1,
    telegram_user_id: 100,
    monthly_budget_amount: 50000,
    base_currency: "THB",
    display_currency: "THB",
    timezone: "Asia/Bangkok",
    interface_language: "en"
  };
  const repo = createRepository(fakePool((sql) => {
    const query = String(sql);
    if (query.includes("FROM expenses") && query.includes("ORDER BY spent_at ASC")) {
      return {
        rows: [
          {
            id: "10",
            amount_base: 7000,
            converted_amounts: { THB: 7000 },
            description: "Rent",
            category_slug: "home",
            budget_impact: "planned",
            spent_at: new Date("2026-06-01T05:00:00Z"),
            local_date: "2026-06-01"
          },
          {
            id: "11",
            amount_base: 6200,
            converted_amounts: { THB: 6200 },
            description: "New chair",
            category_slug: "home",
            budget_impact: "regular",
            spent_at: new Date("2026-06-11T05:00:00Z"),
            local_date: "2026-06-11"
          },
          {
            id: "12",
            amount_base: 2500,
            converted_amounts: { THB: 2500 },
            description: "Dentist",
            category_slug: "health",
            budget_impact: "large_oneoff",
            spent_at: new Date("2026-06-12T05:00:00Z"),
            local_date: "2026-06-12"
          },
          {
            id: "13",
            amount_base: 2100,
            converted_amounts: { THB: 2100 },
            description: "Shoes",
            category_slug: "clothes",
            budget_impact: "regular",
            spent_at: new Date("2026-06-13T05:00:00Z"),
            local_date: "2026-06-13"
          }
        ]
      };
    }
    if (query.includes("FROM planned_expenses") && query.includes("JOIN users")) return { rows: [] };
    if (query.includes("FROM planned_expense_payments") && query.includes("JOIN planned_expenses")) {
      return {
        rows: [{
          expense_id: "10",
          name: "Rent",
          planned_amount_base: 7000,
          amount_base: 7000,
          occurrence_date: "2026-06-01",
          local_date: "2026-06-01"
        }]
      };
    }
    if (query.includes("FROM budget_topups") && query.includes("occurred_at")) return { rows: [] };
    if (query.includes("GROUP BY category_slug")) return { rows: [] };
    if (query === "SELECT timezone FROM users WHERE telegram_user_id = $1") return { rows: [{ timezone: "Asia/Bangkok" }] };
    if (query.includes("FROM monthly_budget_overrides")) return { rows: [] };
    if (query.includes("COALESCE(SUM(amount_base)") && query.includes("month_key")) return { rows: [{ total: 0 }] };
    if (query.includes("FROM budget_topups") && query.includes("month_key")) return { rows: [] };
    if (query.includes("FROM month_baselines")) return { rows: [] };
    return { rows: [] };
  }));

  const report = await repo.buildReportDataForDelivery(user, "monthly", {
    periodKey: "2026-06",
    periodStartUtc: new Date("2026-05-31T17:00:00Z"),
    periodEndUtc: new Date("2026-06-30T17:00:00Z"),
    timezoneUsed: "Asia/Bangkok",
    localStartDate: "2026-06-01",
    localEndDate: "2026-06-30"
  }, new Date("2026-07-01T03:00:00Z"));

  assert.deepEqual(report.largeExpenses.map((expense) => expense.name), ["New chair", "Dentist"]);
  assert.deepEqual(report.largeExpenses.map((expense) => expense.amount), [6200, 2500]);
  assert.equal(report.largeExpensesTotal, 8700);
  assert.equal(report.largeExpensesCount, 2);
  assert.equal(report.metrics.largeTotal, 8700);
});

test("weekly report data includes unpaid planned occurrences from previous month when week crosses month boundary", async () => {
  const user = {
    id: 1,
    telegram_user_id: 100,
    monthly_budget_amount: 50000,
    base_currency: "THB",
    display_currency: "THB",
    timezone: "Asia/Bangkok",
    interface_language: "en"
  };
  const repo = createRepository(fakePool((sql) => {
    const query = String(sql);
    if (query.includes("FROM expenses") && query.includes("ORDER BY spent_at ASC")) return { rows: [] };
    if (query.includes("FROM planned_expenses") && query.includes("JOIN users")) {
      return {
        rows: [{
          id: "8",
          description: "June insurance",
          amount_base: 2200,
          recurrence: "one_off",
          due_date: "2026-06-30",
          timezone: "Asia/Bangkok",
          paid_count: 0,
          paid_occurrence_dates: [],
          paid_occurrences: {}
        }]
      };
    }
    if (query.includes("FROM planned_expense_payments") && query.includes("JOIN planned_expenses")) return { rows: [] };
    if (query.includes("FROM budget_topups") && query.includes("occurred_at")) return { rows: [] };
    if (query.includes("GROUP BY category_slug")) return { rows: [] };
    if (query === "SELECT timezone FROM users WHERE telegram_user_id = $1") return { rows: [{ timezone: "Asia/Bangkok" }] };
    if (query.includes("FROM monthly_budget_overrides")) return { rows: [] };
    if (query.includes("COALESCE(SUM(amount_base)") && query.includes("month_key")) return { rows: [{ total: 0 }] };
    if (query.includes("FROM budget_topups") && query.includes("month_key")) return { rows: [] };
    if (query.includes("FROM month_baselines")) return { rows: [] };
    return { rows: [] };
  }));

  const report = await repo.buildReportDataForDelivery(user, "weekly", {
    periodKey: "2026-W27",
    periodStartUtc: new Date("2026-06-28T17:00:00Z"),
    periodEndUtc: new Date("2026-07-05T17:00:00Z"),
    timezoneUsed: "Asia/Bangkok",
    localStartDate: "2026-06-29",
    localEndDate: "2026-07-05"
  }, new Date("2026-07-06T03:00:00Z"));

  assert.deepEqual(report.plannedPayments.map((payment) => ({
    name: payment.name,
    amount: payment.amount,
    paid: payment.paid,
    dueDate: payment.dueDate
  })), [
    { name: "June insurance", amount: 2200, paid: false, dueDate: "2026-06-30" }
  ]);
});

test("checks confirmed financial activity using supplied local bounds", async () => {
  const bounds = { start: new Date("2026-06-24T17:00:00Z"), end: new Date("2026-06-25T17:00:00Z") };
  const repo = createRepository(fakePool((sql, params) => {
    assert.match(String(sql), /FROM expenses/);
    assert.match(String(sql), /spent_at >= \$2/);
    assert.match(String(sql), /spent_at < \$3/);
    assert.deepEqual(params, [1, bounds.start, bounds.end]);
    return { rows: [{ exists: 1 }] };
  }));

  assert.equal(await repo.hasConfirmedFinancialActivity(1, bounds), true);
});

test("returns a draft owned by a Telegram user", async () => {
  const repo = createRepository(fakePool(() => ({
    rows: [{ id: "42", status: "pending", items: [{ description: "кофе" }] }]
  })));

  const draft = await repo.getDraftForTelegramUser(42, 100);

  assert.equal(draft.id, "42");
  assert.equal(draft.items[0].description, "кофе");
});

test("updates pending draft items for a Telegram user", async () => {
  const items = [{ amount: 90, currency: "THB", description: "кофе" }];
  const repo = createRepository(fakePool((_sql, params) => ({
    rows: [{ id: "42", status: "pending", items: JSON.parse(params[0]) }]
  })));

  const draft = await repo.updateDraftItems(42, 100, items);

  assert.equal(draft.items[0].amount, 90);
});

test("lists inbox drafts for a Telegram user", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql, params });
    return {
      rows: [{
        id: "42",
        status: "inbox",
        source_text: "unknown 800",
        items: [{ amount: 800, currency: "THB", description: "unknown" }],
        created_at: "2026-06-02T10:00:00.000Z"
      }]
    };
  }));

  const drafts = await repo.listDraftsForTelegramUser(100, { status: "inbox" });

  assert.equal(drafts[0].id, "42");
  assert.equal(drafts[0].status, "inbox");
  assert.equal(drafts[0].items[0].amount, 800);
  assert.equal(queries[1].params[0], 100);
  assert.equal(queries[1].params[1], "inbox");
});

test("moves stale pending drafts into inbox before listing drafts", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    if (String(sql).startsWith("UPDATE drafts")) return { rows: [] };
    return { rows: [] };
  }));

  await repo.listDraftsForTelegramUser(100, { status: "inbox" });

  assert.match(queries[0].sql, /SET status = 'inbox'/);
  assert.match(queries[0].sql, /created_at < now\(\) - \(\$2 \* interval '1 minute'\)/);
  assert.equal(queries[0].params[0], 100);
  assert.equal(queries[0].params[1], 30);
});

test("createDraft starts as inbox only when an item needs review", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [{ id: 1, status: params[1], items: JSON.parse(params[3]) }] };
  }));

  const inboxDraft = await repo.createDraft(7, "unknown 800", [{ amount: 800, needs_review: true }]);
  const pendingDraft = await repo.createDraft(7, "coffee 70", [{ amount: 70, needs_review: false }]);

  assert.equal(inboxDraft.status, "inbox");
  assert.equal(pendingDraft.status, "pending");
  assert.match(queries[0].sql, /INSERT INTO drafts/);
});

test("confirmDraft inserts real expenses and marks the draft confirmed", async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      const query = String(sql);
      if (query.includes("SELECT drafts.*, users.base_currency")) {
        return {
          rows: [{
            id: "42",
            user_id: "1",
            status: "pending",
            base_currency: "THB",
            usd_thb_rate: "32.6",
            items: [{
              amount: 70,
              currency: "THB",
              description: "coffee",
              category_slug: "food_cafe",
              tags: [],
              spent_at: "2026-06-02T10:00:00+07:00",
              budget_impact: "regular"
            }]
          }]
        };
      }
      if (query.includes("INSERT INTO expenses")) {
        return { rows: [{ id: "100", draft_id: params[1], amount_base: params[4] }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const repo = createRepository({ async connect() { return client; } }, { exchangeRates: fixedRates() });
  repo.dashboard = async () => ({ snapshot: {} });

  const expenses = await repo.confirmDraft("42", 100);

  assert.equal(expenses.length, 1);
  assert.equal(expenses[0].draft_id, "42");
  const expenseInsert = queries.find((q) => String(q.sql).includes("INSERT INTO expenses"));
  assert.ok(expenseInsert, "confirming a draft inserts into expenses");
  assert.equal(expenseInsert.params[1], "42");
  assert.ok(
    queries.some((q) => String(q.sql).includes("UPDATE drafts SET status = 'confirmed'")),
    "confirming a draft marks it confirmed"
  );
});

test("confirmDraft also accepts inbox drafts", async () => {
  const client = {
    async query(sql) {
      if (String(sql).includes("SELECT drafts.*, users.base_currency")) {
        return {
          rows: [{
            id: "42",
            user_id: "1",
            status: "inbox",
            base_currency: "THB",
            usd_thb_rate: "32.6",
            items: [{ amount: 70, currency: "THB", description: "coffee", category_slug: "food_cafe", tags: [], spent_at: "2026-06-02T10:00:00+07:00", budget_impact: "regular" }]
          }]
        };
      }
      if (String(sql).includes("INSERT INTO expenses")) {
        return { rows: [{ id: "100", amount_base: 70 }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const repo = createRepository({ async connect() { return client; } }, { exchangeRates: fixedRates() });
  repo.dashboard = async () => ({ snapshot: {} });

  const expenses = await repo.confirmDraft("42", 100);
  assert.equal(expenses.length, 1);
});

test("confirmDraft rejects already closed drafts and creates no expense", async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(String(sql));
      if (String(sql).includes("SELECT drafts.*, users.base_currency")) {
        return { rows: [{ id: "42", user_id: "1", status: "cancelled", base_currency: "THB", usd_thb_rate: "32.6", items: [] }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const { DraftCanceledError } = await import("../src/repository.js");
  const repo = createRepository({ async connect() { return client; } }, { exchangeRates: fixedRates() });

  await assert.rejects(repo.confirmDraft("42", 100), (err) => err instanceof DraftCanceledError);
  assert.ok(!queries.some((sql) => sql.includes("INSERT INTO expenses")));
});

test("cancelDraft marks the draft cancelled without creating an expense", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [] };
  }));

  await repo.cancelDraft("42", 100);

  assert.match(queries[0].sql, /UPDATE drafts\s+SET status = 'cancelled'/);
  assert.ok(!queries.some((q) => q.sql.includes("INSERT INTO expenses")), "cancelling a draft never creates an expense");
});

test("listing expenses never reads from drafts", async () => {
  let listSql = "";
  const repo = createRepository(fakePool((sql) => {
    const query = String(sql);
    if (query.startsWith("SELECT * FROM users")) {
      return { rows: [{ id: "1", telegram_user_id: "100", base_currency: "THB" }] };
    }
    if (query.includes("FROM expenses")) {
      listSql = query;
      return { rows: [] };
    }
    return { rows: [] };
  }));

  const expenses = await repo.listExpensesForTelegramUser(100, { period: "month" });

  assert.deepEqual(expenses, []);
  assert.match(listSql, /FROM expenses/);
  assert.doesNotMatch(listSql, /drafts/);
});

test("listExpenseExportRowsForTelegramUser scopes exports by internal user id and orders oldest first", async () => {
  const calls = [];
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    calls.push({ sql: query, params });
    if (query.startsWith("SELECT * FROM users")) {
      return {
        rows: [{
          id: "7",
          telegram_user_id: "100",
          timezone: "Europe/Moscow",
          base_currency: "THB",
          display_currency: "USD",
          usd_thb_rate: "32.5"
        }]
      };
    }
    return {
      rows: [{
        id: "10",
        amount_original: "250",
        currency_original: "THB",
        amount_base: "250",
        converted_amounts: { USD: 7.69, THB: 250 },
        description: "кофе",
        category_slug: "food_cafe",
        spent_at: "2026-07-07T21:30:00Z",
        created_at: "2026-07-07T21:31:00Z"
      }]
    };
  }));

  const rows = await repo.listExpenseExportRowsForTelegramUser(100, {
    period: "month",
    now: new Date("2026-07-08T10:00:00Z"),
    limit: 50,
    offset: 100
  });

  const listCall = calls.at(-1);
  assert.match(listCall.sql, /FROM expenses/);
  assert.doesNotMatch(listCall.sql, /FROM drafts/);
  assert.match(listCall.sql, /WHERE user_id = \$1/);
  assert.match(listCall.sql, /ORDER BY spent_at ASC, id ASC/);
  assert.match(listCall.sql, /LIMIT \$4 OFFSET \$5/);
  assert.equal(listCall.params[0], "7");
  assert.equal(listCall.params[1].toISOString(), "2026-06-30T21:00:00.000Z");
  assert.equal(listCall.params[2].toISOString(), "2026-07-31T21:00:00.000Z");
  assert.equal(listCall.params[3], 50);
  assert.equal(listCall.params[4], 100);
  assert.equal(rows[0].description, "кофе");
  assert.equal(rows[0].display.amount, 7.69);
  assert.equal(rows[0].display.currency, "USD");
  assert.equal(rows[0].user_timezone, "Europe/Moscow");
});

test("listExpenseExportRowsForTelegramUser all-time export has no period bounds", async () => {
  const calls = [];
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    calls.push({ sql: query, params });
    if (query.startsWith("SELECT * FROM users")) {
      return { rows: [{ id: "7", telegram_user_id: "100", base_currency: "THB", display_currency: "USD" }] };
    }
    return { rows: [] };
  }));

  await repo.listExpenseExportRowsForTelegramUser(100, { period: "all", limit: 25, offset: 0 });

  const listCall = calls.at(-1);
  assert.doesNotMatch(listCall.sql, /spent_at >=/);
  assert.deepEqual(listCall.params, ["7", 25, 0]);
});

test("invalidates the current opening snapshot only when its baseline changes", () => {
  const context = { now: new Date("2026-07-15T12:00:00.000Z"), timeZone: "Asia/Bangkok" };
  const todayRegular = { amount_original: 10, currency_original: "THB", spent_at: "2026-07-15T05:00:00.000Z", budget_impact: "regular" };
  const yesterdayRegular = { ...todayRegular, spent_at: "2026-07-14T05:00:00.000Z" };
  const large = { ...todayRegular, budget_impact: "large_oneoff" };

  assert.equal(shouldInvalidateExpenseSnapshot(todayRegular, { ...todayRegular, amount_original: 20 }, context), false);
  assert.equal(shouldInvalidateExpenseSnapshot(yesterdayRegular, { ...yesterdayRegular, amount_original: 20 }, context), true);
  assert.equal(shouldInvalidateExpenseSnapshot(large, { ...large, amount_original: 20 }, context), true);
  assert.equal(shouldInvalidateExpenseSnapshot(todayRegular, { ...todayRegular, description: "renamed" }, context), false);
  assert.equal(shouldInvalidateExpenseSnapshot(todayRegular, large, context), true);
  assert.equal(shouldInvalidateExpenseSnapshot(yesterdayRegular, { ...yesterdayRegular, spent_at: "2026-07-15T05:00:00.000Z" }, context), true);
});

test("returns the latest editable expense by creation order and excludes planned", async () => {
  let query;
  const repo = createRepository(fakePool((sql) => {
    query = String(sql);
    return { rows: [{ id: 9, created_at: "2026-07-15T12:00:00.000Z" }] };
  }));

  const expense = await repo.getLatestEditableExpenseForTelegramUser(100);

  assert.equal(expense.id, 9);
  assert.match(query, /budget_impact <> 'planned'/);
  assert.match(query, /ORDER BY expenses\.created_at DESC, expenses\.id DESC/);
  assert.doesNotMatch(query, /updated_at DESC/);
});

test("updates an expense owned by a Telegram user", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql, params });
    return {
    rows: [{
      id: "7",
      amount_original: params[0],
      amount_base: params[0],
      currency_original: params[1],
      description: params[6],
      category_slug: params[7],
      tags: params[8],
      spent_at: params[9],
      budget_impact: params[10]
    }]
    };
  }));

  const expense = await repo.updateExpenseForTelegramUser(7, 100, {
    amount: 120,
    currency: "THB",
    description: "завтрак",
    category_slug: "food_cafe",
    tags: ["еда"],
    spent_at: "2026-06-01T10:00:00+07:00",
    budget_impact: "planned"
  });

  assert.equal(Number(expense.amount_original), 120);
  assert.equal(expense.budget_impact, "planned");
  assert.match(String(queries.find((query) => String(query.sql).startsWith("UPDATE expenses")).sql), /budget_impact/);
  assert.equal(expense.description, "завтрак");
});

test("deletes an expense owned by a Telegram user and returns the row with draft_id", async () => {
  const repo = createRepository(fakePool((_sql, params) => ({
    rows: [{ id: params[0], draft_id: 9 }]
  })));

  const deleted = await repo.deleteExpenseForTelegramUser(5, 100);

  assert.equal(deleted.id, 5);
  assert.equal(deleted.draft_id, 9);
});

test("listExpensesByDraftId queries by draft_id and returns the rows", async () => {
  const queries = [];
  const rows = [{ id: "1", draft_id: 9 }, { id: "2", draft_id: 9 }];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows };
  }));

  const expenses = await repo.listExpensesByDraftId(9);

  assert.deepEqual(expenses, rows);
  assert.match(queries[0].sql, /FROM expenses WHERE draft_id = \$1/);
  assert.deepEqual(queries[0].params, [9]);
});

test("lists expenses for history", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql) => {
    queries.push(String(sql));
    return {
    rows: [{ id: "1", description: "кофе" }]
    };
  }));

  const expenses = await repo.listExpensesForTelegramUser(100, { period: "month", search: "кофе" });

  assert.equal(expenses[0].description, "кофе");
  assert.doesNotMatch(queries.at(-1), /planned_expense_payments/);
  assert.doesNotMatch(queries.at(-1), /NOT EXISTS/);
});

test("lists expenses with last7 period and filters by spent_at", async () => {
  const calls = [];
  const repo = createRepository(fakePool((sql, params) => {
    calls.push({ sql: String(sql), params });
    if (String(sql).startsWith("SELECT * FROM users")) {
      return { rows: [{ id: "1", telegram_user_id: "100", base_currency: "THB" }] };
    }
    return { rows: [] };
  }));

  await repo.listExpensesForTelegramUser(100, {
    period: "last7",
    now: new Date("2026-06-16T15:00:00+07:00")
  });

  const listCall = calls.at(-1);
  assert.match(listCall.sql, /spent_at >= \$2 AND spent_at < \$3/);
  assert.doesNotMatch(listCall.sql, /created_at/);
  assert.equal(listCall.params[1].toISOString(), "2026-06-09T17:00:00.000Z");
  assert.equal(listCall.params[2].toISOString(), "2026-06-16T17:00:00.000Z");
});

test("listExpensesForTelegramUser uses the user's timezone for today bounds", async () => {
  const calls = [];
  const repo = createRepository(fakePool((sql, params) => {
    calls.push({ sql: String(sql), params });
    if (String(sql).startsWith("SELECT * FROM users")) {
      return { rows: [{ id: "1", telegram_user_id: "100", timezone: "America/New_York", base_currency: "THB" }] };
    }
    return { rows: [] };
  }));

  await repo.listExpensesForTelegramUser(100, {
    period: "today",
    now: new Date("2026-06-01T03:30:00Z")
  });

  const listCall = calls.at(-1);
  assert.equal(listCall.params[1].toISOString(), "2026-05-31T04:00:00.000Z");
  assert.equal(listCall.params[2].toISOString(), "2026-06-01T04:00:00.000Z");
});

test("listExpensesForTelegramUser with fromDate/toDate uses custom bounds", async () => {
  const calls = [];
  const repo = createRepository(fakePool((sql, params) => {
    calls.push({ sql: String(sql), params });
    if (String(sql).startsWith("SELECT * FROM users")) {
      return { rows: [{ id: "1", telegram_user_id: "100", base_currency: "THB" }] };
    }
    return { rows: [] };
  }));

  await repo.listExpensesForTelegramUser(100, {
    fromDate: "2026-06-01",
    toDate: "2026-06-15"
  });

  const listCall = calls.at(-1);
  assert.equal(listCall.params[1].toISOString(), "2026-05-31T17:00:00.000Z");
  assert.equal(listCall.params[2].toISOString(), "2026-06-15T17:00:00.000Z");
});

test("listExpensesForTelegramUser keeps search working with dates using dynamic placeholder", async () => {
  const calls = [];
  const repo = createRepository(fakePool((sql, params) => {
    calls.push({ sql: String(sql), params });
    if (String(sql).startsWith("SELECT * FROM users")) {
      return { rows: [{ id: "1", telegram_user_id: "100", base_currency: "THB" }] };
    }
    return { rows: [] };
  }));

  await repo.listExpensesForTelegramUser(100, {
    fromDate: "2026-06-01",
    toDate: "2026-06-15",
    search: "coffee"
  });

  const listCall = calls.at(-1);
  assert.match(listCall.sql, /LIKE \$4/);
  assert.equal(listCall.params[3], "%coffee%");
  assert.match(listCall.sql, /spent_at >= \$2 AND spent_at < \$3/);
});

test("listExpensesForTelegramUser falls back to month for unknown period", async () => {
  const calls = [];
  const repo = createRepository(fakePool((sql, params) => {
    calls.push({ sql: String(sql), params });
    if (String(sql).startsWith("SELECT * FROM users")) {
      return { rows: [{ id: "1", telegram_user_id: "100", base_currency: "THB" }] };
    }
    return { rows: [] };
  }));

  await repo.listExpensesForTelegramUser(100, {
    period: "bogus",
    now: new Date("2026-06-16T15:00:00+07:00")
  });

  const listCall = calls.at(-1);
  assert.equal(listCall.params[1].toISOString(), "2026-05-31T17:00:00.000Z");
  assert.equal(listCall.params[2].toISOString(), "2026-06-30T17:00:00.000Z");
});

test("returns top categories", async () => {
  const repo = createRepository(fakePool(() => ({
    rows: [{ category_slug: "food_cafe", total: 1200 }]
  })));

  const categories = await repo.topCategories(1, new Date("2026-06-07T10:00:00+07:00"));

  assert.equal(categories[0].category_slug, "food_cafe");
  assert.equal(categories[0].total, 1200);
});

test("creates and lists planned expenses", async () => {
  const queries = [];
  const repo = createRepository(fakePool((_sql, params) => {
    const query = String(_sql);
    queries.push({ sql: query, params });
    if (query.includes("INSERT INTO planned_expenses")) {
      assert.match(String(_sql), /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, \$11, \$12, true\)/);
      assert.equal(params.length, 12);
      return { rows: [{ id: "5", user_id: "5", description: params[4], recurrence: params[7] }] };
    }
    if (query.includes("INSERT INTO app_events")) return { rows: [], rowCount: 1 };
    return { rows: [{ id: "5", description: "ChatGPT", recurrence: "monthly" }] };
  }));

  const created = await repo.createPlannedExpense(100, {
    amount: 20,
    currency: "USD",
    amount_base: 20,
    description: "ChatGPT",
    category_slug: "subscriptions",
    tags: ["регулярная трата"],
    recurrence: "monthly",
    due_day: 10,
    active: false
  });
  const planned = await repo.listPlannedExpensesForTelegramUser(100);

  assert.equal(created.description, "ChatGPT");
  assert.equal(planned[0].recurrence, "monthly");
  const createQuery = queries.find((query) => query.sql.includes("INSERT INTO planned_expenses"));
  assert.match(createQuery.sql, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, \$11, \$12, true\)/);
  assert.ok(!queries.some((query) => query.sql.includes("DELETE FROM daily_budget_snapshots")));
  const event = queries.find((query) => query.sql.includes("INSERT INTO app_events"));
  assert.deepEqual(event.params, ["5", "planned_expense_created", JSON.stringify({ source: "miniapp" })]);
  assert.doesNotMatch(event.params[2], /ChatGPT|20/);
});

test("checks successful report delivery for an exact user type and key", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [{ exists: true }] };
  }));

  assert.equal(await repo.hasReportDelivery(7, "weekly", "2026-W27"), true);
  assert.match(queries[0].sql, /SELECT EXISTS/);
  assert.match(queries[0].sql, /status = 'sent'/);
  assert.deepEqual(queries[0].params, [7, "weekly", "2026-W27"]);
});

test("records a safe event after planned expense update", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    queries.push({ sql: query, params });
    if (query.startsWith("SELECT * FROM users")) {
      return { rows: [{ id: "7", telegram_user_id: "100", base_currency: "THB", timezone: "Asia/Bangkok" }] };
    }
    if (query.startsWith("UPDATE planned_expenses") && query.includes("amount =")) {
      return { rows: [{ id: "5", user_id: "7", active: true }] };
    }
    return { rows: [], rowCount: query.includes("INSERT INTO app_events") ? 1 : 0 };
  }));

  await repo.updatePlannedExpense(100, 5, {
    amount: 20,
    currency: "THB",
    description: "Private description",
    category_slug: "subscriptions",
    recurrence: "monthly",
    due_day: 10,
    active: true
  });
  const updateQuery = queries.find((query) => query.sql.startsWith("UPDATE planned_expenses") && query.sql.includes("amount ="));
  const updateSetClause = updateQuery.sql.slice(updateQuery.sql.indexOf("SET"), updateQuery.sql.indexOf("WHERE"));
  assert.doesNotMatch(updateSetClause, /\bactive\s*=/);
  assert.match(updateQuery.sql, /AND active = true/);
  assert.equal(updateQuery.params.length, 13);
  assert.ok(!queries.some((query) => query.sql.includes("DELETE FROM daily_budget_snapshots")));

  const events = queries
    .filter((query) => query.sql.includes("INSERT INTO app_events"))
    .map((query) => [query.params[1], JSON.parse(query.params[2])]);
  assert.deepEqual(events, [["planned_expense_updated", { source: "miniapp" }]]);
  assert.doesNotMatch(JSON.stringify(events), /Private description|20/);
});

test("updating an inactive planned expense returns null without recording an event", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    queries.push({ sql: query, params });
    if (query.startsWith("SELECT * FROM users")) {
      return { rows: [{ id: "7", telegram_user_id: "100", base_currency: "THB", timezone: "Asia/Bangkok" }] };
    }
    if (query.startsWith("UPDATE planned_expenses") && query.includes("amount =")) return { rows: [] };
    return { rows: [], rowCount: 0 };
  }));

  const result = await repo.updatePlannedExpense(100, 5, {
    amount: 20,
    currency: "THB",
    description: "Private description",
    category_slug: "subscriptions",
    recurrence: "monthly",
    due_day: 10
  });

  assert.equal(result, null);
  const updateQuery = queries.find((query) => query.sql.startsWith("UPDATE planned_expenses") && query.sql.includes("amount ="));
  assert.match(updateQuery.sql, /AND active = true/);
  assert.ok(!queries.some((query) => query.sql.includes("INSERT INTO app_events")));
});

test("deactivates an owned weekly plan transactionally and keeps retry impact stable across a month rollover", async () => {
  const now = new Date("2026-07-31T10:00:00+07:00");
  const retryNow = new Date("2026-08-01T10:00:00+07:00");
  const queries = [];
  const events = [];
  let active = true;
  let disabledAt = null;
  let releases = 0;
  const client = {
    async query(sql, params = []) {
      const query = String(sql);
      queries.push({ sql: query, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(query)) return { rows: [] };
      if (query.includes("FROM planned_expenses") && query.includes("FOR UPDATE")) {
        return {
          rows: [{
            id: "5",
            user_id: "7",
            amount_base: "1000",
            recurrence: "weekly",
            weekday: 3,
            active,
            disabled_at: disabledAt,
            base_currency: "THB",
            timezone: "Asia/Bangkok"
          }]
        };
      }
      if (query.includes("FROM planned_expense_payments")) {
        return {
          rows: [
            { occurrence_date: "2026-07-01", amount_base: "900" },
            { occurrence_date: "2026-07-08", amount_base: "1100" }
          ]
        };
      }
      if (query.startsWith("UPDATE planned_expenses") && query.includes("active = false")) {
        assert.equal(active, true);
        active = false;
        disabledAt = params[1];
        return {
          rows: [{
            id: "5",
            user_id: "7",
            amount_base: "1000",
            recurrence: "weekly",
            weekday: 3,
            active,
            disabled_at: disabledAt
          }]
        };
      }
      throw new Error(`Unexpected client query: ${query}`);
    },
    release() { releases += 1; }
  };
  const repo = createRepository({
    async connect() { return client; },
    async query(sql, params = []) {
      events.push({ sql: String(sql), params });
      return { rows: [], rowCount: 1 };
    }
  });

  const first = await repo.deactivatePlannedExpense(100, 5, now);
  const second = await repo.deactivatePlannedExpense(100, 5, retryNow);

  const expectedImpact = {
    paidOccurrencesKept: 2,
    paidAmountKept: 2000,
    unpaidOccurrencesRemoved: 3,
    unpaidAmountRemoved: 3000,
    currency: "THB"
  };
  assert.deepEqual(first, {
    plannedExpense: {
      id: "5",
      user_id: "7",
      amount_base: "1000",
      recurrence: "weekly",
      weekday: 3,
      active: false,
      disabled_at: now
    },
    impact: expectedImpact
  });
  assert.deepEqual(second, first);
  assert.equal(queries.filter((query) => query.sql === "BEGIN").length, 2);
  assert.equal(queries.filter((query) => query.sql === "COMMIT").length, 2);
  assert.equal(queries.filter((query) => query.sql === "ROLLBACK").length, 0);
  assert.equal(releases, 2);

  const lockQueries = queries.filter((query) => query.sql.includes("FOR UPDATE"));
  assert.equal(lockQueries.length, 2);
  assert.match(lockQueries[0].sql, /JOIN users ON users\.id = planned_expenses\.user_id/);
  assert.match(lockQueries[0].sql, /planned_expenses\.id = \$1/);
  assert.match(lockQueries[0].sql, /users\.telegram_user_id = \$2/);
  const paymentQueries = queries.filter((query) => query.sql.includes("FROM planned_expense_payments"));
  const paymentQuery = paymentQueries[0];
  assert.match(paymentQuery.sql, /JOIN expenses/);
  assert.match(paymentQuery.sql, /e\.user_id = \$2/);
  assert.deepEqual(paymentQueries.map((query) => query.params[2]), ["2026-07", "2026-07"]);

  const updates = queries.filter((query) => query.sql.startsWith("UPDATE planned_expenses") && query.sql.includes("active = false"));
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /disabled_at = \$2/);
  assert.match(updates[0].sql, /AND active = true/);
  assert.deepEqual(updates[0].params, ["5", now]);
  assert.ok(!queries.some((query) => /DELETE FROM (expenses|planned_expense_payments|daily_budget_snapshots)/.test(query.sql)));

  const deletionEvents = events.filter((query) => query.sql.includes("INSERT INTO app_events"));
  assert.equal(deletionEvents.length, 1);
  assert.deepEqual(deletionEvents[0].params, ["7", "planned_expense_deleted", JSON.stringify({ source: "miniapp" })]);
});

test("keeps valid current-month payments that no longer match an edited plan schedule", async () => {
  const now = new Date("2026-07-22T10:00:00+07:00");
  const client = {
    async query(sql, params = []) {
      const query = String(sql);
      if (["BEGIN", "COMMIT"].includes(query)) return { rows: [] };
      if (query.includes("FROM planned_expenses") && query.includes("FOR UPDATE")) {
        return {
          rows: [{
            id: "5",
            user_id: "7",
            amount_base: "1000",
            recurrence: "twice_monthly",
            due_day: 20,
            due_days: [20, 25],
            active: true,
            disabled_at: null,
            base_currency: "THB",
            timezone: "Asia/Bangkok"
          }]
        };
      }
      if (query.includes("FROM planned_expense_payments")) {
        assert.equal(params[2], "2026-07");
        return {
          rows: [
            { occurrence_date: "2026-07-10", amount_base: "900" },
            { occurrence_date: "2026-07-20", amount_base: "1100" }
          ]
        };
      }
      if (query.startsWith("UPDATE planned_expenses")) {
        return {
          rows: [{
            id: "5",
            user_id: "7",
            amount_base: "1000",
            recurrence: "twice_monthly",
            due_day: 20,
            due_days: [20, 25],
            active: false,
            disabled_at: params[1]
          }]
        };
      }
      throw new Error(`Unexpected query: ${query}`);
    },
    release() {}
  };
  const repo = createRepository({
    async connect() { return client; },
    async query() { return { rows: [], rowCount: 1 }; }
  });

  const result = await repo.deactivatePlannedExpense(100, 5, now);

  assert.deepEqual(result.impact, {
    paidOccurrencesKept: 2,
    paidAmountKept: 2000,
    unpaidOccurrencesRemoved: 1,
    unpaidAmountRemoved: 1000,
    currency: "THB"
  });
});

test("rolls back and returns null when planned expense is missing or belongs to another user", async () => {
  const queries = [];
  let releases = 0;
  const client = {
    async query(sql, params = []) {
      const query = String(sql);
      queries.push({ sql: query, params });
      if (["BEGIN", "ROLLBACK"].includes(query)) return { rows: [] };
      if (query.includes("FOR UPDATE")) return { rows: [] };
      throw new Error(`Unexpected query: ${query}`);
    },
    release() { releases += 1; }
  };
  const repo = createRepository({
    async connect() { return client; },
    async query() { throw new Error("missing disable must not record an event"); }
  });

  const result = await repo.deactivatePlannedExpense(999, 5, new Date("2026-07-22T10:00:00+07:00"));

  assert.equal(result, null);
  assert.deepEqual(queries.map((query) => query.sql), [
    "BEGIN",
    queries[1].sql,
    "ROLLBACK"
  ]);
  assert.match(queries[1].sql, /FOR UPDATE/);
  assert.deepEqual(queries[1].params, [5, 999]);
  assert.equal(releases, 1);
});

test("rolls back and releases the client when planned disable impact lookup fails", async () => {
  const queries = [];
  let releases = 0;
  const failure = new Error("payment lookup failed");
  const client = {
    async query(sql) {
      const query = String(sql);
      queries.push(query);
      if (["BEGIN", "ROLLBACK"].includes(query)) return { rows: [] };
      if (query.includes("FOR UPDATE")) {
        return { rows: [{ id: "5", user_id: "7", amount_base: "1000", recurrence: "monthly", due_day: 10, active: true, base_currency: "THB", timezone: "Asia/Bangkok" }] };
      }
      if (query.includes("FROM planned_expense_payments")) throw failure;
      throw new Error(`Unexpected query: ${query}`);
    },
    release() { releases += 1; }
  };
  const repo = createRepository({ async connect() { return client; } });

  await assert.rejects(
    repo.deactivatePlannedExpense(100, 5, new Date("2026-07-22T10:00:00+07:00")),
    failure
  );
  assert.equal(queries.at(-1), "ROLLBACK");
  assert.equal(releases, 1);
});

test("paying a planned expense creates an expense and records payment month", async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (String(sql).includes("SELECT planned_expenses.*, users.base_currency")) {
        return {
          rows: [{
            id: "5",
            user_id: "1",
            amount: "17000",
            currency: "THB",
            amount_base: "17000",
            description: "квартира",
            category_slug: "home",
            tags: ["дом"],
            base_currency: "THB"
          }]
        };
      }
      if (String(sql).includes("INSERT INTO expenses")) {
        return {
          rows: [{
            id: "20",
            amount_original: params[1],
            currency_original: params[2],
            amount_base: params[3],
            description: params[8],
            category_slug: params[9],
            budget_impact: params[12]
          }]
        };
      }
      if (String(sql).includes("INSERT INTO planned_expense_payments")) return { rows: [{ id: "9" }] };
      return { rows: [] };
    },
    release() {}
  };
  const repo = createRepository({
    async connect() {
      return client;
    }
  });

  const expense = await repo.payPlannedExpenseForTelegramUser(5, 100, new Date("2026-06-17T09:00:00+07:00"));

  assert.equal(expense.description, "квартира");
  assert.equal(Number(expense.amount_original), 17000);
  const expenseInsert = queries.find((query) => String(query.sql).includes("INSERT INTO expenses"));
  assert.match(String(expenseInsert.sql), /budget_impact/);
  assert.equal(expenseInsert.params.at(-1), "planned");
  assert.ok(queries.some((query) => String(query.sql).includes("INSERT INTO planned_expense_payments")));
  assert.ok(queries.some((query) => String(query.sql) === "COMMIT"));
});

test("planned RUB expenses are converted through dated THB rates", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql, params });
    if (String(sql).startsWith("SELECT * FROM users")) {
      return {
        rows: [{
          id: "1",
          telegram_user_id: "100",
          base_currency: "THB",
          display_currency: "USD",
          usd_thb_rate: "32.6"
        }]
      };
    }
    if (String(sql).startsWith("INSERT INTO planned_expenses")) {
      return {
        rows: [{
          id: "8",
          amount: params[1],
          currency: params[2],
          amount_base: params[3],
          description: params[4]
        }]
      };
    }
    return { rows: [] };
  }), {
    exchangeRates: fixedRates()
  });

  const planned = await repo.createPlannedExpense(100, {
    amount: 5000,
    currency: "RUB",
    description: "psychologist",
    category_slug: "health",
    recurrence: "monthly",
    due_day: 4
  });

  assert.equal(Number(planned.amount_base), 1800);
  assert.equal(queries.find((query) => String(query.sql).startsWith("INSERT INTO planned_expenses")).params[3], 1800);
});

test("IDR base users store amount_base in IDR", async () => {
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    if (query.startsWith("SELECT * FROM users")) {
      return {
        rows: [{
          id: "1",
          telegram_user_id: "100",
          base_currency: "IDR",
          display_currency: "USD",
          usd_thb_rate: "32.6"
        }]
      };
    }
    if (query.startsWith("INSERT INTO planned_expenses")) {
      return {
        rows: [{
          id: "9",
          amount: params[1],
          currency: params[2],
          amount_base: params[3]
        }]
      };
    }
    return { rows: [] };
  }), {
    exchangeRates: fixedRates()
  });

  const planned = await repo.createPlannedExpense(100, {
    amount: 1,
    currency: "USD",
    description: "test",
    category_slug: "other",
    recurrence: "one_off",
    due_date: "2026-06-10"
  });

  assert.equal(Number(planned.amount_base), 16200);
});

test("paying weekly planned expenses uses an occurrence key, not one payment per month", async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (String(sql).includes("SELECT planned_expenses.*, users.base_currency")) {
        return {
          rows: [{
            id: "5",
            user_id: "1",
            amount: "1000",
            currency: "THB",
            amount_base: "1000",
            description: "english",
            category_slug: "education",
            tags: [],
            recurrence: "weekly",
            weekday: 3,
            base_currency: "THB",
            usd_thb_rate: "32.6"
          }]
        };
      }
      if (String(sql).includes("INSERT INTO expenses")) {
        return {
          rows: [{
            id: "20",
            amount_original: params[1],
            currency_original: params[2],
            amount_base: params[3],
            converted_amounts: JSON.parse(params[5]),
            exchange_rate_source: params[7],
            description: params[8],
            category_slug: params[9]
          }]
        };
      }
      if (String(sql).includes("INSERT INTO planned_expense_payments")) return { rows: [{ id: "9" }] };
      return { rows: [] };
    },
    release() {}
  };
  const repo = createRepository({
    async connect() {
      return client;
    }
  }, {
    exchangeRates: fixedRates()
  });

  const expense = await repo.payPlannedExpenseForTelegramUser(5, 100, new Date("2026-06-17T09:00:00+07:00"));
  const paymentQuery = queries.find((query) => String(query.sql).includes("INSERT INTO planned_expense_payments"));

  assert.equal(Number(expense.amount_base), 1000);
  assert.match(String(paymentQuery.sql), /paid_key/);
  assert.equal(paymentQuery.params[4], "2026-06-03");
  assert.equal(paymentQuery.params[5], "2026-06:2026-06-03");
});

test("paying weekly planned expenses records the nearest unpaid current-month occurrence", async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (String(sql).includes("SELECT planned_expenses.*, users.base_currency")) {
        return {
          rows: [{
            id: "5",
            user_id: "1",
            amount: "1000",
            currency: "THB",
            amount_base: "1000",
            description: "english",
            category_slug: "education",
            tags: [],
            recurrence: "weekly",
            weekday: 3,
            base_currency: "THB",
            usd_thb_rate: "32.6",
            paid_occurrence_dates: ["2026-06-03"]
          }]
        };
      }
      if (String(sql).includes("pep.occurrence_date")) {
        return { rows: [{ occurrence_date: "2026-06-03" }] };
      }
      if (String(sql).includes("INSERT INTO expenses")) {
        return {
          rows: [{
            id: "20",
            amount_original: params[1],
            currency_original: params[2],
            amount_base: params[3],
            description: params[8],
            category_slug: params[9]
          }]
        };
      }
      if (String(sql).includes("INSERT INTO planned_expense_payments")) return { rows: [{ id: "9" }] };
      return { rows: [] };
    },
    release() {}
  };
  const repo = createRepository({
    async connect() {
      return client;
    }
  }, {
    exchangeRates: fixedRates()
  });

  await repo.payPlannedExpenseForTelegramUser(5, 100, new Date("2026-06-13T09:00:00+07:00"));
  const paymentQuery = queries.find((query) => String(query.sql).includes("INSERT INTO planned_expense_payments"));

  assert.match(String(paymentQuery.sql), /occurrence_date/);
  assert.equal(paymentQuery.params[4], "2026-06-10");
});

test("paying an overdue monthly planned expense records the expense on the occurrence date", async () => {
  const queries = [];
  const repo = createRepository({
    async connect() {
      return fakePayClient({
        planned: {
          id: "5",
          user_id: "1",
          amount: "17000",
          currency: "THB",
          amount_base: "17000",
          description: "сервер",
          category_slug: "subscriptions",
          tags: [],
          recurrence: "monthly",
          due_day: 6,
          due_days: [6],
          base_currency: "THB"
        },
        queries
      });
    }
  }, { exchangeRates: fixedRates() });

  const paidAt = new Date("2026-06-16T09:00:00+07:00");
  await repo.payPlannedExpenseForTelegramUser(5, 100, paidAt);

  const expenseInsert = queries.find((query) => String(query.sql).includes("INSERT INTO expenses"));
  const paymentInsert = queries.find((query) => String(query.sql).includes("INSERT INTO planned_expense_payments"));

  assert.equal(new Date(expenseInsert.params[11]).toISOString(), "2026-06-06T05:00:00.000Z");
  assert.equal(expenseInsert.params[6], "2026-06-06");
  assert.equal(paymentInsert.params[4], "2026-06-06");
  assert.equal(paymentInsert.params[3], paidAt);
  assert.equal(paymentInsert.params[2], "2026-06");
});

test("paying a same-day monthly planned expense records the expense at the click time", async () => {
  const queries = [];
  const repo = createRepository({
    async connect() {
      return fakePayClient({
        planned: {
          id: "5",
          user_id: "1",
          amount: "17000",
          currency: "THB",
          amount_base: "17000",
          description: "сервер",
          category_slug: "subscriptions",
          tags: [],
          recurrence: "monthly",
          due_day: 16,
          due_days: [16],
          base_currency: "THB"
        },
        queries
      });
    }
  }, { exchangeRates: fixedRates() });

  const paidAt = new Date("2026-06-16T14:16:00+07:00");
  await repo.payPlannedExpenseForTelegramUser(5, 100, paidAt);

  const expenseInsert = queries.find((query) => String(query.sql).includes("INSERT INTO expenses"));
  const paymentInsert = queries.find((query) => String(query.sql).includes("INSERT INTO planned_expense_payments"));

  assert.equal(new Date(expenseInsert.params[11]).toISOString(), paidAt.toISOString());
  assert.equal(expenseInsert.params[6], "2026-06-16");
  assert.equal(paymentInsert.params[4], "2026-06-16");
  assert.equal(paymentInsert.params[3], paidAt);
});

test("paying an overdue twice-monthly planned expense records the expense at local noon", async () => {
  const queries = [];
  const repo = createRepository({
    async connect() {
      return fakePayClient({
        planned: {
          id: "5",
          user_id: "1",
          amount: "2000",
          currency: "THB",
          amount_base: "2000",
          description: "therapy",
          category_slug: "health",
          tags: [],
          recurrence: "twice_monthly",
          due_days: [4, 17],
          base_currency: "THB"
        },
        queries
      });
    }
  }, { exchangeRates: fixedRates() });

  const paidAt = new Date("2026-06-16T14:16:00+07:00");
  await repo.payPlannedExpenseForTelegramUser(5, 100, paidAt);

  const expenseInsert = queries.find((query) => String(query.sql).includes("INSERT INTO expenses"));
  const paymentInsert = queries.find((query) => String(query.sql).includes("INSERT INTO planned_expense_payments"));

  assert.equal(new Date(expenseInsert.params[11]).toISOString(), "2026-06-04T05:00:00.000Z");
  assert.equal(expenseInsert.params[6], "2026-06-04");
  assert.equal(paymentInsert.params[4], "2026-06-04");
  assert.equal(paymentInsert.params[3], paidAt);
});

test("paying an overdue weekly planned expense records the expense at local noon", async () => {
  const queries = [];
  const repo = createRepository({
    async connect() {
      return fakePayClient({
        planned: {
          id: "5",
          user_id: "1",
          amount: "1000",
          currency: "THB",
          amount_base: "1000",
          description: "english",
          category_slug: "education",
          tags: [],
          recurrence: "weekly",
          weekday: 3,
          base_currency: "THB"
        },
        queries
      });
    }
  }, { exchangeRates: fixedRates() });

  const paidAt = new Date("2026-06-16T14:16:00+07:00");
  await repo.payPlannedExpenseForTelegramUser(5, 100, paidAt);

  const expenseInsert = queries.find((query) => String(query.sql).includes("INSERT INTO expenses"));
  const paymentInsert = queries.find((query) => String(query.sql).includes("INSERT INTO planned_expense_payments"));

  assert.equal(new Date(expenseInsert.params[11]).toISOString(), "2026-06-03T05:00:00.000Z");
  assert.equal(expenseInsert.params[6], "2026-06-03");
  assert.equal(paymentInsert.params[4], "2026-06-03");
  assert.equal(paymentInsert.params[3], paidAt);
});

test("paying an already-paid monthly occurrence rejects without creating an expense", async () => {
  const queries = [];
  const repo = createRepository({
    async connect() {
      return fakePayClient({
        planned: {
          id: "5",
          user_id: "1",
          amount: "17000",
          currency: "THB",
          amount_base: "17000",
          description: "сервер",
          category_slug: "subscriptions",
          tags: [],
          recurrence: "monthly",
          due_day: 6,
          due_days: [6],
          base_currency: "THB"
        },
        paidOccurrences: [{ occurrence_date: "2026-06-06" }],
        queries
      });
    }
  }, { exchangeRates: fixedRates() });

  await assert.rejects(
    repo.payPlannedExpenseForTelegramUser(5, 100, new Date("2026-06-16T09:00:00+07:00")),
    (error) => error.code === "already_paid"
  );
  assert.ok(!queries.some((query) => String(query.sql).includes("INSERT INTO expenses")));
});

test("paying a monthly expense with a stale occurrence_date rejects as already_paid", async () => {
  const queries = [];
  const repo = createRepository({
    async connect() {
      return fakePayClient({
        planned: {
          id: "9",
          user_id: "1",
          amount: "500",
          currency: "THB",
          amount_base: "500",
          description: "Сервер",
          category_slug: "subscriptions",
          tags: [],
          recurrence: "monthly",
          due_day: 6,
          due_days: [6],
          base_currency: "THB"
        },
        paidOccurrences: [{ occurrence_date: "2026-06-07", paid_key: "2026-06" }],
        queries
      });
    }
  }, { exchangeRates: fixedRates() });

  await assert.rejects(
    repo.payPlannedExpenseForTelegramUser(9, 100, new Date("2026-06-16T09:00:00+07:00")),
    (error) => error.code === "already_paid"
  );
  assert.ok(!queries.some((query) => String(query.sql).includes("INSERT INTO expenses")));
});

test("date-mismatched linked expense blocks duplicate planned payment", async () => {
  const queries = [];
  const repo = createRepository({
    async connect() {
      return fakePayClient({
        planned: {
          id: "17",
          user_id: "26",
          amount: "300",
          currency: "THB",
          amount_base: "300",
          description: "Simcard",
          category_slug: "subscriptions",
          tags: [],
          recurrence: "monthly",
          due_day: 14,
          due_days: [14],
          base_currency: "THB"
        },
        paidOccurrences: [{ occurrence_date: "2026-06-14", paid_key: "2026-06" }],
        queries
      });
    }
  }, { exchangeRates: fixedRates() });

  await assert.rejects(
    repo.payPlannedExpenseForTelegramUser(
      17,
      222386362,
      new Date("2026-06-18T09:00:00+07:00"),
      { occurrenceDate: "2026-06-14" }
    ),
    (error) => error.code === "already_paid"
  );

  const paidLookup = queries.find((query) => String(query.sql).includes("pep.occurrence_date"));
  assert.doesNotMatch(String(paidLookup.sql), /spent_at/);
  assert.match(String(paidLookup.sql), /e\.user_id = \$3/);
  assert.ok(!queries.some((query) => String(query.sql).includes("INSERT INTO expenses")));
});

test("paying a monthly expense recognizes Date object paid occurrence rows", async () => {
  const queries = [];
  const repo = createRepository({
    async connect() {
      return fakePayClient({
        planned: {
          id: "9",
          user_id: "1",
          amount: "500",
          currency: "THB",
          amount_base: "500",
          description: "server",
          category_slug: "subscriptions",
          tags: [],
          recurrence: "monthly",
          due_day: 6,
          due_days: [6],
          base_currency: "THB"
        },
        paidOccurrences: [{ occurrence_date: new Date("2026-06-06T00:00:00.000Z"), paid_key: "2026-06" }],
        queries
      });
    }
  }, { exchangeRates: fixedRates() });

  await assert.rejects(
    repo.payPlannedExpenseForTelegramUser(9, 100, new Date("2026-06-16T09:00:00+07:00"), { occurrenceDate: "2026-06-06" }),
    (error) => error.code === "already_paid"
  );
  assert.ok(!queries.some((query) => String(query.sql).includes("INSERT INTO expenses")));
});

test("paying a planned expense uses paid_key as the conflict arbiter", async () => {
  const queries = [];
  const repo = createRepository({
    async connect() {
      return fakePayClient({
        planned: {
          id: "5",
          user_id: "1",
          amount: "17000",
          currency: "THB",
          amount_base: "17000",
          description: "сервер",
          category_slug: "subscriptions",
          tags: [],
          recurrence: "monthly",
          due_day: 6,
          due_days: [6],
          base_currency: "THB"
        },
        queries
      });
    }
  }, { exchangeRates: fixedRates() });

  await repo.payPlannedExpenseForTelegramUser(5, 100, new Date("2026-06-16T09:00:00+07:00"));
  const paymentInsert = queries.find((query) => String(query.sql).includes("INSERT INTO planned_expense_payments"));
  assert.match(String(paymentInsert.sql), /ON CONFLICT \(planned_expense_id, paid_key\)/);
  assert.match(String(paymentInsert.sql), /occurrence_date = EXCLUDED\.occurrence_date/);
});

test("paying a not-found planned expense rejects with a not_found code", async () => {
  const repo = createRepository({
    async connect() {
      return {
        async query(sql) {
          if (String(sql).includes("SELECT planned_expenses.*, users.base_currency")) return { rows: [] };
          return { rows: [] };
        },
        release() {}
      };
    }
  }, { exchangeRates: fixedRates() });

  await assert.rejects(
    repo.payPlannedExpenseForTelegramUser(99, 100, new Date("2026-06-16T09:00:00+07:00")),
    (error) => error.code === "not_found"
  );
});

test("paying a twice-monthly planned expense selects the earliest unpaid overdue occurrence", async () => {
  const queries = [];
  const repo = createRepository({
    async connect() {
      return fakePayClient({
        planned: {
          id: "5",
          user_id: "1",
          amount: "2000",
          currency: "THB",
          amount_base: "2000",
          description: "therapy",
          category_slug: "health",
          tags: [],
          recurrence: "twice_monthly",
          due_day: 4,
          due_days: [4, 17],
          base_currency: "THB"
        },
        queries
      });
    }
  }, { exchangeRates: fixedRates() });

  await repo.payPlannedExpenseForTelegramUser(5, 100, new Date("2026-06-16T09:00:00+07:00"));
  const paymentInsert = queries.find((query) => String(query.sql).includes("INSERT INTO planned_expense_payments"));
  assert.equal(paymentInsert.params[4], "2026-06-04");
});

test("paying a twice-monthly planned expense moves to the next occurrence when earlier is paid", async () => {
  const queries = [];
  const repo = createRepository({
    async connect() {
      return fakePayClient({
        planned: {
          id: "5",
          user_id: "1",
          amount: "2000",
          currency: "THB",
          amount_base: "2000",
          description: "therapy",
          category_slug: "health",
          tags: [],
          recurrence: "twice_monthly",
          due_day: 4,
          due_days: [4, 17],
          base_currency: "THB"
        },
        paidOccurrences: [{ occurrence_date: "2026-06-04" }],
        queries
      });
    }
  }, { exchangeRates: fixedRates() });

  await repo.payPlannedExpenseForTelegramUser(5, 100, new Date("2026-06-16T09:00:00+07:00"));
  const paymentInsert = queries.find((query) => String(query.sql).includes("INSERT INTO planned_expense_payments"));
  assert.equal(paymentInsert.params[4], "2026-06-17");
});

test("paying with an explicit occurrenceDate creates the expense on that occurrence date", async () => {
  const queries = [];
  const repo = createRepository({
    async connect() {
      return fakePayClient({
        planned: {
          id: "5",
          user_id: "1",
          amount: "17000",
          currency: "THB",
          amount_base: "17000",
          description: "сервер",
          category_slug: "subscriptions",
          tags: [],
          recurrence: "monthly",
          due_day: 6,
          due_days: [6],
          base_currency: "THB"
        },
        queries
      });
    }
  }, { exchangeRates: fixedRates() });

  await repo.payPlannedExpenseForTelegramUser(5, 100, new Date("2026-06-16T09:00:00+07:00"), { occurrenceDate: "2026-06-06" });

  const expenseInsert = queries.find((query) => String(query.sql).includes("INSERT INTO expenses"));
  const paymentInsert = queries.find((query) => String(query.sql).includes("INSERT INTO planned_expense_payments"));

  assert.equal(expenseInsert.params[6], "2026-06-06");
  assert.equal(new Date(expenseInsert.params[11]).toISOString(), "2026-06-06T05:00:00.000Z");
  assert.equal(paymentInsert.params[4], "2026-06-06");
});

test("paying with occurrenceDate as a Date object normalizes occurrence date and paid_key", async () => {
  const queries = [];
  const repo = createRepository({
    async connect() {
      return fakePayClient({
        planned: {
          id: "5",
          user_id: "1",
          amount: "17000",
          currency: "THB",
          amount_base: "17000",
          description: "server",
          category_slug: "subscriptions",
          tags: [],
          recurrence: "monthly",
          due_day: 6,
          due_days: [6],
          base_currency: "THB"
        },
        queries
      });
    }
  }, { exchangeRates: fixedRates() });

  await repo.payPlannedExpenseForTelegramUser(
    5,
    100,
    new Date("2026-06-16T09:00:00+07:00"),
    { occurrenceDate: new Date("2026-06-06T00:00:00.000Z") }
  );

  const expenseInsert = queries.find((query) => String(query.sql).includes("INSERT INTO expenses"));
  const paymentInsert = queries.find((query) => String(query.sql).includes("INSERT INTO planned_expense_payments"));
  assert.equal(expenseInsert.params[6], "2026-06-06");
  assert.equal(new Date(expenseInsert.params[11]).toISOString(), "2026-06-06T05:00:00.000Z");
  assert.equal(paymentInsert.params[4], "2026-06-06");
  assert.equal(paymentInsert.params[5], "2026-06");
});

test("paying with occurrenceDate does not pay a different occurrence", async () => {
  const queries = [];
  const repo = createRepository({
    async connect() {
      return fakePayClient({
        planned: {
          id: "5",
          user_id: "1",
          amount: "2000",
          currency: "THB",
          amount_base: "2000",
          description: "therapy",
          category_slug: "health",
          tags: [],
          recurrence: "twice_monthly",
          due_days: [4, 17],
          base_currency: "THB"
        },
        queries
      });
    }
  }, { exchangeRates: fixedRates() });

  await repo.payPlannedExpenseForTelegramUser(5, 100, new Date("2026-06-18T09:00:00+07:00"), { occurrenceDate: "2026-06-17" });

  const paymentInsert = queries.find((query) => String(query.sql).includes("INSERT INTO planned_expense_payments"));
  assert.equal(paymentInsert.params[4], "2026-06-17");
  assert.equal(paymentInsert.params[5], "2026-06:2026-06-17");
});

test("paying the same occurrence twice with occurrenceDate rejects as already_paid", async () => {
  const queries = [];
  const repo = createRepository({
    async connect() {
      return fakePayClient({
        planned: {
          id: "5",
          user_id: "1",
          amount: "17000",
          currency: "THB",
          amount_base: "17000",
          description: "сервер",
          category_slug: "subscriptions",
          tags: [],
          recurrence: "monthly",
          due_day: 6,
          due_days: [6],
          base_currency: "THB"
        },
        paidOccurrences: [{ occurrence_date: "2026-06-06", paid_key: "2026-06" }],
        queries
      });
    }
  }, { exchangeRates: fixedRates() });

  await assert.rejects(
    repo.payPlannedExpenseForTelegramUser(5, 100, new Date("2026-06-16T09:00:00+07:00"), { occurrenceDate: "2026-06-06" }),
    (error) => error.code === "already_paid"
  );
  assert.ok(!queries.some((query) => String(query.sql).includes("INSERT INTO expenses")));
});

test("paying with occurrenceDate in the future rejects with future_occurrence", async () => {
  const queries = [];
  const repo = createRepository({
    async connect() {
      return fakePayClient({
        planned: {
          id: "5",
          user_id: "1",
          amount: "17000",
          currency: "THB",
          amount_base: "17000",
          description: "сервер",
          category_slug: "subscriptions",
          tags: [],
          recurrence: "monthly",
          due_day: 25,
          due_days: [25],
          base_currency: "THB"
        },
        queries
      });
    }
  }, { exchangeRates: fixedRates() });

  await assert.rejects(
    repo.payPlannedExpenseForTelegramUser(5, 100, new Date("2026-06-16T09:00:00+07:00"), { occurrenceDate: "2026-06-25" }),
    (error) => error.code === "future_occurrence"
  );
  assert.ok(!queries.some((query) => String(query.sql).includes("INSERT INTO expenses")));
});

test("paying with an invalid occurrenceDate rejects with invalid_occurrence", async () => {
  const queries = [];
  const repo = createRepository({
    async connect() {
      return fakePayClient({
        planned: {
          id: "5",
          user_id: "1",
          amount: "17000",
          currency: "THB",
          amount_base: "17000",
          description: "сервер",
          category_slug: "subscriptions",
          tags: [],
          recurrence: "monthly",
          due_day: 6,
          due_days: [6],
          base_currency: "THB"
        },
        queries
      });
    }
  }, { exchangeRates: fixedRates() });

  await assert.rejects(
    repo.payPlannedExpenseForTelegramUser(5, 100, new Date("2026-06-16T09:00:00+07:00"), { occurrenceDate: "2026-06-13" }),
    (error) => error.code === "invalid_occurrence"
  );
  assert.ok(!queries.some((query) => String(query.sql).includes("INSERT INTO expenses")));
});

test("paying a weekly planned expense rejects occurrences before starts_on and accepts later due dates", async () => {
  const queries = [];
  const repo = createRepository({
    async connect() {
      return fakePayClient({
        planned: {
          id: "5",
          user_id: "1",
          amount: "1000",
          currency: "THB",
          amount_base: "1000",
          description: "weekly class",
          category_slug: "education",
          tags: [],
          recurrence: "weekly",
          weekday: 3,
          starts_on: "2026-07-23",
          base_currency: "THB",
          timezone: "Asia/Bangkok"
        },
        queries
      });
    }
  }, { exchangeRates: fixedRates() });

  await assert.rejects(
    repo.payPlannedExpenseForTelegramUser(5, 100, new Date("2026-07-30T09:00:00+07:00"), { occurrenceDate: "2026-07-22" }),
    (error) => error.code === "invalid_occurrence"
  );
  await repo.payPlannedExpenseForTelegramUser(
    5,
    100,
    new Date("2026-07-30T09:00:00+07:00"),
    { occurrenceDate: "2026-07-29" }
  );

  const paymentInsert = queries.find((query) => String(query.sql).includes("INSERT INTO planned_expense_payments"));
  assert.equal(paymentInsert.params[4], "2026-07-29");
});

test("paying a weekly planned expense pays the earliest overdue occurrence", async () => {
  const queries = [];
  const repo = createRepository({
    async connect() {
      return fakePayClient({
        planned: {
          id: "5",
          user_id: "1",
          amount: "1000",
          currency: "THB",
          amount_base: "1000",
          description: "english",
          category_slug: "education",
          tags: [],
          recurrence: "weekly",
          weekday: 3,
          base_currency: "THB"
        },
        queries
      });
    }
  }, { exchangeRates: fixedRates() });

  await repo.payPlannedExpenseForTelegramUser(5, 100, new Date("2026-06-16T09:00:00+07:00"));
  const paymentInsert = queries.find((query) => String(query.sql).includes("INSERT INTO planned_expense_payments"));
  assert.equal(paymentInsert.params[4], "2026-06-03");
});

test("listing planned expenses exposes current-month paid occurrence dates", async () => {
  const repo = createRepository(fakePool((sql) => {
    if (String(sql).includes("array_agg")) {
      return {
        rows: [{
          id: "5",
          amount: "1000",
          currency: "THB",
          amount_base: "1000",
          description: "english",
          category_slug: "education",
          recurrence: "weekly",
          weekday: 3,
          paid_count: 1,
          paid_occurrence_dates: ["2026-06-03"]
        }]
      };
    }
    return { rows: [] };
  }));

  const planned = await repo.listPlannedExpensesForTelegramUser(100);

  assert.deepEqual(planned[0].paid_occurrence_dates, ["2026-06-03"]);
});

test("listing planned expenses only counts payments backed by a matching expense", async () => {
  let listSql = "";
  const repo = createRepository(fakePool((sql) => {
    const query = String(sql);
    if (query.includes("planned_expense_payments")) {
      listSql = query;
      return {
        rows: [{
          id: "5",
          amount: "1000",
          currency: "THB",
          amount_base: "1000",
          description: "Сервер",
          category_slug: "subscriptions",
          recurrence: "monthly",
          due_day: 6,
          due_days: [6],
          paid_count: 0,
          paid_occurrence_dates: [],
          paid_occurrences: {}
        }]
      };
    }
    return { rows: [] };
  }));

  const planned = await repo.listPlannedExpensesForTelegramUser(100);

  assert.match(listSql, /JOIN expenses e ON e\.id = pep\.expense_id/);
  assert.match(listSql, /e\.user_id = pe\.user_id/);
  assert.doesNotMatch(listSql, /spent_at/);
  assert.match(listSql, /paid_occurrences/);
  assert.equal(planned[0].paid_count, 0);
  assert.deepEqual(planned[0].paid_occurrence_dates, []);
});

test("listing planned expenses accepts a date-mismatched same-user expense", async () => {
  let listSql = "";
  const repo = createRepository(fakePool((sql) => {
    const query = String(sql);
    if (query.includes("planned_expense_payments")) {
      listSql = query;
      return {
        rows: [{
          id: "17",
          amount: "300",
          currency: "THB",
          amount_base: "300",
          description: "Simcard",
          category_slug: "subscriptions",
          recurrence: "monthly",
          due_day: 14,
          due_days: [14],
          paid_count: 1,
          paid_occurrence_dates: ["2026-06-14"],
          paid_occurrences: {
            "2026-06-14": {
              expense_id: "187",
              paid_at: "2026-06-15T06:53:14.825Z"
            }
          }
        }]
      };
    }
    return { rows: [] };
  }));

  const planned = await repo.listPlannedExpensesForTelegramUser(222386362);

  assert.match(listSql, /JOIN expenses e ON e\.id = pep\.expense_id/);
  assert.match(listSql, /e\.user_id = pe\.user_id/);
  assert.doesNotMatch(listSql, /spent_at/);
  assert.deepEqual(planned[0].paid_occurrence_dates, ["2026-06-14"]);
  assert.equal(planned[0].paid_occurrences["2026-06-14"].expense_id, "187");
});

test("a planned occurrence stays paid when its linked expense local date differs from occurrence_date", async () => {
  // Regression: PR #34 dropped the spent_at=occurrence_date match from the paid
  // aggregate; PR #61 (daily reminders) re-added it, which silently dropped valid
  // payment rows from paid_count/paid_occurrence_dates so the dashboard kept
  // showing a paid occurrence as overdue and let a duplicate Pay through.
  // planned_expense_payments is the source of truth; expense.spent_at is history
  // placement, not payment validity.
  let listSql = "";
  const repo = createRepository(fakePool((sql) => {
    const query = String(sql);
    if (query.includes("SELECT timezone FROM users")) {
      return { rows: [{ timezone: "Asia/Bangkok" }] };
    }
    if (query.includes("planned_expense_payments")) {
      listSql = query;
      return {
        rows: [{
          id: "5",
          amount: "17000",
          currency: "THB",
          amount_base: "17000",
          description: "Сервер",
          category_slug: "subscriptions",
          recurrence: "monthly",
          due_day: 6,
          due_days: [6],
          active: true,
          timezone: "Asia/Bangkok",
          paid_count: 1,
          paid_occurrence_dates: ["2026-06-06"],
          paid_occurrences: {
            "2026-06-06": { expense_id: "20", paid_at: "2026-06-05T20:00:00.000Z" }
          }
        }]
      };
    }
    return { rows: [] };
  }));

  const planned = await repo.listPlannedExpensesForTelegramUser(100, new Date("2026-06-23T10:00:00+07:00"));

  assert.doesNotMatch(listSql, /spent_at/);
  assert.match(listSql, /JOIN expenses e ON e\.id = pep\.expense_id/);
  assert.match(listSql, /e\.user_id = pe\.user_id/);
  assert.ok(planned[0].paid_occurrence_dates.includes("2026-06-06"));
  assert.equal(planned[0].paid_occurrences["2026-06-06"].expense_id, "20");
});

test("dashboard keeps unpaid twice-monthly occurrences in planned reserve", async () => {
  const repo = createRepository(fakePool((sql) => {
    if (String(sql).startsWith("SELECT * FROM users")) {
      return { rows: [{ id: "1", telegram_user_id: "100", monthly_budget_amount: "45000" }] };
    }
    if (String(sql).includes("planned_expense_payments")) {
      return {
        rows: [{
          id: "5",
          amount: "2000",
          amount_base: "2000",
          currency: "THB",
          description: "therapy",
          category_slug: "health",
          recurrence: "twice_monthly",
          due_days: [4, 18],
          paid_count: 1
        }]
      };
    }
    if (String(sql).includes("COALESCE(SUM(amount_base)")) return { rows: [{ total: 0 }] };
    if (String(sql).includes("FROM expenses") && String(sql).includes("ORDER BY spent_at")) return { rows: [] };
    if (String(sql).includes("GROUP BY category_slug")) return { rows: [] };
    return { rows: [] };
  }));

  const dashboard = await repo.dashboard(100, new Date("2026-06-10T10:00:00+07:00"));

  assert.equal(dashboard.snapshot.plannedRemaining, 2000);
  assert.equal(dashboard.snapshot.freeRemaining, 43000);
});

test("dashboard counts current-month one-off planned expenses when due_date is a Date from pg", async () => {
  const repo = createRepository(dashboardPoolWithPlannedExpenses([{
    id: "26",
    user_id: "1",
    amount: "1234",
    amount_base: "1234",
    currency: "THB",
    description: "one-off",
    category_slug: "other",
    recurrence: "one_off",
    due_date: new Date("2026-06-10T00:00:00.000Z"),
    paid_count: 0,
    paid_occurrence_dates: []
  }]));

  const dashboard = await repo.dashboard(222386362, new Date("2026-06-10T10:00:00+07:00"));

  assert.equal(dashboard.snapshot.plannedRemaining, 1234);
  assert.equal(dashboard.snapshot.freeRemaining, 43766);
});

test("dashboard accepts one-off planned due_date as ISO and local date strings", async () => {
  const repo = createRepository(dashboardPoolWithPlannedExpenses([
    {
      id: "25",
      user_id: "1",
      amount: "1000",
      amount_base: "1000",
      currency: "THB",
      description: "iso one-off",
      category_slug: "other",
      recurrence: "one_off",
      due_date: "2026-06-06T00:00:00.000Z",
      paid_count: 0,
      paid_occurrence_dates: []
    },
    {
      id: "24",
      user_id: "1",
      amount: "2000",
      amount_base: "2000",
      currency: "THB",
      description: "date one-off",
      category_slug: "other",
      recurrence: "one_time",
      due_date: "2026-06-10",
      paid_count: 0,
      paid_occurrence_dates: []
    }
  ]));

  const dashboard = await repo.dashboard(100, new Date("2026-06-10T10:00:00+07:00"));

  assert.equal(dashboard.snapshot.plannedRemaining, 3000);
});

test("dashboard skips invalid one-off planned due_date and logs a safe warning", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const repo = createRepository(dashboardPoolWithPlannedExpenses([{
      id: "27",
      user_id: "1",
      amount: "9999",
      amount_base: "9999",
      currency: "THB",
      description: "bad one-off",
      category_slug: "other",
      recurrence: "one_off",
      due_date: "2026-02-31",
      paid_count: 0,
      paid_occurrence_dates: []
    }]));

    const dashboard = await repo.dashboard(100, new Date("2026-06-10T10:00:00+07:00"));

    assert.equal(dashboard.snapshot.plannedRemaining, 0);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], "Invalid planned expense due_date");
    assert.deepEqual(warnings[0][1], {
      plannedExpenseId: "27",
      userId: "1",
      recurrence: "one_off",
      dueDateType: "string",
      dueDateValue: "2026-02-31"
    });
  } finally {
    console.warn = originalWarn;
  }
});

test("dashboard excludes one-off due_date from a previous month", async () => {
  const repo = createRepository(dashboardPoolWithPlannedExpenses([{
    id: "23",
    user_id: "1",
    amount: "5000",
    amount_base: "5000",
    currency: "THB",
    description: "past one-off",
    category_slug: "other",
    recurrence: "one_off",
    due_date: new Date("2026-05-31T00:00:00.000Z"),
    paid_count: 0,
    paid_occurrence_dates: []
  }]));

  const dashboard = await repo.dashboard(100, new Date("2026-06-10T10:00:00+07:00"));

  assert.equal(dashboard.snapshot.plannedRemaining, 0);
});

test("dashboard keeps monthly weekly and twice-monthly planned calculations unchanged", async () => {
  const repo = createRepository(dashboardPoolWithPlannedExpenses([
    {
      id: "1",
      user_id: "1",
      amount: "100",
      amount_base: "100",
      currency: "THB",
      description: "monthly",
      category_slug: "other",
      recurrence: "monthly",
      due_day: 6,
      due_days: [6],
      paid_count: 0,
      paid_occurrence_dates: []
    },
    {
      id: "2",
      user_id: "1",
      amount: "200",
      amount_base: "200",
      currency: "THB",
      description: "weekly",
      category_slug: "other",
      recurrence: "weekly",
      weekday: 3,
      paid_count: 0,
      paid_occurrence_dates: []
    },
    {
      id: "3",
      user_id: "1",
      amount: "300",
      amount_base: "300",
      currency: "THB",
      description: "twice",
      category_slug: "other",
      recurrence: "twice_monthly",
      due_days: [4, 18],
      paid_count: 0,
      paid_occurrence_dates: []
    }
  ]));

  const dashboard = await repo.dashboard(100, new Date("2026-06-10T10:00:00+07:00"));

  assert.equal(dashboard.snapshot.plannedRemaining, 1500);
});

test("dashboard uses current month override only for the matching calendar month", async () => {
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    if (query.startsWith("SELECT * FROM users")) {
      return {
        rows: [{
          id: "1",
          telegram_user_id: "100",
          monthly_budget_amount: "45000",
          display_currency: "USD",
          usd_thb_rate: "30"
        }]
      };
    }
    if (query.includes("FROM monthly_budget_overrides")) {
      return params[1] === "2026-06"
        ? { rows: [{
            budget_amount_base: "12000",
            is_partial_month: true,
            updated_at: "2026-06-12T03:00:00.000Z"
          }] }
        : { rows: [] };
    }
    if (query.includes("planned_expense_payments")) return { rows: [] };
    if (query.includes("COALESCE(SUM(amount_base)") && query.includes("display_total")) {
      return { rows: [{ total: 3000, display_total: 100 }] };
    }
    if (query.includes("FROM expenses") && query.includes("ORDER BY spent_at")) return { rows: [] };
    if (query.includes("GROUP BY category_slug")) return { rows: [] };
    return { rows: [] };
  }));

  const june = await repo.dashboard(100, new Date("2026-06-23T10:00:00+07:00"));
  const july = await repo.dashboard(100, new Date("2026-07-01T10:00:00+07:00"));

  assert.equal(june.snapshot.monthlyBudget, 12000);
  assert.equal(june.currentMonthBudget.amount, 12000);
  assert.equal(june.currentMonthBudget.isPartialMonth, true);
  assert.equal(june.currentMonthBudget.partialPeriodDays, 19);
  assert.equal(june.snapshot.dayPlanLimit, 1500);
  assert.equal(july.snapshot.monthlyBudget, 45000);
  assert.equal(july.currentMonthBudget.amount, 45000);
  assert.equal(july.currentMonthBudget.isPartialMonth, false);
});

test("dashboard adds active budget top-ups on top of current month override", async () => {
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    if (query.startsWith("SELECT * FROM users")) {
      return {
        rows: [{
          id: "1",
          telegram_user_id: "100",
          monthly_budget_amount: "48000",
          base_currency: "THB",
          display_currency: "USD",
          usd_thb_rate: "30",
          timezone: "Asia/Bangkok"
        }]
      };
    }
    if (query.includes("FROM monthly_budget_overrides")) {
      return {
        rows: [{
          budget_amount_base: "42000",
          is_partial_month: false,
          updated_at: "2026-06-01T00:00:00.000Z"
        }]
      };
    }
    if (query.includes("FROM budget_topups") && query.includes("COALESCE(SUM(amount_base)")) {
      assert.deepEqual(params, ["1", "2026-06"]);
      return { rows: [{ total: 5000 }] };
    }
    if (query.includes("FROM budget_topups") && query.includes("ORDER BY occurred_at DESC")) {
      return {
        rows: [{
          id: "9",
          user_id: "1",
          month_key: "2026-06",
          local_date: "2026-06-20",
          amount_original: "5000",
          currency_original: "THB",
          amount_base: "5000",
          base_currency: "THB",
          converted_amounts: { USD: 166.67, THB: 5000 },
          kind: "income",
          note: "bonus",
          occurred_at: "2026-06-20T10:00:00.000Z"
        }]
      };
    }
    if (query.includes("planned_expense_payments")) return { rows: [] };
    if (query.includes("COALESCE(SUM(amount_base)") && query.includes("display_total")) {
      return {
        rows: [{
          total: 3000,
          regular_total: 3000,
          planned_total: 0,
          large_oneoff_total: 0,
          display_total: 100,
          regular_display_total: 100,
          planned_display_total: 0,
          large_oneoff_display_total: 0
        }]
      };
    }
    if (query.includes("FROM daily_budget_snapshots")) return { rows: [] };
    if (query.includes("INSERT INTO daily_budget_snapshots")) {
      return { rows: [{ budget_amount_base: params[2], budget_display_amount: params[3] }] };
    }
    if (query.includes("FROM expenses") && query.includes("ORDER BY spent_at")) return { rows: [] };
    if (query.includes("GROUP BY category_slug")) return { rows: [] };
    return { rows: [] };
  }));

  const dashboard = await repo.dashboard(100, new Date("2026-06-20T12:00:00+07:00"));

  assert.equal(dashboard.currentMonthBudget.regularMonthlyBudget, 48000);
  assert.equal(dashboard.currentMonthBudget.baseBudget, 42000);
  assert.equal(dashboard.currentMonthBudget.topupsTotal, 5000);
  assert.equal(dashboard.currentMonthBudget.amount, 47000);
  assert.equal(dashboard.currentMonthBudget.topups[0].id, "9");
  assert.equal(dashboard.snapshot.monthlyBudget, 47000);
});

test("dashboard subtracts unpaid planned expenses due this week from weekly remaining", async () => {
  const repo = createRepository(fakePool((sql) => {
    const query = String(sql);
    if (query.startsWith("SELECT * FROM users")) {
      return {
        rows: [{
          id: "1",
          telegram_user_id: "100",
          monthly_budget_amount: "45000",
          weekly_budget_amount: "12000",
          display_currency: "USD",
          usd_thb_rate: "30"
        }]
      };
    }
    if (query.includes("planned_expense_payments")) {
      return {
        rows: [{
          id: "5",
          amount: "2000",
          amount_base: "2000",
          currency: "THB",
          description: "therapy",
          category_slug: "health",
          recurrence: "monthly",
          due_day: 12,
          due_days: [12],
          paid_count: 0
        }]
      };
    }
    if (query.includes("COALESCE(SUM(amount_base)") && query.includes("display_total")) {
      return { rows: [{ total: 3000, display_total: 100 }] };
    }
    if (query.includes("FROM expenses") && query.includes("ORDER BY spent_at")) return { rows: [] };
    if (query.includes("GROUP BY category_slug")) return { rows: [] };
    return { rows: [] };
  }));

  const dashboard = await repo.dashboard(100, new Date("2026-06-10T10:00:00+07:00"));

  assert.equal(dashboard.snapshot.weekPlanLimit, 12000);
  assert.equal(dashboard.snapshot.plannedThisWeek, 2000);
  assert.equal(dashboard.snapshot.weekRemaining, 7000);
});

test("dashboard excludes weekly occurrences before starts_on in the user calendar", async () => {
  const repo = createRepository(dashboardPoolWithPlannedExpenses([{
    id: "5",
    user_id: "1",
    amount: "1000",
    amount_base: "1000",
    currency: "THB",
    description: "weekly class",
    category_slug: "education",
    recurrence: "weekly",
    weekday: 3,
    starts_on: "2026-07-23",
    paid_count: 0,
    paid_occurrence_dates: []
  }], {
    user: { timezone: "Asia/Bangkok", monthly_budget_amount: "45000", weekly_budget_amount: "12000" }
  }));

  const dashboard = await repo.dashboard(100, new Date("2026-07-23T10:00:00+07:00"));

  assert.equal(dashboard.snapshot.plannedRemaining, 1000);
  assert.equal(dashboard.snapshot.plannedThisWeek, 0);
});

test("dashboard excludes current-month paid planned expenses from reserve", async () => {
  const repo = createRepository(fakePool((sql) => {
    if (String(sql).startsWith("SELECT * FROM users")) {
      return { rows: [{ id: "1", telegram_user_id: "100", monthly_budget_amount: "45000" }] };
    }
    if (String(sql).includes("planned_expense_payments")) {
      return {
        rows: [{
          id: "5",
          amount: "17000",
          amount_base: "17000",
          currency: "THB",
          description: "квартира",
          category_slug: "home",
          recurrence: "monthly",
          due_day: 17,
          paid_month: "2026-06"
        }]
      };
    }
    if (String(sql).includes("COALESCE(SUM(amount_base)")) return { rows: [{ total: 0 }] };
    if (String(sql).includes("FROM expenses") && String(sql).includes("ORDER BY spent_at")) return { rows: [] };
    if (String(sql).includes("GROUP BY category_slug")) return { rows: [] };
    return { rows: [] };
  }));

  const dashboard = await repo.dashboard(100, new Date("2026-06-10T10:00:00+07:00"));

  assert.equal(dashboard.snapshot.plannedRemaining, 0);
  assert.equal(dashboard.snapshot.freeRemaining, 45000);
});

test("dashboard returns a factual planned month summary while keeping the planned list active-only", async () => {
  const queries = [];
  const partiallyPaidInactiveWeeklyPlan = {
    id: "5",
    user_id: "1",
    amount_base: "1000",
    recurrence: "weekly",
    weekday: 3,
    active: false,
    validPayments: [{ amount_base: 900 }, { amount_base: 1100 }]
  };
  const activePlan = {
    id: "8",
    user_id: "1",
    amount: "3000",
    amount_base: "3000",
    currency: "THB",
    description: "active rent",
    category_slug: "home",
    recurrence: "monthly",
    due_day: 30,
    due_days: [30],
    active: true,
    paid_count: 0,
    paid_occurrence_dates: [],
    paid_occurrences: {}
  };
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    queries.push({ sql: query, params });
    if (query.startsWith("SELECT * FROM users")) {
      return {
        rows: [{
          id: "1",
          telegram_user_id: "100",
          monthly_budget_amount: "45000",
          base_currency: "THB",
          display_currency: "USD",
          usd_thb_rate: "32.65",
          timezone: "Asia/Bangkok"
        }]
      };
    }
    if (query.includes("FROM planned_expenses") && query.includes("JOIN users")) return { rows: [activePlan] };
    if (query.includes("FROM planned_expense_payments") && query.includes("AS total")) {
      return {
        rows: [{
          total: partiallyPaidInactiveWeeklyPlan.validPayments.reduce(
            (sum, payment) => sum + payment.amount_base,
            0
          )
        }]
      };
    }
    if (query.includes("COALESCE(SUM(amount_base)") && query.includes("FILTER")) {
      return {
        rows: [{
          total: 0,
          regular_total: 0,
          planned_total: 0,
          large_oneoff_total: 0,
          display_total: 0,
          regular_display_total: 0,
          planned_display_total: 0,
          large_oneoff_display_total: 0
        }]
      };
    }
    if (query.includes("COALESCE(SUM(amount_base)") && query.includes("month_key")) return { rows: [{ total: 0 }] };
    if (query.includes("FROM expenses") && query.includes("ORDER BY spent_at")) return { rows: [] };
    if (query.includes("GROUP BY category_slug")) return { rows: [] };
    return { rows: [] };
  }));

  const dashboard = await repo.dashboard(100, new Date("2026-06-10T10:00:00+07:00"));

  assert.deepEqual(dashboard.plannedMonthSummary, {
    paid: 2000,
    remaining: 3000,
    total: 5000,
    display: { currency: "USD", paid: 61.26, remaining: 91.88, total: 153.14 }
  });
  assert.deepEqual(dashboard.plannedExpenses.map((plan) => plan.id), ["8"]);
  const paidQuery = queries.find(({ sql }) => sql.includes("FROM planned_expense_payments") && sql.includes("AS total"));
  assert.ok(paidQuery);
  assert.match(paidQuery.sql, /paid_month = \$2/);
  assert.match(paidQuery.sql, /JOIN planned_expenses/);
  assert.match(paidQuery.sql, /expenses\.user_id = planned_expenses\.user_id/);
  assert.doesNotMatch(paidQuery.sql, /expenses\.spent_at/);
  assert.doesNotMatch(paidQuery.sql, /planned_expenses\.active = true/);
  assert.deepEqual(paidQuery.params, ["1", "2026-06"]);
});

test("planned month summary totals reconcile to their returned rounded components", async () => {
  const repo = createRepository(dashboardPoolWithPlannedExpenses([{
    id: "8",
    user_id: "1",
    amount: "64.53",
    amount_base: "64.53",
    currency: "USD",
    description: "active plan",
    category_slug: "other",
    recurrence: "monthly",
    due_day: 30,
    due_days: [30],
    active: true,
    paid_count: 0,
    paid_occurrence_dates: [],
    paid_occurrences: {}
  }], {
    paidTotal: 2.135,
    user: { base_currency: "USD", display_currency: "USD" }
  }));

  const dashboard = await repo.dashboard(100, new Date("2026-06-10T10:00:00+07:00"));

  assert.equal(dashboard.plannedMonthSummary.paid, 2.13);
  assert.equal(dashboard.plannedMonthSummary.remaining, 64.53);
  assert.equal(dashboard.plannedMonthSummary.total, 66.66);
  assert.equal(
    dashboard.plannedMonthSummary.total,
    dashboard.plannedMonthSummary.paid + dashboard.plannedMonthSummary.remaining
  );
  assert.equal(
    dashboard.plannedMonthSummary.display.total,
    dashboard.plannedMonthSummary.display.paid + dashboard.plannedMonthSummary.display.remaining
  );
  assert.equal(dashboard.snapshot.plannedRemaining, 64.53);
});

test("reserve capacity counts only valid paid occurrences from inactive plans", async () => {
  const queries = [];
  const user = {
    id: "1",
    telegram_user_id: "100",
    monthly_budget_amount: "10000",
    base_currency: "THB",
    timezone: "Asia/Bangkok"
  };
  const query = async (sql, params = []) => {
    const statement = String(sql);
    queries.push({ sql: statement, params });
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)) return { rows: [] };
    if (statement.startsWith("SELECT * FROM users")) return { rows: [user] };
    if (statement.includes("FROM monthly_reserve_instances") && statement.includes("status = 'active'")) {
      return { rows: [{ id: "9", user_id: "1", period: "2026-06", timezone: "Asia/Bangkok", reserve_amount: "1000", status: "active" }] };
    }
    if (statement.includes("COUNT(expenses.id)::int AS paid_count")) {
      const validatesExpenseOwner = /JOIN expenses/.test(statement)
        && /expenses\.user_id = planned_expenses\.user_id/.test(statement);
      return {
        rows: [
          { id: "5", active: false, recurrence: "monthly", due_day: 10, starts_on: "2026-07-01", amount_base: "2000", paid_count: validatesExpenseOwner ? 1 : 2 },
          { id: "6", active: false, recurrence: "monthly", due_day: 20, amount_base: "4000", paid_count: validatesExpenseOwner ? 0 : 1 },
          { id: "7", active: true, recurrence: "monthly", due_day: 30, amount_base: "3000", paid_count: 0 }
        ]
      };
    }
    if (statement.includes("UPDATE users u") && statement.includes("existing_user AS MATERIALIZED")) {
      user.monthly_budget_amount = String(params[0]);
      return { rows: [{ ...user, budget_changed: true }] };
    }
    if (statement.startsWith("UPDATE monthly_reserve_instances")) return { rows: [] };
    if (statement.includes("DELETE FROM daily_budget_snapshots")) return { rows: [] };
    return { rows: [] };
  };
  const repo = createRepository({ query, async connect() { return { query, release() {} }; } });

  await assert.rejects(
    repo.updateMonthlyBudget(100, 5999, new Date("2026-06-10T10:00:00+07:00")),
    (error) => error.code === "reserve_conflicts_with_budget_change"
  );
  await repo.updateMonthlyBudget(100, 6000, new Date("2026-06-10T10:00:00+07:00"));

  const obligationsQuery = queries.find(({ sql }) => sql.includes("COUNT(expenses.id)::int AS paid_count"));
  assert.ok(obligationsQuery);
  assert.match(obligationsQuery.sql, /JOIN expenses/);
  assert.match(obligationsQuery.sql, /expenses\.user_id = planned_expenses\.user_id/);
});

test("dashboard returns USD display totals from converted amounts", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql) => {
    queries.push(String(sql));
    if (String(sql).startsWith("SELECT * FROM users")) {
      return {
        rows: [{
          id: "1",
          telegram_user_id: "100",
          monthly_budget_amount: "45000",
          display_currency: "USD",
          usd_thb_rate: "36",
          daily_entry_reminder_enabled: false
        }]
      };
    }
    if (String(sql).includes("FROM expenses") && String(sql).includes("ORDER BY spent_at")) {
      return {
        rows: [{
          id: "7",
          amount_original: "3600",
          currency_original: "THB",
          amount_base: "3600",
          converted_amounts: { THB: 3600, USD: 100 },
          description: "ужин",
          category_slug: "food_cafe",
          tags: [],
          spent_at: "2026-06-01T10:00:00.000Z"
        }]
      };
    }
    if (String(sql).includes("planned_expense_payments")) return { rows: [] };
    if (String(sql).includes("display_total")) return { rows: [{ total: 3600, display_total: 100 }] };
    if (String(sql).includes("GROUP BY category_slug")) {
      return { rows: [{ category_slug: "food_cafe", total: 3600, display_total: 100 }] };
    }
    return { rows: [] };
  }));

  const dashboard = await repo.dashboard(100, new Date("2026-06-10T10:00:00+07:00"));

  assert.equal(dashboard.snapshot.display.currency, "USD");
  assert.equal(dashboard.snapshot.display.month, 100);
  assert.equal(dashboard.user.daily_entry_reminder_enabled, false);
  assert.equal(dashboard.latestExpenses[0].display.amount, 100);
  assert.equal(dashboard.topCategories[0].display.amount, 100);
  assert.ok(queries.some((query) => query.includes("ORDER BY spent_at") && !query.includes("planned_expense_payments")));
});

test("dashboard separates regular, planned and large one-off daily totals", async () => {
  let totalsCall = 0;
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    if (query.startsWith("SELECT * FROM users")) {
      return {
        rows: [{
          id: "1",
          telegram_user_id: "100",
          monthly_budget_amount: "42000",
          display_currency: "USD",
          usd_thb_rate: "32.6"
        }]
      };
    }
    if (query.includes("FROM daily_budget_snapshots")) {
      return { rows: [{ budget_amount_base: "1417.2", budget_display_amount: "43.47" }] };
    }
    if (query.includes("COALESCE(SUM(amount_base)") && query.includes("FILTER")) {
      assert.equal(params.length, 5);
      totalsCall += 1;
      if (totalsCall === 1) {
        return { rows: [{ total: 3802, regular_total: 802, planned_total: 1000, large_oneoff_total: 2000, display_total: 116.63, regular_display_total: 24.6, planned_display_total: 30.67, large_oneoff_display_total: 61.35 }] };
      }
      if (totalsCall === 2) {
        return { rows: [{ total: 9472.25, regular_total: 6472.25, planned_total: 1000, large_oneoff_total: 2000, display_total: 290.56, regular_display_total: 198.54, planned_display_total: 30.67, large_oneoff_display_total: 61.35 }] };
      }
      return { rows: [{ total: 9772.25, regular_total: 6772.25, planned_total: 1000, large_oneoff_total: 2000, display_total: 299.76, regular_display_total: 207.74, planned_display_total: 30.67, large_oneoff_display_total: 61.35 }] };
    }
    if (query.includes("planned_expense_payments")) return { rows: [] };
    if (query.includes("FROM expenses") && query.includes("ORDER BY spent_at")) return { rows: [] };
    if (query.includes("GROUP BY category_slug")) return { rows: [] };
    return { rows: [] };
  }));

  const dashboard = await repo.dashboard(100, new Date("2026-06-06T20:00:00+07:00"));

  assert.equal(dashboard.snapshot.today, 802);
  assert.equal(dashboard.snapshot.todayTotal, 3802);
  assert.equal(dashboard.snapshot.plannedToday, 1000);
  assert.equal(dashboard.snapshot.largeToday, 2000);
  assert.equal(dashboard.snapshot.dayPlanLimit, 1417.2);
  assert.equal(dashboard.snapshot.dayRemaining, 615.2);
  assert.equal(dashboard.snapshot.month, 9772.25);
  assert.equal(dashboard.snapshot.week, 6472.25);
  assert.equal(dashboard.snapshot.averageDailyRegularSpending, 1295.38);
});

test("dashboard returns analytics blocks for the mini app", async () => {
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    if (query.startsWith("SELECT * FROM users")) {
      return {
        rows: [{
          id: "1",
          telegram_user_id: "100",
          monthly_budget_amount: "45000",
          display_currency: "USD",
          usd_thb_rate: "32.6"
        }]
      };
    }
    if (query.includes("planned_expense_payments")) return { rows: [] };
    if (query.includes("ORDER BY spent_at DESC")) return { rows: [] };
    if (query.includes("GROUP BY category_slug")) {
      return {
        rows: [
          { category_slug: "other", total: 600, display_total: 18.4 },
          { category_slug: "food_cafe", total: 2600, display_total: 79.76 }
        ]
      };
    }
    if (query.includes("ORDER BY amount_base DESC")) {
      return {
        rows: [{ id: "9", amount_base: "1500", amount_original: "1500", currency_original: "THB", converted_amounts: { THB: 1500, USD: 46.01 }, description: "dinner", category_slug: "food_cafe", tags: ["date"], spent_at: params[2] }]
      };
    }
    if (query.includes("unnest(tags)")) {
      return { rows: [{ tag: "date", total: 1500, display_total: 46.01 }] };
    }
    if (query.includes("COALESCE(SUM(amount_base)") && query.includes("display_total")) {
      return { rows: [{ total: 3200, display_total: 98.16 }] };
    }
    if (query.includes("EXTRACT(DAY")) {
      return { rows: [{ day: 1, total: 3200 }] };
    }
    return { rows: [] };
  }));

  const dashboard = await repo.dashboard(100, new Date("2026-06-10T10:00:00+07:00"));

  assert.equal(dashboard.analytics.largestWeek.description, "dinner");
  assert.equal(dashboard.analytics.largestMonth.description, "dinner");
  assert.equal(dashboard.analytics.topTags[0].tag, "date");
  assert.equal(dashboard.analytics.dailyHeatmap[0].day, 1);
  assert.equal(dashboard.analytics.weekComparison.current, 3200);
  assert.equal(dashboard.analytics.otherCategoryWarning.active, true);
});

test("dashboard weekComparison ignores planned and large one-off spending", async () => {
  let totalsCall = 0;
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    if (query.startsWith("SELECT * FROM users")) {
      return {
        rows: [{
          id: "1",
          telegram_user_id: "100",
          monthly_budget_amount: "45000",
          display_currency: "USD",
          usd_thb_rate: "32.6"
        }]
      };
    }
    if (query.includes("COALESCE(SUM(amount_base)") && query.includes("FILTER")) {
      totalsCall += 1;
      if (totalsCall === 1) {
        return { rows: [{ total: 100, regular_total: 100, planned_total: 0, large_oneoff_total: 0, display_total: 3.07, regular_display_total: 3.07, planned_display_total: 0, large_oneoff_display_total: 0 }] };
      }
      if (totalsCall === 2) {
        return { rows: [{ total: 6000, regular_total: 1000, planned_total: 5000, large_oneoff_total: 0, display_total: 184.05, regular_display_total: 30.67, planned_display_total: 153.37, large_oneoff_display_total: 0 }] };
      }
      if (totalsCall === 3) {
        return { rows: [{ total: 6000, regular_total: 1000, planned_total: 5000, large_oneoff_total: 0, display_total: 184.05, regular_display_total: 30.67, planned_display_total: 153.37, large_oneoff_display_total: 0 }] };
      }
      return { rows: [{ total: 11000, regular_total: 2000, planned_total: 9000, large_oneoff_total: 0, display_total: 337.42, regular_display_total: 61.35, planned_display_total: 276.07, large_oneoff_display_total: 0 }] };
    }
    if (query.includes("planned_expense_payments")) return { rows: [] };
    if (query.includes("FROM expenses") && query.includes("ORDER BY")) return { rows: [] };
    if (query.includes("GROUP BY category_slug")) return { rows: [] };
    return { rows: [] };
  }));

  const dashboard = await repo.dashboard(100, new Date("2026-06-10T10:00:00+07:00"));

  assert.equal(dashboard.analytics.weekComparison.current, 1000);
  assert.equal(dashboard.analytics.weekComparison.previous, 2000);
  assert.equal(dashboard.analytics.weekComparison.delta, -1000);
});

test("syncs a valid user timezone and falls back to Bangkok", async () => {
  const calls = [];
  const repo = createRepository(fakePool((sql, params) => {
    calls.push({ sql: String(sql), params });
    return { rows: [{ timezone: params[0] }] };
  }));

  const updated = await repo.syncUserTimezone(100, "Europe/Moscow");
  const fallback = await repo.syncUserTimezone(100, "Not/A_Zone");

  assert.equal(updated.timezone, "Europe/Moscow");
  assert.equal(fallback.timezone, "Asia/Bangkok");
  assert.match(calls[0].sql, /SET timezone/);
});

test("upserts the current reserve and recurring template with explicit scope", async () => {
  const calls = [];
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    calls.push({ query, params });
    if (query.startsWith("SELECT * FROM users")) {
      return { rows: [{ id: "1", telegram_user_id: "100", base_currency: "THB", timezone: "UTC", monthly_budget_amount: "60000" }] };
    }
    if (query.includes("monthly_budget_overrides")) return { rows: [] };
    if (query.includes("FROM planned_expenses")) return { rows: [] };
    if (query.includes("monthly_reserve_instances")) {
      return { rows: [{ id: "9", period: "2026-06", reserve_amount: "4000", status: "active" }] };
    }
    if (query.includes("recurring_reserve_templates")) return { rows: [{ id: "5", is_active: true }] };
    return { rows: [] };
  }));

  const result = await repo.upsertCurrentReserve(100, {
    amount: 4000,
    title: "camera",
    scope: "current_and_future"
  }, new Date("2026-06-10T10:00:00Z"));

  assert.equal(result.reserve.status, "active");
  assert.equal(result.template.is_active, true);
  assert.ok(calls.some((call) => call.query.includes("ON CONFLICT (user_id, period)")));
  assert.ok(calls.some((call) => call.query.includes("ON CONFLICT (user_id)")));
});

test("disables current reserve and recurrence with current_and_future scope", async () => {
  const calls = [];
  const repo = createRepository(fakePool((sql, params) => {
    calls.push({ query: String(sql), params });
    if (String(sql).startsWith("SELECT * FROM users")) {
      return { rows: [{ id: "1", telegram_user_id: "100", timezone: "UTC" }] };
    }
    return { rows: [{ id: "9", status: "disabled", is_active: false }] };
  }));

  const result = await repo.disableCurrentReserve(
    100,
    "current_and_future",
    new Date("2026-06-10T10:00:00Z")
  );

  assert.equal(result.reserve.status, "disabled");
  assert.equal(result.template.is_active, false);
  assert.ok(calls.some((call) => call.query.includes("SET status = 'disabled'")));
  assert.ok(calls.some((call) => call.query.includes("SET is_active = false")));
});

test("acks only reserve events owned by the user", async () => {
  const repo = createRepository(fakePool((sql, params) => {
    assert.match(String(sql), /miniapp_delivered_at = now\(\)/);
    assert.deepEqual(params, [[3, 4], 100]);
    return { rows: [{ id: "3" }, { id: "4" }] };
  }));

  const events = await repo.ackReserveEvents(100, [3, 4]);

  assert.deepEqual(events.map((event) => event.id), ["3", "4"]);
});

test("daily budget snapshot is fixed on day start and does not change after expenses", async () => {
  let storedDayBudget = null;
  let todaySpent = 0;
  const MONTH_BASE = 44035; // month total excluding today's regular spending
  const userRow = {
    id: "1",
    telegram_user_id: "100",
    monthly_budget_amount: "48000",
    base_currency: "THB",
    display_currency: "USD",
    usd_thb_rate: "32.65",
    timezone: "Asia/Bangkok"
  };
  const totalsRow = (total) => ({
    total,
    regular_total: total,
    planned_total: 0,
    large_oneoff_total: 0,
    display_total: 0,
    regular_display_total: 0,
    planned_display_total: 0,
    large_oneoff_display_total: 0
  });
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    if (query.includes("FROM users WHERE telegram_user_id")) return { rows: [userRow] };
    if (query.startsWith("SELECT * FROM users")) return { rows: [userRow] };
    if (query.includes("FROM monthly_budget_overrides")) return { rows: [] };
    if (query.includes("FROM recurring_reserve_templates")) return { rows: [] };
    if (query.includes("FROM closed_reserve_events")) return { rows: [] };
    if (query.includes("FROM month_baselines")) return { rows: [] };
    if (query.includes("FROM daily_budget_snapshots")) {
      return storedDayBudget == null
        ? { rows: [] }
        : { rows: [{ budget_amount_base: storedDayBudget, budget_display_amount: 0 }] };
    }
    if (query.includes("INSERT INTO daily_budget_snapshots")) {
      storedDayBudget = Number(params[2]);
      return { rows: [{ budget_amount_base: params[2], budget_display_amount: params[3] }] };
    }
    if (query.includes("COALESCE(SUM(amount_base)") && query.includes("FILTER")) {
      const spanDays = (Number(params[2]) - Number(params[1])) / (24 * 60 * 60_000);
      if (spanDays >= 20) return { rows: [totalsRow(MONTH_BASE + todaySpent)] };
      return { rows: [totalsRow(todaySpent)] };
    }
    if (query.includes("FROM planned_expenses")) {
      return {
        rows: [{
          id: "5",
          amount_base: "977",
          recurrence: "monthly",
          due_day: 30,
          due_days: [30],
          paid_count: 0,
          paid_occurrence_dates: [],
          paid_occurrences: {}
        }]
      };
    }
    if (query.includes("planned_expense_payments")) return { rows: [] };
    return { rows: [] };
  }));

  const now = new Date("2026-06-24T10:00:00+07:00"); // Bangkok June 24 -> daysLeftInMonth = 7

  todaySpent = 0;
  let dashboard = await repo.dashboard(100, now);
  const fixedDayBudget = dashboard.snapshot.dayPlanLimit;
  assert.equal(storedDayBudget, fixedDayBudget, "snapshot stores the fixed day budget");
  assert.equal(dashboard.snapshot.dailyPlanLimit, 1600, "analytical monthly/day metric stays 48000/30");
  assert.notEqual(dashboard.snapshot.dayPlanLimit, 1600);
  assert.equal(dashboard.snapshot.dayPlanLimit, dashboard.snapshot.safeToSpendPerDay, "created from freeRemaining/daysLeftInMonth");

  todaySpent = 10;
  dashboard = await repo.dashboard(100, now);
  assert.equal(storedDayBudget, fixedDayBudget, "snapshot is not recreated after an expense");
  assert.equal(dashboard.snapshot.dayPlanLimit, fixedDayBudget);
  assert.equal(dashboard.snapshot.dayRemaining, roundBase(fixedDayBudget - 10));
  assert.equal(dashboard.snapshot.dayOverrun, 0);
  assertSummary(dashboard.snapshot, 10, "427", "417");

  todaySpent = 37;
  dashboard = await repo.dashboard(100, now);
  assert.equal(dashboard.snapshot.dayPlanLimit, fixedDayBudget);
  assert.equal(dashboard.snapshot.dayRemaining, roundBase(fixedDayBudget - 37));
  assertSummary(dashboard.snapshot, 37, "427", "390");

  todaySpent = 500;
  dashboard = await repo.dashboard(100, now);
  assert.equal(dashboard.snapshot.dayPlanLimit, fixedDayBudget);
  assert.equal(dashboard.snapshot.dayRemaining, 0);
  assert.equal(dashboard.snapshot.dayOverrun, roundBase(500 - fixedDayBudget));
  const overrunText = formatSavedSummary(500, dashboard.snapshot, { language: "ru" }).replaceAll("\u00a0", " ");
  assert.match(overrunText, /Обычные: <b>500 THB \/ 427 THB<\/b>/);
  assert.match(overrunText, /Перерасход: <b>73 THB<\/b>/);
});

function roundBase(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function assertSummary(snapshot, todaySpent, budgetDisplay, remainingDisplay) {
  const text = formatSavedSummary(todaySpent, snapshot, { language: "ru" }).replaceAll("\u00a0", " ");
  assert.match(text, new RegExp(`Обычные: <b>${todaySpent} THB / ${budgetDisplay} THB</b>`));
  assert.match(text, new RegExp(`Осталось: <b>${remainingDisplay} THB</b>`));
  assert.doesNotMatch(text, /460 THB/);
  assert.doesNotMatch(text, /1 600 THB/);
  assert.doesNotMatch(text, /1 563 THB/);
  assert.doesNotMatch(text, /423 THB/);
}

test("consumes a Telegram input session and target mutation in one transaction", async () => {
  const now = new Date("2026-07-15T12:00:00.000Z");
  const queries = [];
  const session = {
    id: 8,
    user_id: 7,
    status: "active",
    target_type: "draft",
    target_id: 42,
    item_index: 0,
    field: "amount",
    expires_at: new Date("2026-07-15T12:15:00.000Z")
  };
  const client = {
    async query(sql, params = []) {
      const query = String(sql);
      queries.push(query);
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
      if (query.includes("FROM users") && query.includes("FOR UPDATE")) return { rows: [{ id: 7 }] };
      if (query.includes("FROM telegram_input_sessions") && query.includes("FOR UPDATE")) return { rows: [session] };
      if (query.includes("SET status = 'processing'")) return { rows: [{ ...session, status: "processing" }] };
      if (query.includes("UPDATE draft_target")) return { rows: [] };
      if (query.includes("SET status = 'completed'")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${query}`);
    },
    release() {}
  };
  const repo = createRepository({ async connect() { return client; } });

  const result = await repo.consumeTelegramInputSession(100, {
    sessionId: 8,
    now,
    async apply({ session: claimed, client: transactionClient }) {
      assert.equal(claimed.status, "processing");
      await transactionClient.query("UPDATE draft_target SET amount = 120");
    }
  });

  assert.deepEqual(result, { outcome: "completed", session: { ...session, status: "completed" } });
  assert.ok(queries.indexOf("UPDATE draft_target SET amount = 120") < queries.indexOf("COMMIT"));
  assert.ok(queries.findIndex((query) => query.includes("SET status = 'completed'")) < queries.indexOf("COMMIT"));
  assert.equal(queries.filter((query) => query === "COMMIT").length, 1);
});

test("rolls back processing and target changes when session application fails", async () => {
  const queries = [];
  const client = {
    async query(sql) {
      const query = String(sql);
      queries.push(query);
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
      if (query.includes("FROM users") && query.includes("FOR UPDATE")) return { rows: [{ id: 7 }] };
      if (query.includes("FROM telegram_input_sessions") && query.includes("FOR UPDATE")) {
        return { rows: [{ id: 8, user_id: 7, status: "active", expires_at: new Date("2026-07-15T12:15:00.000Z") }] };
      }
      if (query.includes("SET status = 'processing'")) return { rows: [{ id: 8, user_id: 7, status: "processing" }] };
      throw new Error(`Unexpected SQL: ${query}`);
    },
    release() {}
  };
  const repo = createRepository({ async connect() { return client; } });
  const validationError = Object.assign(new Error("invalid amount"), { code: "expense_invalid_amount" });

  await assert.rejects(
    () => repo.consumeTelegramInputSession(100, {
      sessionId: 8,
      now: new Date("2026-07-15T12:00:00.000Z"),
      async apply() { throw validationError; }
    }),
    { code: "expense_invalid_amount" }
  );
  assert.ok(queries.includes("ROLLBACK"));
  assert.ok(!queries.some((query) => query.includes("SET status = 'completed'")));
});

test("consumes the first late input for an expired active Telegram session", async () => {
  const queries = [];
  const session = { id: 8, user_id: 7, status: "active", expires_at: new Date("2026-07-15T12:00:00.000Z") };
  const client = {
    async query(sql) {
      const query = String(sql);
      queries.push(query);
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
      if (query.includes("FROM users") && query.includes("FOR UPDATE")) return { rows: [{ id: 7 }] };
      if (query.includes("FROM telegram_input_sessions") && query.includes("FOR UPDATE")) return { rows: [session] };
      if (query.includes("SET status = 'expired_consumed'")) return { rows: [{ ...session, status: "expired_consumed" }] };
      throw new Error(`Unexpected SQL: ${query}`);
    },
    release() {}
  };
  const repo = createRepository({ async connect() { return client; } });

  const result = await repo.consumeTelegramInputSession(100, { sessionId: 8, now: new Date("2026-07-15T12:01:00.000Z") });

  assert.equal(result.outcome, "expired");
  assert.ok(queries.some((query) => query.includes("SET status = 'expired_consumed'")));
  assert.ok(!queries.some((query) => query.includes("SET status = 'expired_unconsumed'")));
});

test("does not replace a processing Telegram input session with a new edit intent", async () => {
  const queries = [];
  const client = {
    async query(sql) {
      const query = String(sql);
      queries.push(query);
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
      if (query.includes("FROM users") && query.includes("FOR UPDATE")) return { rows: [{ id: 7 }] };
      if (query.includes("FROM telegram_input_sessions") && query.includes("FOR UPDATE")) {
        return { rows: [{ id: 8, status: "processing" }] };
      }
      throw new Error(`Unexpected SQL: ${query}`);
    },
    release() {}
  };
  const repo = createRepository({ async connect() { return client; } });

  const result = await repo.startTelegramInputSession(100, {
    targetType: "draft", targetId: 42, itemIndex: 0, field: "amount", chatId: 100, messageId: 200, language: "ru"
  }, new Date("2026-07-15T12:00:00.000Z"));

  assert.deepEqual(result, { outcome: "input_in_progress" });
  assert.ok(!queries.some((query) => query.includes("INSERT INTO telegram_input_sessions")));
  assert.ok(!queries.some((query) => query.includes("SET status = 'cancelled'")));
});

test("replacing an active Telegram input session returns its prompt reference for cleanup", async () => {
  const previous = {
    id: 8, user_id: 7, status: "active", target_type: "expense", target_id: 42, item_index: null,
    chat_id: 100, message_id: 200, prompt_message_id: 301
  };
  const next = { id: 9, user_id: 7, status: "active", target_type: "expense", target_id: 42, item_index: null };
  const client = {
    async query(sql) {
      const query = String(sql);
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
      if (query.includes("FROM users") && query.includes("FOR UPDATE")) return { rows: [{ id: 7 }] };
      if (query.includes("FROM telegram_input_sessions") && query.includes("FOR UPDATE")) return { rows: [previous] };
      if (query.includes("SET status = 'cancelled'")) return { rows: [{ ...previous, status: "cancelled" }] };
      if (query.includes("INSERT INTO telegram_input_sessions")) return { rows: [next] };
      throw new Error(`Unexpected SQL: ${query}`);
    },
    release() {}
  };
  const repo = createRepository({ async connect() { return client; } });

  const result = await repo.startTelegramInputSession(100, {
    targetType: "expense", targetId: 42, itemIndex: null, field: "description", chatId: 100, messageId: 200, language: "ru"
  }, new Date("2026-07-15T12:00:00.000Z"));

  assert.deepEqual(result, { outcome: "started", session: next, replacedSession: { ...previous, status: "cancelled" } });
});

test("routes only active or unconsumed-expired Telegram input sessions", async () => {
  const queries = [];
  const repo = createRepository(fakePool(async (sql) => {
    const query = String(sql);
    queries.push(query);
    return { rows: [{ id: 8, status: "active" }] };
  }));

  const session = await repo.getRoutableTelegramInputSession(100);

  assert.deepEqual(session, { id: 8, status: "active" });
  assert.match(queries[0], /status IN \('active', 'expired_unconsumed'\)/);
  assert.doesNotMatch(queries[0], /completed/);
});

test("does not cancel a processing Telegram input session", async () => {
  const queries = [];
  const client = {
    async query(sql) {
      const query = String(sql);
      queries.push(query);
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
      if (query.includes("FROM users") && query.includes("FOR UPDATE")) return { rows: [{ id: 7 }] };
      if (query.includes("FROM telegram_input_sessions") && query.includes("FOR UPDATE")) {
        return { rows: [{ id: 8, status: "processing" }] };
      }
      throw new Error(`Unexpected SQL: ${query}`);
    },
    release() {}
  };
  const repo = createRepository({ async connect() { return client; } });

  const result = await repo.cancelTelegramInputSession(100, new Date("2026-07-15T12:00:00.000Z"));

  assert.deepEqual(result, { outcome: "input_in_progress" });
  assert.ok(!queries.some((query) => query.includes("SET status = 'cancelled'")));
});

test("stores a prompt message only on the matching active Telegram input session", async () => {
  const queries = [];
  const active = {
    id: 8,
    user_id: 7,
    status: "active",
    target_type: "expense",
    target_id: 42,
    item_index: null,
    prompt_message_id: null
  };
  const client = {
    async query(sql, params = []) {
      const query = String(sql);
      queries.push({ query, params });
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
      if (query.includes("FROM users") && query.includes("FOR UPDATE")) return { rows: [{ id: 7 }] };
      if (query.includes("FROM telegram_input_sessions") && query.includes("FOR UPDATE")) return { rows: [active] };
      if (query.includes("SET prompt_message_id")) return { rows: [{ ...active, prompt_message_id: 301 }] };
      throw new Error(`Unexpected SQL: ${query}`);
    },
    release() {}
  };
  const repo = createRepository({ async connect() { return client; } });

  const result = await repo.setTelegramInputSessionPrompt(100, 8, {
    targetType: "expense", targetId: 42, itemIndex: null, promptMessageId: 301
  }, new Date("2026-07-15T12:00:00.000Z"));

  assert.deepEqual(result, { outcome: "stored", session: { ...active, prompt_message_id: 301 } });
  assert.ok(queries.some(({ query, params }) => query.includes("SET prompt_message_id") && params.includes(301)));
});

test("closes only the active Telegram input session for the terminal target", async () => {
  const queries = [];
  const active = {
    id: 8,
    user_id: 7,
    status: "active",
    target_type: "draft",
    target_id: 42,
    item_index: 1,
    chat_id: 100,
    message_id: 200,
    prompt_message_id: 301
  };
  const client = {
    async query(sql, params = []) {
      const query = String(sql);
      queries.push({ query, params });
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
      if (query.includes("FROM users") && query.includes("FOR UPDATE")) return { rows: [{ id: 7 }] };
      if (query.includes("FROM telegram_input_sessions") && query.includes("FOR UPDATE")) return { rows: [active] };
      if (query.includes("SET status = 'cancelled'")) return { rows: [{ ...active, status: "cancelled" }] };
      throw new Error(`Unexpected SQL: ${query}`);
    },
    release() {}
  };
  const repo = createRepository({ async connect() { return client; } });

  const result = await repo.closeTelegramInputSessionForTarget(100, {
    targetType: "draft", targetId: 42, itemIndex: 1
  }, new Date("2026-07-15T12:00:00.000Z"));

  assert.deepEqual(result, { outcome: "cancelled", session: { ...active, status: "cancelled" } });
  assert.ok(queries.some(({ query, params }) => query.includes("SET status = 'cancelled'") && params.includes(8)));
});

test("does not close a newer Telegram input session from a stale prompt callback", async () => {
  const queries = [];
  const active = {
    id: 8,
    user_id: 7,
    status: "active",
    target_type: "expense",
    target_id: 42,
    item_index: null
  };
  const client = {
    async query(sql, params = []) {
      const query = String(sql);
      queries.push({ query, params });
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
      if (query.includes("FROM users") && query.includes("FOR UPDATE")) return { rows: [{ id: 7 }] };
      if (query.includes("FROM telegram_input_sessions") && query.includes("FOR UPDATE")) return { rows: [active] };
      throw new Error(`Unexpected SQL: ${query}`);
    },
    release() {}
  };
  const repo = createRepository({ async connect() { return client; } });

  const result = await repo.closeTelegramInputSessionForTarget(100, {
    targetType: "expense", targetId: 42, itemIndex: null, sessionId: 7
  }, new Date("2026-07-15T12:00:00.000Z"));

  assert.deepEqual(result, { outcome: "none" });
  assert.equal(queries.some(({ query }) => query.includes("SET status = 'cancelled'")), false);
});

test("cleans up only terminal Telegram input sessions after the retention window", async () => {
  let received;
  const repo = createRepository(fakePool(async (sql, params) => {
    received = { sql: String(sql), params };
    return { rowCount: 3, rows: [] };
  }));

  const deleted = await repo.deleteOldTelegramInputSessions(new Date("2026-07-16T12:00:00.000Z"));

  assert.equal(deleted, 3);
  assert.match(received.sql, /status IN \('completed', 'cancelled', 'expired_consumed'\)/);
  assert.doesNotMatch(received.sql, /'active'/);
  assert.deepEqual(received.params, [new Date("2026-07-15T12:00:00.000Z")]);
});

test("updates exactly one owned open draft item without changing source text", async () => {
  const queries = [];
  const draft = {
    id: 42,
    user_id: 7,
    status: "pending",
    version: 3,
    source_text: "coffee 10, lunch 20",
    items: [
      { amount: 10, currency: "THB", description: "coffee", category_slug: "food_cafe" },
      { amount: 20, currency: "THB", description: "lunch", category_slug: "food_cafe" }
    ]
  };
  const client = {
    async query(sql, params = []) {
      const query = String(sql);
      queries.push({ query, params });
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
      if (query.includes("FROM drafts") && query.includes("FOR UPDATE")) return { rows: [draft] };
      if (query.includes("UPDATE drafts")) return { rows: [{ ...draft, version: 4, items: params[0] }] };
      throw new Error(`Unexpected SQL: ${query}`);
    },
    release() {}
  };
  const repo = createRepository({ async connect() { return client; } });

  const result = await repo.updateDraftItemForTelegramUser(42, 1, 100, { amount: 15, currency: "USD" }, { expectedVersion: 3 });

  assert.equal(result.items[0].amount, 10);
  assert.equal(result.items[1].amount, 15);
  assert.equal(result.items[1].currency, "USD");
  assert.equal(result.source_text, "coffee 10, lunch 20");
  const update = queries.find(({ query }) => query.includes("UPDATE drafts"));
  assert.doesNotMatch(update.query, /source_text/);
  assert.equal(JSON.parse(update.params[0])[0].amount, 10);
  assert.equal(JSON.parse(update.params[0])[1].amount, 15);
});

test("rejects stale or invalid draft item updates with stable domain codes", async () => {
  const draft = { id: 42, user_id: 7, status: "pending", version: 4, items: [] };
  const client = {
    async query(sql) {
      const query = String(sql);
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
      if (query.includes("FROM drafts") && query.includes("FOR UPDATE")) return { rows: [draft] };
      throw new Error(`Unexpected SQL: ${query}`);
    },
    release() {}
  };
  const repo = createRepository({ async connect() { return client; } });

  await assert.rejects(
    () => repo.updateDraftItemForTelegramUser(42, 0, 100, { amount: 15 }, { expectedVersion: 3 }),
    { code: "expense_edit_conflict" }
  );
});

function fakePool(handler) {
  return {
    async query(sql, params = []) {
      return handler(sql, params);
    }
  };
}

function confirmAccountDeletionRepository({
  request = { source: "telegram", stage: "awaiting_text", expires_at: new Date("2026-07-09T10:15:00.000Z") },
  failAudit = false,
  failRollback = false
} = {}) {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      const query = String(sql);
      queries.push({ sql: query, params });
      if (query === "ROLLBACK" && failRollback) throw new Error("rollback failed");
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
      if (/SELECT \* FROM users WHERE telegram_user_id = \$1 FOR UPDATE/i.test(query)) {
        return { rows: [{ id: 42, telegram_user_id: params[0] }] };
      }
      if (/SELECT \* FROM account_deletion_requests/i.test(query)) {
        return {
          rows: [{
            id: 7,
            user_id: 42,
            status: "pending",
            ...request
          }]
        };
      }
      if (/DELETE FROM app_events/i.test(query)) return { rowCount: 3, rows: [] };
      if (/DELETE FROM feedback/i.test(query)) return { rowCount: 2, rows: [] };
      if (/DELETE FROM release_note_deliveries/i.test(query)) return { rowCount: 1, rows: [] };
      if (/INSERT INTO app_events/i.test(query)) {
        if (failAudit) throw new Error("audit failed");
        return { rowCount: 1, rows: [] };
      }
      if (/DELETE FROM users/i.test(query)) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected SQL: ${query}`);
    },
    release() {}
  };
  return {
    queries,
    repository: createRepository({ async connect() { return client; } })
  };
}

function fakeConfirmClient({ draftRow, onQuery = () => {} }) {
  return {
    async query(sql, params = []) {
      const query = String(sql);
      onQuery(query);
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
      if (query.includes("FOR UPDATE")) return { rows: [draftRow] };
      if (query.includes("INSERT INTO expenses")) return { rows: [{ id: 100, draft_id: draftRow.id, amount_base: params[3] ?? 80 }] };
      if (query.includes("status = 'confirmed'")) return { rows: [draftRow] };
      return { rows: [] };
    },
    release() {}
  };
}

function dashboardPoolWithPlannedExpenses(plannedExpenses, options = {}) {
  return fakePool((sql) => {
    const query = String(sql);
    if (query.startsWith("SELECT * FROM users")) {
      return {
        rows: [{
          id: "1",
          telegram_user_id: "100",
          monthly_budget_amount: "45000",
          display_currency: "USD",
          usd_thb_rate: "30",
          ...options.user
        }]
      };
    }
    if (query.includes("FROM planned_expenses") && query.includes("JOIN users")) return { rows: plannedExpenses };
    if (query.includes("FROM planned_expense_payments") && query.includes("AS total")) {
      return { rows: [{ total: options.paidTotal ?? 0 }] };
    }
    if (query.includes("planned_expense_payments")) return { rows: plannedExpenses };
    if (query.includes("COALESCE(SUM(amount_base)") && query.includes("display_total")) {
      return { rows: [{ total: 0, display_total: 0 }] };
    }
    if (query.includes("FROM expenses") && query.includes("ORDER BY spent_at")) return { rows: [] };
    if (query.includes("GROUP BY category_slug")) return { rows: [] };
    return { rows: [] };
  });
}

function fakePayClient({ planned, paidOccurrences = [], queries = [] }) {
  return {
    async query(sql, params = []) {
      queries.push({ sql, params });
      const query = String(sql);
      if (query.includes("SELECT planned_expenses.*, users.base_currency")) {
        return { rows: [planned] };
      }
      if (query.includes("pep.occurrence_date")) {
        return { rows: paidOccurrences };
      }
      if (query.includes("INSERT INTO expenses")) {
        return {
          rows: [{
            id: "20",
            amount_original: params[1],
            currency_original: params[2],
            amount_base: params[3],
            description: params[8],
            category_slug: params[9]
          }]
        };
      }
      if (query.includes("INSERT INTO planned_expense_payments")) return { rows: [{ id: "9" }] };
      return { rows: [] };
    },
    release() {}
  };
}

function fixedRates() {
  return {
    async ratesFor() {
      return {
        source: "test-rates",
        THB: { THB: 1 },
        USD: { THB: 32.6 },
        RUB: { THB: 0.36 },
        IDR: { THB: 32.6 / 16200 }
      };
    }
  };
}

test("prepareDraftPreview converts dated items sequentially with their own rates", async () => {
  const dates = [];
  const exchangeRates = {
    async ratesFor(date) {
      const key = date.toISOString().slice(0, 10);
      dates.push(key);
      return key === "2026-06-01"
        ? { source: "test-rates", THB: { THB: 1 }, USD: { THB: 32 }, RUB: { THB: 0.4 }, IDR: { THB: 0.002 }, BYN: { THB: 10 }, EUR: { THB: 36 }, GEL: { THB: 12 } }
        : { source: "test-rates", THB: { THB: 1 }, USD: { THB: 33 }, RUB: { THB: 0.4 }, IDR: { THB: 0.002 }, BYN: { THB: 10 }, EUR: { THB: 36 }, GEL: { THB: 12 } };
    }
  };
  const repo = createRepository(fakePool(() => ({ rows: [] })), { exchangeRates });

  const preview = await repo.prepareDraftPreview([
    { amount: 10, currency: "USD", spent_at: "2026-06-01T10:00:00.000Z" },
    { amount: 20, currency: "USD", spent_at: "2026-06-02T10:00:00.000Z" }
  ], { base_currency: "THB" });

  assert.deepEqual(dates, ["2026-06-01", "2026-06-02"]);
  assert.deepEqual(preview, { kind: "converted", baseCurrency: "THB", total: 980 });
});

test("prepareDraftPreview supports every currency as its base currency", async () => {
  const exchangeRates = {
    async ratesFor() {
      return { source: "test-rates", THB: { THB: 1 }, USD: { THB: 32 }, RUB: { THB: 0.4 }, IDR: { THB: 0.002 }, BYN: { THB: 10 }, EUR: { THB: 36 }, GEL: { THB: 12 } };
    }
  };
  const repo = createRepository(fakePool(() => ({ rows: [] })), { exchangeRates });

  for (const baseCurrency of ["THB", "USD", "RUB", "IDR", "BYN", "EUR", "GEL"]) {
    const preview = await repo.prepareDraftPreview([
      { amount: 12.34, currency: baseCurrency, spent_at: "2026-06-01T10:00:00.000Z" }
    ], { base_currency: baseCurrency });
    assert.deepEqual(preview, { kind: "converted", baseCurrency, total: 12.34 });
  }
});

test("prepareDraftPreview returns unavailable only for unavailable exchange rates", async () => {
  const unavailable = Object.assign(new Error("rates unavailable"), { code: "exchange_rate_unavailable" });
  const unavailableRepo = createRepository(fakePool(() => ({ rows: [] })), {
    exchangeRates: { async ratesFor() { throw unavailable; } }
  });
  const item = { amount: 10, currency: "USD", spent_at: "2026-06-01T10:00:00.000Z" };

  assert.deepEqual(
    await unavailableRepo.prepareDraftPreview([item], { base_currency: "EUR" }),
    { kind: "unavailable", baseCurrency: "EUR" }
  );

  const genericError = new Error("unexpected provider failure");
  const genericFailureRepo = createRepository(fakePool(() => ({ rows: [] })), {
    exchangeRates: { async ratesFor() { throw genericError; } }
  });
  await assert.rejects(() => genericFailureRepo.prepareDraftPreview([item]), genericError);
});

test("prepareDraftPreview matches amount_base saved by saveDraftAsExpense at presentation precision", async () => {
  const rates = { source: "test-rates", THB: { THB: 1 }, USD: { THB: 32.65 }, RUB: { THB: 0.4 }, IDR: { THB: 0.002 }, BYN: { THB: 10 }, EUR: { THB: 36 }, GEL: { THB: 12 } };
  const exchangeRates = { async ratesFor() { return rates; } };
  const items = [
    { amount: 10, currency: "USD", description: "coffee", category_slug: "food_cafe", budget_impact: "regular", needs_review: false, category_source: "parser", tags: [], spent_at: "2026-06-01T10:00:00.000Z" },
    { amount: 20, currency: "EUR", description: "lunch", category_slug: "food_cafe", budget_impact: "regular", needs_review: false, category_source: "parser", tags: [], spent_at: "2026-06-02T10:00:00.000Z" }
  ];
  const insertedAmountBases = [];
  const client = {
    async query(sql, params = []) {
      const query = String(sql);
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
      if (query.includes("FOR UPDATE")) return { rows: [{ id: 7, user_id: 1, status: "pending", base_currency: "THB", items }] };
      if (query.includes("INSERT INTO expenses")) {
        insertedAmountBases.push(params[4]);
        return { rows: [{ id: insertedAmountBases.length, amount_base: params[4] }] };
      }
      if (query.includes("status = 'confirmed'")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${query}`);
    },
    release() {}
  };
  const pool = {
    async connect() { return client; },
    async query() { return { rows: [] }; }
  };
  const repo = createRepository(pool, { exchangeRates });
  repo.dashboard = async () => ({ snapshot: { baseCurrency: "THB" } });

  const preview = await repo.prepareDraftPreview(items, { base_currency: "THB" });
  await repo.saveDraftAsExpense(7, 100);

  const savedTotal = insertedAmountBases.reduce((sum, amountBase) => sum + Number(amountBase), 0);
  assert.equal(
    repositoryModule.normalizeMoneyForCurrency(preview.total, "THB"),
    repositoryModule.normalizeMoneyForCurrency(savedTotal, "THB")
  );
});

test("normalizeDraftItem preserves category_source parser/user and defaults to null", async () => {
  const { createRepository } = await import("../src/repository.js");
  let captured;
  const repo = createRepository(fakePool((sql, params) => {
    captured = JSON.parse(params[0]);
    return { rows: [{ id: 1, status: "pending", items: params[0], version: 2 }] };
  }));
  await repo.updateDraftItems(1, 100, [
    { amount: 10, currency: "THB", description: "x", category_slug: "food_cafe", category_source: "parser" },
    { amount: 20, currency: "THB", description: "y", category_slug: "other" }
  ]);
  assert.equal(captured[0].category_source, "parser");
  assert.equal(captured[1].category_source, null);
});

test("isCategoryValid distinguishes parser-other, user-other and confident categories", async () => {
  const { isCategoryValid } = await import("../src/repository.js");
  assert.equal(isCategoryValid({ category_slug: "food_cafe", needs_review: false, category_source: "parser" }), true);
  assert.equal(isCategoryValid({ category_slug: "other", needs_review: true, category_source: "parser" }), false);
  assert.equal(isCategoryValid({ category_slug: "other", needs_review: false, category_source: "parser" }), false);
  assert.equal(isCategoryValid({ category_slug: "other", needs_review: false, category_source: "user" }), true);
  assert.equal(isCategoryValid({ category_slug: "other", needs_review: false, category_source: null }), false);
});

test("saveDraftAsExpense confirms an open draft and returns alreadySaved false", async () => {
  const { createRepository } = await import("../src/repository.js");
  const queries = [];
  const client = fakeConfirmClient({
    draftRow: { id: 7, user_id: 1, status: "pending", base_currency: "THB", usd_thb_rate: 32.65,
      items: [{ amount: 80, currency: "THB", description: "coffee", category_slug: "food_cafe", budget_impact: "regular", needs_review: false, category_source: "parser", tags: [], spent_at: "2026-06-25T10:00:00Z" }] },
    onQuery: (q) => queries.push(String(q))
  });
  const repo = createRepository({ ...fakePool(() => ({ rows: [] })), async connect() { return client; } });
  repo.dashboard = async () => ({ snapshot: { baseCurrency: "THB", month: 0, monthlyBudget: 45000, freeRemaining: 45000, plannedRemaining: 0, forecastMonthTotal: 0, today: 0, planDeviation: 0 } });

  const result = await repo.saveDraftAsExpense(7, 100);

  assert.equal(result.alreadySaved, false);
  assert.ok(Array.isArray(result.expenses) && result.expenses.length === 1);
  assert.equal(result.dashboardSnapshot.baseCurrency, "THB");
  assert.ok(queries.some((q) => q.includes("FOR UPDATE")));
  assert.ok(queries.some((q) => q.includes("status = 'confirmed'") && q.includes("version = version + 1")));
});

test("saveDraftAsExpense preserves a saved open draft when its dashboard snapshot is unavailable", async () => {
  const { createRepository } = await import("../src/repository.js");
  const queries = [];
  const client = fakeConfirmClient({
    draftRow: { id: 7, user_id: 1, status: "pending", base_currency: "THB", usd_thb_rate: 32.65,
      items: [{ amount: 80, currency: "THB", description: "coffee", category_slug: "food_cafe", budget_impact: "regular", needs_review: false, category_source: "parser", tags: [], spent_at: "2026-06-25T10:00:00Z" }] },
    onQuery: (q) => queries.push(String(q))
  });
  const repo = createRepository({ ...fakePool(() => ({ rows: [] })), async connect() { return client; } });
  repo.dashboard = async () => { throw new Error("snapshot unavailable"); };
  const originalWarn = console.warn;
  let warning;
  console.warn = (...args) => { warning = args; };

  let result;
  try {
    result = await repo.saveDraftAsExpense(7, 100);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.alreadySaved, false);
  assert.equal(result.expenses.length, 1);
  assert.equal(result.dashboardSnapshot, null);
  assert.ok(queries.includes("COMMIT"));
  assert.deepEqual(warning, [
    "[repository] dashboard snapshot unavailable after draft confirmation",
    { draftId: 7, error: "snapshot unavailable" }
  ]);
});

test("saveDraftAsExpense returns existing expenses when already confirmed", async () => {
  const { createRepository } = await import("../src/repository.js");
  const client = fakeConfirmClient({ draftRow: { id: 7, user_id: 1, status: "confirmed", items: [], base_currency: "THB" } });
  let expensesQueried = false;
  const pool = {
    async connect() { return client; },
    async query(sql) { if (String(sql).includes("FROM expenses WHERE draft_id")) { expensesQueried = true; return { rows: [{ id: 99, draft_id: 7 }] }; } return { rows: [] }; }
  };
  const repo = createRepository(pool);
  repo.dashboard = async () => { throw new Error("snapshot unavailable"); };

  const result = await repo.saveDraftAsExpense(7, 100);

  assert.equal(result.alreadySaved, true);
  assert.equal(result.expenses.length, 1);
  assert.equal(result.dashboardSnapshot, null);
  assert.equal(expensesQueried, true);
});

test("saveDraftAsExpense throws DraftCanceledError on a cancelled draft", async () => {
  const { createRepository, DraftCanceledError } = await import("../src/repository.js");
  const client = fakeConfirmClient({ draftRow: { id: 7, user_id: 1, status: "cancelled", items: [], base_currency: "THB" } });
  const repo = createRepository({ ...fakePool(() => ({ rows: [] })), async connect() { return client; } });
  repo.dashboard = async () => ({ snapshot: {} });

  await assert.rejects(() => repo.saveDraftAsExpense(7, 100), (err) => err instanceof DraftCanceledError);
});

test("saveDraftAsExpense blocks parser-provided other even if needs_review is accidentally false", async () => {
  const { createRepository, CategoryRequiredError } = await import("../src/repository.js");
  const queries = [];
  const client = fakeConfirmClient({
    draftRow: { id: 7, user_id: 1, status: "pending", base_currency: "THB",
      items: [{ amount: 80, currency: "THB", description: "x", category_slug: "other", needs_review: false, category_source: "parser", budget_impact: "regular", tags: [], spent_at: "2026-06-25T10:00:00Z" }] },
    onQuery: (q) => queries.push(String(q))
  });
  const repo = createRepository({ ...fakePool(() => ({ rows: [] })), async connect() { return client; } });
  repo.dashboard = async () => ({ snapshot: {} });

  await assert.rejects(() => repo.saveDraftAsExpense(7, 100), (err) => err instanceof CategoryRequiredError);
  assert.ok(!queries.some((q) => q.includes("INSERT INTO expenses")));
});

test("cancelDraft cancels an open draft and returns canceled true", async () => {
  const { createRepository } = await import("../src/repository.js");
  let query;
  const repo = createRepository(fakePool((sql) => { query = String(sql); return { rows: [{ id: 7, status: "cancelled" }] }; }));
  const result = await repo.cancelDraft(7, 100);
  assert.equal(result.canceled, true);
  assert.match(query, /status = 'cancelled'/);
  assert.match(query, /cancelled_at = now\(\)/);
  assert.match(query, /version = version \+ 1/);
  assert.match(query, /status IN \('pending', 'inbox'\)/);
});

test("cancelDraft on a confirmed draft is a no-op that reports already_confirmed", async () => {
  const { createRepository } = await import("../src/repository.js");
  const pool = {
    async query(sql) {
      const q = String(sql);
      if (q.includes("RETURNING")) return { rows: [] };   // CAS matched 0 rows (status not open)
      return { rows: [{ status: "confirmed" }] };          // re-read
    }
  };
  const repo = createRepository(pool);
  const result = await repo.cancelDraft(7, 100);
  assert.equal(result.canceled, false);
  assert.equal(result.reason, "already_confirmed");
});

test("updateDraftItems bumps version", async () => {
  const { createRepository } = await import("../src/repository.js");
  let query;
  const repo = createRepository(fakePool((sql) => { query = String(sql); return { rows: [{ id: 1, status: "pending", items: "[]", version: 2 }] }; }));
  await repo.updateDraftItems(1, 100, [{ amount: 10, currency: "THB", description: "x", category_slug: "food_cafe" }]);
  assert.match(query, /version = version \+ 1/);
});

test("updateDraftItems applies expectedVersion guard when provided", async () => {
  const { createRepository } = await import("../src/repository.js");
  let params;
  const repo = createRepository(fakePool((sql, p) => { params = p; return { rows: [] }; }));
  await repo.updateDraftItems(1, 100, [{ amount: 10, currency: "THB", description: "x", category_slug: "food_cafe" }], { expectedVersion: 3 });
  assert.equal(params[3], 3);
});

test("moveDraftToInbox only acts on open drafts and bumps version", async () => {
  const { createRepository } = await import("../src/repository.js");
  let query;
  const repo = createRepository(fakePool((sql) => { query = String(sql); return { rows: [] }; }));
  await repo.moveDraftToInbox(1, 100);
  assert.match(query, /status IN \('pending', 'inbox'\)/);
  assert.match(query, /version = version \+ 1/);
});

test("setDraftMessageRef writes tg_chat_id and tg_message_id", async () => {
  const { createRepository } = await import("../src/repository.js");
  let params;
  const repo = createRepository(fakePool((sql, p) => { params = p; return { rows: [] }; }));
  await repo.setDraftMessageRef(7, 100, 555, 999);
  assert.equal(params[0], 7);
  assert.equal(params[2], 555);
  assert.equal(params[3], 999);
});

test("createBudgetTopupDraft expires existing pending top-up drafts transactionally", async () => {
  const { createRepository } = await import("../src/repository.js");
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql: String(sql), params });
      const query = String(sql);
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
      if (query.includes("INSERT INTO budget_topup_drafts")) {
        return { rows: [{ id: "11", user_id: params[0], status: "pending", source_text: params[1], item: JSON.parse(params[2]) }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const repo = createRepository({ async connect() { return client; } });

  const draft = await repo.createBudgetTopupDraft(1, "bonus 5000", { amount: 5000, currency: "THB" }, new Date("2026-06-30T10:00:00Z"));

  assert.equal(draft.id, "11");
  assert.ok(queries.some((q) => q.sql === "BEGIN"));
  assert.ok(queries.some((q) => q.sql.includes("FROM users") && q.sql.includes("FOR UPDATE")));
  assert.ok(queries.some((q) => q.sql.includes("UPDATE budget_topup_drafts") && q.sql.includes("status = 'expired'")));
  assert.ok(queries.some((q) => q.sql === "COMMIT"));
});

test("createBudgetTopupDraft serializes by locking the owning user before insert", async () => {
  const { createRepository } = await import("../src/repository.js");
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql: String(sql), params });
      const query = String(sql);
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
      if (query.includes("FROM users") && query.includes("FOR UPDATE")) return { rows: [{ id: params[0] }] };
      if (query.includes("INSERT INTO budget_topup_drafts")) {
        return { rows: [{ id: "12", user_id: params[0], status: "pending", source_text: params[1], item: JSON.parse(params[2]) }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const repo = createRepository({ async connect() { return client; } });

  await repo.createBudgetTopupDraft(1, "bonus 5000", { amount: 5000, currency: "THB" });

  const userLockIndex = queries.findIndex((q) => q.sql.includes("FROM users") && q.sql.includes("FOR UPDATE"));
  const expireIndex = queries.findIndex((q) => q.sql.includes("UPDATE budget_topup_drafts") && q.sql.includes("status = 'expired'"));
  const insertIndex = queries.findIndex((q) => q.sql.includes("INSERT INTO budget_topup_drafts"));
  assert.ok(userLockIndex > -1, "expected user row lock");
  assert.ok(userLockIndex < expireIndex, "expected user lock before expiring pending drafts");
  assert.ok(expireIndex < insertIndex, "expected old pending drafts expired before insert");
});

test("cancelBudgetTopupDraft is idempotent", async () => {
  const { createRepository } = await import("../src/repository.js");
  const repo = createRepository(fakePool((sql) => {
    const query = String(sql);
    if (query.includes("UPDATE budget_topup_drafts")) return { rows: [] };
    if (query.includes("SELECT status FROM budget_topup_drafts")) return { rows: [{ status: "cancelled" }] };
    return { rows: [] };
  }));

  const result = await repo.cancelBudgetTopupDraft(11, 100);

  assert.equal(result.cancelled, false);
  assert.equal(result.reason, "already_cancelled");
});

test("confirmBudgetTopupDraft creates one top-up and updates budget-dependent state", async () => {
  const { createRepository } = await import("../src/repository.js");
  const queries = [];
  const draftItem = {
    amount: 5000,
    currency: "THB",
    kind: "income",
    note: "bonus",
    occurred_at: "2026-06-30T10:00:00.000Z",
    local_date: "2026-06-30",
    month_key: "2026-06"
  };
  const client = {
    async query(sql, params = []) {
      queries.push({ sql: String(sql), params });
      const query = String(sql);
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
      if (query.includes("SELECT budget_topup_drafts.*")) {
        return {
          rows: [{
            id: "11",
            user_id: "1",
            status: "pending",
            source_text: "bonus 5000",
            item: draftItem,
            created_at: "2026-06-30T09:00:00.000Z",
            base_currency: "THB",
            display_currency: "USD",
            usd_thb_rate: "30",
            monthly_budget_amount: "48000",
            timezone: "Asia/Bangkok"
          }]
        };
      }
      if (query.includes("INSERT INTO budget_topups")) {
        return {
          rows: [{
            id: "20",
            user_id: "1",
            draft_id: "11",
            month_key: "2026-06",
            local_date: "2026-06-30",
            amount_original: "5000",
            currency_original: "THB",
            amount_base: "5000",
            base_currency: "THB",
            converted_amounts: { THB: 5000, USD: 166.67 },
            exchange_rate_source: "test-rates",
            kind: "income",
            note: "bonus",
            occurred_at: "2026-06-30T10:00:00.000Z"
          }]
        };
      }
      if (query.includes("FROM monthly_budget_overrides")) return { rows: [] };
      if (query.includes("FROM budget_topups") && query.includes("SUM(amount_base)")) return { rows: [{ total: 5000 }] };
      if (query.includes("FROM budget_topups") && query.includes("ORDER BY occurred_at DESC")) return { rows: [] };
      return { rows: [] };
    },
    release() {}
  };
  const repo = createRepository({
    async connect() { return client; },
    async query(sql, params = []) {
      queries.push({ sql: String(sql), params });
      return { rows: [] };
    }
  }, { exchangeRates: fixedRates() });
  repo.dashboard = async () => ({ snapshot: { baseCurrency: "THB", monthlyBudget: 53000, freeRemaining: 53000 } });

  const result = await repo.confirmBudgetTopupDraft(11, 100, new Date("2026-06-30T10:00:00Z"));

  assert.equal(result.alreadySaved, false);
  assert.equal(result.topup.id, "20");
  assert.equal(result.currentMonthBudget.amount, 53000);
  assert.ok(queries.some((q) => q.sql.includes("UPDATE budget_topup_drafts SET status = 'confirmed'")));
  assert.ok(queries.some((q) => q.sql.includes("UPDATE monthly_reserve_instances")));
  assert.ok(queries.some((q) => q.sql.includes("DELETE FROM daily_budget_snapshots")));
  const reserveIndex = queries.findIndex((q) => q.sql.includes("UPDATE monthly_reserve_instances"));
  const snapshotIndex = queries.findIndex((q) => q.sql.includes("DELETE FROM daily_budget_snapshots"));
  const commitIndex = queries.findIndex((q) => q.sql === "COMMIT");
  assert.ok(reserveIndex > -1 && reserveIndex < commitIndex, "expected reserve update before commit");
  assert.ok(snapshotIndex > -1 && snapshotIndex < commitIndex, "expected snapshot invalidation before commit");
});

test("confirmBudgetTopupDraft rejects previous-month top-ups in the MVP", async () => {
  const { createRepository } = await import("../src/repository.js");
  const queries = [];
  const draftItem = {
    amount: 5000,
    currency: "THB",
    kind: "income",
    occurred_at: "2026-06-30T17:00:00.000Z",
    local_date: "2026-06-30",
    month_key: "2026-06"
  };
  const client = {
    async query(sql, params = []) {
      queries.push({ sql: String(sql), params });
      const query = String(sql);
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
      if (query.includes("SELECT budget_topup_drafts.*")) {
        return {
          rows: [{
            id: "11",
            user_id: "1",
            status: "pending",
            source_text: "I got 5000 yesterday",
            item: draftItem,
            created_at: "2026-07-01T01:00:00.000+07:00",
            base_currency: "THB",
            display_currency: "USD",
            usd_thb_rate: "30",
            monthly_budget_amount: "48000",
            timezone: "Asia/Bangkok"
          }]
        };
      }
      return { rows: [] };
    },
    release() {}
  };
  const repo = createRepository({ async connect() { return client; } });

  const result = await repo.confirmBudgetTopupDraft(11, 100, new Date("2026-07-01T01:00:00+07:00"));

  assert.equal(result.outcome, "wrong_month");
  assert.equal(result.targetMonthKey, "2026-06");
  assert.ok(queries.some((q) => q.sql === "ROLLBACK"));
  assert.ok(!queries.some((q) => q.sql.includes("INSERT INTO budget_topups")));
});

test("previewBudgetTopup uses target-month override and base currency conversion for large warning", async () => {
  const { createRepository } = await import("../src/repository.js");
  const queries = [];
  const repo = createRepository(fakePool((sql, params = []) => {
    queries.push({ sql: String(sql), params });
    const query = String(sql);
    if (query.includes("SELECT * FROM users")) {
      return {
        rows: [{
          id: "1",
          telegram_user_id: "100",
          monthly_budget_amount: "48000",
          base_currency: "THB",
          display_currency: "USD",
          usd_thb_rate: "30",
          timezone: "Asia/Bangkok"
        }]
      };
    }
    if (query.includes("FROM monthly_budget_overrides")) {
      return { rows: [{ budget_amount_base: "2000", is_partial_month: false, created_at: "2026-06-01T00:00:00Z" }] };
    }
    if (query.includes("FROM budget_topups") && query.includes("SUM(amount_base)")) return { rows: [{ total: 0 }] };
    if (query.includes("FROM budget_topups") && query.includes("ORDER BY occurred_at DESC")) return { rows: [] };
    return { rows: [] };
  }), { exchangeRates: fixedRates() });

  const preview = await repo.previewBudgetTopup(1, {
    amount: 300,
    currency: "USD",
    occurred_at: "2026-06-20T10:00:00.000Z",
    month_key: "2026-06"
  }, new Date("2026-06-20T10:00:00Z"));

  assert.equal(preview.amountBase, 9780);
  assert.equal(preview.baseBudget, 2000);
  assert.equal(preview.large, true);
  assert.equal(preview.monthKey, "2026-06");
});

test("undoBudgetTopup soft deletes a recent top-up and refreshes budget-dependent state", async () => {
  const { createRepository } = await import("../src/repository.js");
  const queries = [];
  const queriesByClient = [];
  const client = {
    async query(sql, params = []) {
      queriesByClient.push({ sql: String(sql), params });
      return handleQuery(sql, params);
    },
    release() {}
  };
  function handleQuery(sql, params = []) {
    queries.push({ sql: String(sql), params });
    const query = String(sql);
    if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
    if (query.includes("FROM budget_topups") && query.includes("JOIN users")) {
      return { rows: [{ id: "20", user_id: "1", created_at: "2026-06-30T10:00:00Z", timezone: "Asia/Bangkok", monthly_budget_amount: "48000", base_currency: "THB", display_currency: "USD", usd_thb_rate: "30" }] };
    }
    if (query.includes("UPDATE budget_topups SET deleted_at")) return { rows: [{ id: "20", deleted_at: "2026-06-30T10:05:00Z" }] };
    if (query.includes("FROM monthly_budget_overrides")) return { rows: [] };
    if (query.includes("FROM budget_topups") && query.includes("SUM(amount_base)")) return { rows: [{ total: 0 }] };
    if (query.includes("FROM budget_topups") && query.includes("ORDER BY occurred_at DESC")) return { rows: [] };
    return { rows: [] };
  }
  const repo = createRepository({
    async connect() { return client; },
    async query(sql, params = []) { return handleQuery(sql, params); }
  });
  repo.dashboard = async () => ({ snapshot: { baseCurrency: "THB", monthlyBudget: 48000, freeRemaining: 48000 } });

  const result = await repo.undoBudgetTopup(20, 100, new Date("2026-06-30T10:05:00Z"));

  assert.equal(result.undone, true);
  assert.equal(result.currentMonthBudget.amount, 48000);
  assert.ok(queries.some((q) => q.sql.includes("UPDATE budget_topups SET deleted_at")));
  assert.ok(queries.some((q) => q.sql.includes("DELETE FROM daily_budget_snapshots")));
  const updateIndex = queriesByClient.findIndex((q) => q.sql.includes("UPDATE budget_topups SET deleted_at"));
  const reserveIndex = queriesByClient.findIndex((q) => q.sql.includes("UPDATE monthly_reserve_instances"));
  const snapshotIndex = queriesByClient.findIndex((q) => q.sql.includes("DELETE FROM daily_budget_snapshots"));
  const commitIndex = queriesByClient.findIndex((q) => q.sql === "COMMIT");
  assert.ok(updateIndex > -1 && updateIndex < reserveIndex, "expected top-up undo before reserve update");
  assert.ok(reserveIndex > -1 && reserveIndex < snapshotIndex, "expected reserve update before snapshot invalidation");
  assert.ok(snapshotIndex > -1 && snapshotIndex < commitIndex, "expected snapshot invalidation before commit");
});

test("two saveDraftAsExpense calls on the same draft produce one expense set", async () => {
  const { createRepository } = await import("../src/repository.js");
  let flipped = false;
  const client = {
    async query(sql) {
      const q = String(sql);
      if (q === "BEGIN" || q === "COMMIT" || q === "ROLLBACK") return { rows: [] };
      if (q.includes("FOR UPDATE")) {
        return { rows: [{ id: 7, user_id: 1, status: flipped ? "confirmed" : "pending", base_currency: "THB",
          items: [{ amount: 80, currency: "THB", description: "coffee", category_slug: "food_cafe", budget_impact: "regular", needs_review: false, category_source: "parser", tags: [], spent_at: "2026-06-25T10:00:00Z" }] }] };
      }
      if (q.includes("INSERT INTO expenses")) { flipped = true; return { rows: [{ id: 1, draft_id: 7, amount_base: 80 }] }; }
      if (q.includes("status = 'confirmed'")) return { rows: [] };
      return { rows: [] };
    },
    release() {}
  };
  const pool = {
    async connect() { return client; },
    async query(sql) { if (String(sql).includes("FROM expenses WHERE draft_id")) return { rows: [{ id: 1, draft_id: 7, amount_base: 80 }] }; return { rows: [] }; }
  };
  const repo = createRepository(pool);
  repo.dashboard = async () => ({ snapshot: { baseCurrency: "THB" } });
  const first = await repo.saveDraftAsExpense(7, 100);
  const second = await repo.saveDraftAsExpense(7, 100);
  assert.equal(first.alreadySaved, false);
  assert.equal(second.alreadySaved, true);
  assert.equal(second.expenses.length, 1);
});

test("saveDraftAsExpense reuses DB exchange-rate cache for same date and currency pair", async () => {
  let fetches = 0;
  const exchangeRateRows = [];
  const insertedExpenses = [];
  const draftRow = {
    id: 7,
    user_id: 1,
    status: "pending",
    base_currency: "THB",
    items: [
      { amount: 10, currency: "USD", description: "coffee", category_slug: "food_cafe", budget_impact: "regular", needs_review: false, category_source: "parser", tags: [], spent_at: "2026-06-25T10:00:00Z" },
      { amount: 20, currency: "USD", description: "lunch", category_slug: "food_cafe", budget_impact: "regular", needs_review: false, category_source: "parser", tags: [], spent_at: "2026-06-25T12:00:00Z" }
    ]
  };
  const client = {
    async query(sql, params = []) {
      const query = String(sql);
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
      if (query.includes("FOR UPDATE")) return { rows: [draftRow] };
      if (query.includes("INSERT INTO expenses")) {
        const row = { id: insertedExpenses.length + 1, draft_id: params[1], amount_base: params[4], exchange_rate_source: params[8] };
        insertedExpenses.push(row);
        return { rows: [row] };
      }
      if (query.includes("status = 'confirmed'")) return { rows: [] };
      return { rows: [] };
    },
    release() {}
  };
  const pool = {
    async connect() { return client; },
    async query(sql, params = []) {
      const query = String(sql);
      if (query.includes("FROM exchange_rates") && query.includes("rate_date = $1")) {
        return { rows: exchangeRateRows.filter((row) => row.rate_date === params[0] && row.base_currency === params[1] && row.quote_currency === params[2]) };
      }
      if (query.includes("FROM exchange_rates") && query.includes("rate_date <= $3")) return { rows: [] };
      if (query.includes("FROM exchange_rates") && query.includes("ORDER BY rate_date DESC")) return { rows: [] };
      if (query.includes("INSERT INTO exchange_rates")) {
        const row = {
          rate_date: params[0],
          base_currency: params[1],
          quote_currency: params[2],
          rate: String(params[3]),
          provider: params[4]
        };
        const existingIndex = exchangeRateRows.findIndex((existing) => (
          existing.rate_date === row.rate_date
            && existing.base_currency === row.base_currency
            && existing.quote_currency === row.quote_currency
        ));
        if (existingIndex >= 0) exchangeRateRows[existingIndex] = row;
        else exchangeRateRows.push(row);
        return { rows: [row] };
      }
      return { rows: [] };
    }
  };
  const exchangeRates = createExchangeRateProvider({
    pool,
    async fetchImpl() {
      fetches += 1;
      return {
        ok: true,
        async json() {
          return {
            time_last_update_utc: "Thu, 25 Jun 2026 00:02:32 +0000",
            rates: {
              BYN: 3.25,
              EUR: 0.88,
              GEL: 2.7,
              IDR: 16200,
              RUB: 71.8,
              THB: 32.65
            }
          };
        }
      };
    }
  });
  const repo = createRepository(pool, { exchangeRates });
  repo.dashboard = async () => ({ snapshot: { baseCurrency: "THB" } });

  const result = await repo.saveDraftAsExpense(7, 100);

  assert.equal(result.expenses.length, 2);
  assert.equal(fetches, 1);
  assert.deepEqual(insertedExpenses.map((expense) => Number(expense.amount_base)), [326.5, 653]);
  assert.equal(exchangeRateRows.filter((row) => row.rate_date === "2026-06-25" && row.base_currency === "USD" && row.quote_currency === "THB").length, 1);
});
