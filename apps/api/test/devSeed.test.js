import test from "node:test";
import assert from "node:assert/strict";

import { DEMO_TELEGRAM_USER_ID, resetAndSeedDemoData } from "../src/devSeed.js";

test("dev seed creates the acceptance demo user and rich fake data", async () => {
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (/INSERT INTO users/i.test(sql)) return { rows: [{ id: 1, telegram_user_id: DEMO_TELEGRAM_USER_ID }] };
      return { rows: [] };
    }
  };

  const result = await resetAndSeedDemoData(pool, { now: new Date("2026-06-11T09:00:00+07:00") });

  assert.equal(result.telegramUserId, DEMO_TELEGRAM_USER_ID);
  assert.equal(result.expenseCount >= 30, true);
  assert.equal(result.draftCount >= 3, true);
  assert.equal(result.plannedExpenseCount >= 5, true);
  assert.ok(calls.some((call) => call.params.includes(DEMO_TELEGRAM_USER_ID)));
  assert.ok(calls.some((call) => /large_oneoff/i.test(call.sql)));
  assert.ok(calls.some((call) => /planned_expenses/i.test(call.sql)));
});
