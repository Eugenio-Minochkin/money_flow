import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createRepository } from "../src/repository.js";
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
  assert.match(queries[0].sql, /onboarding_step\)/);
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
});

test("recreates an invalidated daily snapshot from the updated monthly budget", async () => {
  let monthlyBudget = 42000;
  let storedDayBudget = 785;
  let totalsCall = 0;
  const repo = createRepository(fakePool((sql, params) => {
    const query = String(sql);
    if (query.startsWith("UPDATE users")) {
      monthlyBudget = Number(params[0]);
      return { rows: [{ id: "1", telegram_user_id: "100", monthly_budget_amount: monthlyBudget }] };
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

  assert.equal(storedDayBudget, 401.5);
  assert.equal(dashboard.snapshot.dayPlanLimit, 401.5);
  assert.equal(dashboard.snapshot.dayRemaining, 18.5);
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
    queries.push({ sql, params });
    return {
      rows: [{
        monthly_budget_amount: params[0],
        base_currency: params[1],
        display_currency: params[2],
        usd_thb_rate: params[3],
        weekly_budget_amount: params[4],
        interface_language: params[5],
        budget_advice_enabled: params[6],
        interface_theme: params[7]
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
    interfaceTheme: "light"
  });

  assert.equal(Number(user.monthly_budget_amount), 60000);
  assert.equal(Number(user.weekly_budget_amount), 12000);
  assert.equal(user.display_currency, "GEL");
  assert.equal(user.interface_language, "ru");
  assert.equal(user.budget_advice_enabled, false);
  assert.equal(user.interface_theme, "light");
  assert.equal(Number(user.usd_thb_rate), 36.5);
  assert.equal(queries[0].params[3], 36.5);
  assert.equal(queries[0].params[4], 12000);
  assert.equal(queries[0].params[5], "ru");
  assert.equal(queries[0].params[6], false);
  assert.equal(queries[0].params[7], "light");
  assert.equal(queries[0].params[8], 100);
});

test("updateUserSettings deletes daily_budget_snapshots for current day after settings update", async () => {
  const queries = [];
  const repo = createRepository(fakePool((sql, params) => {
    queries.push({ sql: String(sql), params });
    if (String(sql).startsWith("UPDATE users")) {
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
    queries.push({ sql: String(sql), params });
    if (String(sql).startsWith("UPDATE users")) {
      return {
        rows: [{
          monthly_budget_amount: params[0],
          base_currency: params[1],
          display_currency: params[2],
          usd_thb_rate: params[3],
          weekly_budget_amount: params[4],
          interface_language: params[5],
          budget_advice_enabled: params[6],
          interface_theme: params[7]
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
  assert.equal(queries[0].params[7], "dark");
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

test("marks user as bot blocked", async () => {
  const repo = createRepository(fakePool((sql, params) => {
    assert.match(String(sql), /UPDATE users SET bot_blocked = true/);
    assert.deepEqual(params, [1]);
    return { rows: [] };
  }));

  await repo.markUserBotBlocked(1);
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

test("deletes an expense owned by a Telegram user", async () => {
  const repo = createRepository(fakePool((_sql, params) => ({
    rows: [{ id: params[0] }]
  })));

  const deleted = await repo.deleteExpenseForTelegramUser(7, 100);

  assert.equal(deleted.id, 7);
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
  const repo = createRepository(fakePool((_sql, params) => {
    if (String(_sql).startsWith("INSERT")) {
      assert.match(String(_sql), /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, \$11, \$12, true\)/);
      assert.equal(params.length, 12);
      return { rows: [{ id: "5", description: params[4], recurrence: params[7] }] };
    }
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
    due_day: 10
  });
  const planned = await repo.listPlannedExpensesForTelegramUser(100);

  assert.equal(created.description, "ChatGPT");
  assert.equal(planned[0].recurrence, "monthly");
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
  assert.doesNotMatch(String(paidLookup.sql), /e\.spent_at/);
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
  assert.doesNotMatch(listSql, /e\.spent_at/);
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
  assert.doesNotMatch(listSql, /e\.spent_at/);
  assert.deepEqual(planned[0].paid_occurrence_dates, ["2026-06-14"]);
  assert.equal(planned[0].paid_occurrences["2026-06-14"].expense_id, "187");
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
  assert.equal(june.snapshot.dayPlanLimit, 1125);
  assert.equal(july.snapshot.monthlyBudget, 45000);
  assert.equal(july.currentMonthBudget.amount, 45000);
  assert.equal(july.currentMonthBudget.isPartialMonth, false);
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
          usd_thb_rate: "36"
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

test("syncs a valid user timezone and falls back to UTC", async () => {
  const calls = [];
  const repo = createRepository(fakePool((sql, params) => {
    calls.push({ sql: String(sql), params });
    return { rows: [{ timezone: params[0] }] };
  }));

  const updated = await repo.syncUserTimezone(100, "Europe/Moscow");
  const fallback = await repo.syncUserTimezone(100, "Not/A_Zone");

  assert.equal(updated.timezone, "Europe/Moscow");
  assert.equal(fallback.timezone, "UTC");
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

function fakePool(handler) {
  return {
    async query(sql, params = []) {
      return handler(sql, params);
    }
  };
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
