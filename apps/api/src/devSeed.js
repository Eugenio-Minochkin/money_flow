export const DEMO_TELEGRAM_USER_ID = 100001;

export async function resetAndSeedDemoData(pool, options = {}) {
  const now = options.now ?? new Date();
  await pool.query("BEGIN");
  try {
    await pool.query("TRUNCATE weekly_reports, planned_expense_payments, planned_drafts, planned_expenses, daily_budget_snapshots, month_baselines, expenses, drafts, users RESTART IDENTITY CASCADE");
    const userResult = await pool.query(
      `INSERT INTO users (
         telegram_user_id, first_name, username, base_currency, display_currency,
         usd_thb_rate, monthly_budget_amount, weekly_budget_amount,
         interface_language, interface_theme, budget_advice_enabled, onboarding_step
       )
       VALUES ($1, 'Acceptance', 'moneyflow_demo', 'THB', 'USD', 32.65, 45000, 10500, 'en', 'light', true, 'completed')
       RETURNING id, telegram_user_id`,
      [DEMO_TELEGRAM_USER_ID]
    );
    const userId = userResult.rows[0]?.id ?? 1;

    await seedMonthBaseline(pool, userId, now);
    const expenseCount = await seedExpenses(pool, userId, now);
    const draftCount = await seedDrafts(pool, userId, now);
    const plannedExpenseCount = await seedPlannedExpenses(pool, userId, now);
    await pool.query("COMMIT");
    return {
      telegramUserId: DEMO_TELEGRAM_USER_ID,
      expenseCount,
      draftCount,
      plannedExpenseCount
    };
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

async function seedMonthBaseline(pool, userId, now) {
  await pool.query(
    `INSERT INTO month_baselines (user_id, month_key, amount_base, source_text)
     VALUES ($1, $2, 2800, 'opening spend before seed')`,
    [userId, monthKey(now)]
  );
}

async function seedExpenses(pool, userId, now) {
  const rows = buildExpenseRows(now);
  for (const row of rows) {
    await pool.query(
      `INSERT INTO expenses (
         user_id, amount_original, currency_original, amount_base, base_currency,
         converted_amounts, exchange_rate_date, exchange_rate_source,
         description, category_slug, tags, spent_at, budget_impact
       )
       VALUES ($1, $2, $3, $4, 'THB', $5, $6, 'dev-seed',
               $7, $8, $9, $10, $11)
       -- dev seed includes regular, planned, and large_oneoff demo rows`,
      [
        userId,
        row.amount,
        row.currency,
        row.amountBase,
        JSON.stringify(convertedAmounts(row.amountBase)),
        dateKey(row.spentAt),
        row.description,
        row.category,
        row.tags,
        row.spentAt,
        row.budgetImpact
      ]
    );
  }
  return rows.length;
}

async function seedDrafts(pool, userId, now) {
  const drafts = [
    {
      status: "pending",
      source: "coffee 70 baht and lunch 180",
      items: [
        item({ amount: 70, description: "coffee at On Nut", category: "food_cafe", spentAt: now }),
        item({ amount: 180, description: "rice bowl lunch", category: "food_cafe", spentAt: now })
      ]
    },
    {
      status: "inbox",
      source: "pharmacy 420 and vitamins 690",
      items: [
        item({ amount: 420, description: "pharmacy", category: "health", spentAt: now, needsReview: true }),
        item({ amount: 690, description: "vitamins", category: "health", spentAt: now, needsReview: true })
      ]
    },
    {
      status: "inbox",
      source: "monitor 8000 big purchase",
      items: [
        item({ amount: 8000, description: "27 inch monitor", category: "electronics", spentAt: now, budgetImpact: "large_oneoff" })
      ]
    }
  ];
  for (const draft of drafts) {
    await pool.query(
      `INSERT INTO drafts (user_id, status, source_text, items, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, draft.status, draft.source, JSON.stringify(draft.items), addDays(now, -drafts.indexOf(draft))]
    );
  }
  return drafts.length;
}

async function seedPlannedExpenses(pool, userId, now) {
  const oneOffDate = localDateForMonthDay(now, Math.min(localDay(now) + 8, 28));
  const planned = [
    ["Rent", 20000, "home", ["rent"], "monthly", 1, [], null, null],
    ["Coworking", 5200, "work", ["workspace"], "monthly", 5, [], null, null],
    ["Gym membership", 2300, "sport_activities", ["gym"], "monthly", 10, [], null, null],
    ["Therapy", 5000, "health", ["therapy"], "weekly", null, [], 2, null],
    ["Laptop repair", 6500, "electronics", ["repair"], "one_off", null, [], null, oneOffDate]
  ];
  for (const row of planned) {
    await pool.query(
      `INSERT INTO planned_expenses (
         user_id, description, amount, currency, amount_base, category_slug, tags,
         recurrence, due_day, due_days, weekday, due_date, active
       )
       VALUES ($1, $2, $3, 'THB', $3, $4, $5, $6, $7, $8, $9, $10, true)`,
      [userId, ...row]
    );
  }
  await pool.query(
    `INSERT INTO expenses (
       user_id, amount_original, currency_original, amount_base, base_currency,
       converted_amounts, exchange_rate_date, exchange_rate_source,
       description, category_slug, tags, spent_at, budget_impact
     )
     VALUES ($1, 20000, 'THB', 20000, 'THB', $2, $3, 'dev-seed',
             'Rent paid', 'home', ARRAY['rent'], $4, 'planned')`,
    [userId, JSON.stringify(convertedAmounts(20000)), dateKey(now), localDateForMonthDay(now, 1)]
  );
  return planned.length;
}

function buildExpenseRows(now) {
  const today = [
    [70, "THB", "coffee near BTS", "food_cafe", ["coffee"], "regular"],
    [180, "THB", "chicken rice lunch", "food_cafe", ["lunch"], "regular"],
    [520, "THB", "Villa Market groceries", "groceries", ["home"], "regular"],
    [110, "THB", "BTS ride", "transport", ["metro"], "regular"],
    [320, "THB", "protein shake", "sport_activities", ["gym"], "regular"]
  ].map((row, index) => expense(row, addHours(now, -index)));

  const yesterday = [
    [850, "THB", "bike service", "transport", ["bike"], "regular"],
    [420, "THB", "pharmacy", "health", ["medicine"], "regular"],
    [1190, "THB", "running shoes", "sport_activities", ["gear"], "regular"],
    [8000, "THB", "27 inch monitor", "electronics", ["desk"], "large_oneoff"]
  ].map((row, index) => expense(row, addDays(addHours(now, -index), -1)));

  const history = [];
  const categories = [
    ["breakfast cafe", "food_cafe", 140],
    ["groceries Big C", "groceries", 620],
    ["electricity bill", "home", 1850],
    ["internet subscription", "subscriptions", 899],
    ["laundry", "home", 160],
    ["doctor visit", "health", 1500],
    ["Grab taxi", "transport", 260],
    ["Thai lesson", "education", 700],
    ["SIM top up", "subscriptions", 399],
    ["dinner with friends", "food_cafe", 940]
  ];
  for (let index = 0; index < 28; index += 1) {
    const sample = categories[index % categories.length];
    history.push(expense(
      [sample[2] + (index % 4) * 35, "THB", `${sample[0]} #${index + 1}`, sample[1], [sample[1]], index % 13 === 0 ? "large_oneoff" : "regular"],
      addDays(now, -(index + 2))
    ));
  }
  const previousMonth = [
    [21000, "THB", "previous month rent", "home", ["rent"], "planned"],
    [13200, "THB", "phone repair", "electronics", ["repair"], "large_oneoff"],
    [3300, "THB", "previous month groceries run", "groceries", ["home"], "regular"]
  ].map((row, index) => expense(row, addDays(startOfMonth(now), -(index + 2))));
  return [...today, ...yesterday, ...history, ...previousMonth];
}

function expense([amount, currency, description, category, tags, budgetImpact], spentAt) {
  const amountBase = currency === "USD" ? amount * 32.65 : amount;
  return { amount, currency, amountBase, description, category, tags, budgetImpact, spentAt };
}

function item({ amount, description, category, spentAt, budgetImpact = "regular", needsReview = false }) {
  return {
    amount,
    currency: "THB",
    description,
    category_slug: category,
    tags: [category],
    spent_at: spentAt.toISOString(),
    budget_impact: budgetImpact,
    confidence: needsReview ? 0.55 : 0.95,
    needs_review: needsReview
  };
}

function convertedAmounts(amount) {
  return {
    THB: Number(amount),
    USD: Math.round((Number(amount) / 32.65) * 100) / 100
  };
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60_000);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60_000);
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function monthKey(date) {
  const local = new Date(date.getTime() + 7 * 60 * 60_000);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}`;
}

function localDay(date) {
  return new Date(date.getTime() + 7 * 60 * 60_000).getUTCDate();
}

function localDateForMonthDay(date, day) {
  const local = new Date(date.getTime() + 7 * 60 * 60_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), day) - 7 * 60 * 60_000);
}

function startOfMonth(date) {
  return localDateForMonthDay(date, 1);
}
