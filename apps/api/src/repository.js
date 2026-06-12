import { calculateBudgetSnapshot } from "../../../packages/shared/src/budget.js";
import { SUPPORTED_CURRENCY_CODES, fallbackThbRate, normalizeCurrency } from "../../../packages/shared/src/currencies.js";
import { localPeriodBounds } from "../../../packages/shared/src/time.js";
import { createExchangeRateProvider } from "./exchangeRates.js";

export function createRepository(pool, options = {}) {
  const defaultMonthlyBudget = options.defaultMonthlyBudget ?? 45000;
  const exchangeRates = options.exchangeRates ?? createExchangeRateProvider({ fetchImpl: null });

  return {
    async health() {
      await pool.query("SELECT 1 AS ok");
      return { db: true };
    },

    async upsertTelegramUser(profile) {
      const result = await pool.query(
        `INSERT INTO users (telegram_user_id, first_name, username, monthly_budget_amount, onboarding_step)
         VALUES ($1, $2, $3, $4, 'base_currency')
         ON CONFLICT (telegram_user_id)
         DO UPDATE SET first_name = EXCLUDED.first_name, username = EXCLUDED.username
         RETURNING *, (xmax = 0) AS is_new`,
        [profile.id, profile.firstName ?? null, profile.username ?? null, defaultMonthlyBudget]
      );
      return result.rows[0];
    },

    async getUserByTelegramId(telegramUserId) {
      const result = await pool.query("SELECT * FROM users WHERE telegram_user_id = $1", [telegramUserId]);
      return result.rows[0] ?? null;
    },

    async setOnboardingStep(telegramUserId, step) {
      const safeStep = ["base_currency", "monthly_budget", "current_month_budget", "month_opening_spend", "completed"].includes(step) ? step : "completed";
      const result = await pool.query(
        "UPDATE users SET onboarding_step = $1 WHERE telegram_user_id = $2 RETURNING *",
        [safeStep, telegramUserId]
      );
      return result.rows[0] ?? null;
    },

    async updateOnboardingBaseCurrency(telegramUserId, currency) {
      const baseCurrency = normalizeCurrency(currency, "THB");
      const result = await pool.query(
        `UPDATE users
         SET base_currency = $1,
             onboarding_step = 'monthly_budget'
         WHERE telegram_user_id = $2
         RETURNING *`,
        [baseCurrency, telegramUserId]
      );
      return result.rows[0] ?? null;
    },

    async updateOnboardingMonthlyBudget(telegramUserId, amount, nextStep = "current_month_budget") {
      const monthlyBudgetAmount = Number(amount);
      if (!Number.isFinite(monthlyBudgetAmount) || monthlyBudgetAmount <= 0) {
        throw new Error("Monthly budget must be positive");
      }
      const result = await pool.query(
        `UPDATE users
         SET monthly_budget_amount = $1,
             onboarding_step = $2
         WHERE telegram_user_id = $3
         RETURNING *`,
        [monthlyBudgetAmount, nextStep, telegramUserId]
      );
      return result.rows[0] ?? null;
    },

    async setCurrentMonthBudget(telegramUserId, input, now = new Date()) {
      const user = await this.getUserByTelegramId(telegramUserId);
      if (!user) return null;
      const amount = Number(input.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error("Current month budget must be positive");
      }
      const moneyAmounts = await buildMoneyAmounts(exchangeRates, amount, input.currency ?? user.base_currency, now, user);
      const result = await pool.query(
        `INSERT INTO monthly_budget_overrides (
           user_id, month_key, budget_amount_base, source, is_partial_month, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (user_id, month_key)
         DO UPDATE SET budget_amount_base = EXCLUDED.budget_amount_base,
                       source = EXCLUDED.source,
                       is_partial_month = EXCLUDED.is_partial_month,
                       updated_at = now()
         RETURNING *`,
        [user.id, monthKey(now), moneyAmounts.amountBase, input.source ?? "manual", input.isPartialMonth === true]
      );
      if (input.completeOnboarding) await this.setOnboardingStep(telegramUserId, "completed");
      return result.rows[0] ?? null;
    },

    async setMonthBaseline(telegramUserId, input, now = new Date()) {
      const user = await this.getUserByTelegramId(telegramUserId);
      if (!user) return null;
      const moneyAmounts = await buildMoneyAmounts(exchangeRates, input.amount, input.currency ?? user.base_currency, now, user);
      const result = await pool.query(
        `INSERT INTO month_baselines (user_id, month_key, amount_base, source_text, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (user_id, month_key)
         DO UPDATE SET amount_base = EXCLUDED.amount_base,
                       source_text = EXCLUDED.source_text,
                       updated_at = now()
         RETURNING *`,
        [user.id, monthKey(now), moneyAmounts.amountBase, input.sourceText ?? null]
      );
      await this.setOnboardingStep(telegramUserId, "completed");
      return result.rows[0] ?? null;
    },

    async listUsersPendingWeeklyReport(reportKey) {
      const result = await pool.query(
        `SELECT users.*
         FROM users
         WHERE NOT EXISTS (
           SELECT 1 FROM weekly_reports
           WHERE weekly_reports.user_id = users.id
             AND weekly_reports.report_key = $1
         )
         ORDER BY users.id`,
        [reportKey]
      );
      return result.rows;
    },

    async markWeeklyReportSent(userId, reportKey) {
      await pool.query(
        `INSERT INTO weekly_reports (user_id, report_key)
         VALUES ($1, $2)
         ON CONFLICT (user_id, report_key) DO NOTHING`,
        [userId, reportKey]
      );
    },

    async updateMonthlyBudget(telegramUserId, monthlyBudgetAmount) {
      const amount = Number(monthlyBudgetAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error("Monthly budget must be positive");
      }
      const result = await pool.query(
        `UPDATE users
         SET monthly_budget_amount = $1
         WHERE telegram_user_id = $2
         RETURNING *`,
        [amount, telegramUserId]
      );
      return result.rows[0] ?? null;
    },

    async updateUserSettings(telegramUserId, settings) {
      const monthlyBudgetAmount = Number(settings.monthlyBudgetAmount);
      const weeklyBudgetAmount = settings.weeklyBudgetAmount === "" || settings.weeklyBudgetAmount == null
        ? null
        : Number(settings.weeklyBudgetAmount);
      const usdThbRate = Number(settings.usdThbRate ?? 32.65);
      if (!Number.isFinite(monthlyBudgetAmount) || monthlyBudgetAmount <= 0) {
        throw new Error("Monthly budget must be positive");
      }
      if (weeklyBudgetAmount != null && (!Number.isFinite(weeklyBudgetAmount) || weeklyBudgetAmount <= 0)) {
        throw new Error("Weekly budget must be positive");
      }
      if (!Number.isFinite(usdThbRate) || usdThbRate <= 0) {
        throw new Error("USD/THB rate must be positive");
      }
      const baseCurrency = normalizeCurrency(settings.baseCurrency, "THB");
      const displayCurrency = normalizeCurrency(settings.displayCurrency, "USD");
      const interfaceLanguage = normalizeLanguage(settings.interfaceLanguage);
      const interfaceTheme = normalizeTheme(settings.interfaceTheme);
      const budgetAdviceEnabled = settings.budgetAdviceEnabled !== false;
      const result = await pool.query(
        `UPDATE users
         SET monthly_budget_amount = $1,
             base_currency = $2,
             display_currency = $3,
             usd_thb_rate = $4,
             weekly_budget_amount = $5,
             interface_language = $6,
             budget_advice_enabled = $7,
             interface_theme = $8
         WHERE telegram_user_id = $9
         RETURNING *`,
        [monthlyBudgetAmount, baseCurrency, displayCurrency, usdThbRate, weeklyBudgetAmount, interfaceLanguage, budgetAdviceEnabled, interfaceTheme, telegramUserId]
      );
      return result.rows[0] ?? null;
    },

    async createDraft(userId, sourceText, items) {
      const status = items.some((item) => item.needs_review) ? "inbox" : "pending";
      const result = await pool.query(
        `INSERT INTO drafts (user_id, status, source_text, items)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [userId, status, sourceText, JSON.stringify(items)]
      );
      return result.rows[0];
    },

    async createPlannedDraft(userId, sourceText, item) {
      const planned = normalizePlannedExpense(item);
      const result = await pool.query(
        `INSERT INTO planned_drafts (user_id, status, source_text, item)
         VALUES ($1, 'pending', $2, $3)
         RETURNING *`,
        [userId, sourceText, JSON.stringify(planned)]
      );
      return normalizePlannedDraft(result.rows[0]);
    },

    async confirmPlannedDraft(plannedDraftId, telegramUserId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const draftResult = await client.query(
          `SELECT planned_drafts.*, users.base_currency, users.usd_thb_rate
           FROM planned_drafts
           JOIN users ON users.id = planned_drafts.user_id
           WHERE planned_drafts.id = $1
             AND users.telegram_user_id = $2
           FOR UPDATE`,
          [plannedDraftId, telegramUserId]
        );
        const draft = normalizePlannedDraft(draftResult.rows[0] ?? null);
        if (!draft) throw new Error("Planned draft not found");
        if (draft.status !== "pending") throw new Error("Planned draft is already closed");
        const planned = normalizePlannedExpense(draft.item);
        const moneyAmounts = await buildMoneyAmounts(exchangeRates, planned.amount, planned.currency, new Date(), draft);
        const result = await client.query(
          `INSERT INTO planned_expenses (
             user_id, amount, currency, amount_base, description, category_slug, tags,
             recurrence, due_day, due_days, weekday, due_date, active
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true)
           RETURNING *`,
          [
            draft.user_id,
            planned.amount,
            planned.currency,
            moneyAmounts.amountBase,
            planned.description,
            planned.category_slug,
            planned.tags,
            planned.recurrence,
            planned.due_day,
            planned.due_days,
            planned.weekday,
            planned.due_date
          ]
        );
        await client.query(
          "UPDATE planned_drafts SET status = 'confirmed', confirmed_at = now() WHERE id = $1",
          [draft.id]
        );
        await client.query("COMMIT");
        return result.rows[0] ?? null;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async cancelPlannedDraft(plannedDraftId, telegramUserId) {
      await pool.query(
        `UPDATE planned_drafts
         SET status = 'cancelled'
         WHERE id = $1 AND user_id = (SELECT id FROM users WHERE telegram_user_id = $2)`,
        [plannedDraftId, telegramUserId]
      );
    },

    async getDraftForTelegramUser(draftId, telegramUserId) {
      const result = await pool.query(
        `SELECT drafts.*
         FROM drafts
         JOIN users ON users.id = drafts.user_id
         WHERE drafts.id = $1 AND users.telegram_user_id = $2`,
        [draftId, telegramUserId]
      );
      return normalizeDraft(result.rows[0] ?? null);
    },

    async updateDraftItems(draftId, telegramUserId, items) {
      const normalized = items.map(normalizeDraftItem);
      const result = await pool.query(
        `UPDATE drafts
         SET items = $1
         WHERE id = $2
           AND status IN ('pending', 'inbox')
           AND user_id = (SELECT id FROM users WHERE telegram_user_id = $3)
         RETURNING *`,
        [JSON.stringify(normalized), draftId, telegramUserId]
      );
      return normalizeDraft(result.rows[0] ?? null);
    },

    async listDraftsForTelegramUser(telegramUserId, options = {}) {
      const status = ["pending", "inbox"].includes(options.status) ? options.status : "inbox";
      await moveExpiredPendingDraftsToInbox(pool, telegramUserId, options.expireAfterMinutes ?? 30);
      const result = await pool.query(
        `SELECT drafts.*
         FROM drafts
         JOIN users ON users.id = drafts.user_id
         WHERE users.telegram_user_id = $1
           AND drafts.status = $2
         ORDER BY drafts.created_at DESC
         LIMIT 20`,
        [telegramUserId, status]
      );
      return result.rows.map(normalizeDraft);
    },

    async confirmDraft(draftId, telegramUserId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const draftResult = await client.query(
          `SELECT drafts.*, users.base_currency, users.usd_thb_rate
           FROM drafts
           JOIN users ON users.id = drafts.user_id
           WHERE drafts.id = $1 AND users.telegram_user_id = $2
           FOR UPDATE`,
          [draftId, telegramUserId]
        );
        const draft = draftResult.rows[0];
        if (!draft) throw new Error("Draft not found");
        if (draft.status !== "pending" && draft.status !== "inbox") throw new Error("Draft is already closed");

        const items = Array.isArray(draft.items) ? draft.items : JSON.parse(draft.items);
        const inserted = [];
        for (const item of items) {
          const spentAt = new Date(item.spent_at);
          const moneyAmounts = await buildMoneyAmounts(exchangeRates, item.amount, item.currency, spentAt, draft);
          const result = await client.query(
            `INSERT INTO expenses (
               user_id, draft_id, amount_original, currency_original, amount_base, base_currency,
               converted_amounts, exchange_rate_date, exchange_rate_source, description, category_slug, tags, spent_at, budget_impact
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             RETURNING *`,
            [
              draft.user_id,
              draft.id,
              item.amount,
              item.currency,
              moneyAmounts.amountBase,
              draft.base_currency,
              JSON.stringify(moneyAmounts.convertedAmounts),
              spentAt.toISOString().slice(0, 10),
              moneyAmounts.source,
              item.description,
              item.category_slug,
              item.tags ?? [],
              spentAt,
              item.budget_impact ?? "regular"
            ]
          );
          inserted.push(result.rows[0]);
        }

        await client.query(
          "UPDATE drafts SET status = 'confirmed', confirmed_at = now() WHERE id = $1",
          [draft.id]
        );
        await client.query("COMMIT");
        return inserted;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async cancelDraft(draftId, telegramUserId) {
      await pool.query(
        `UPDATE drafts
         SET status = 'cancelled'
         WHERE id = $1 AND user_id = (SELECT id FROM users WHERE telegram_user_id = $2)`,
        [draftId, telegramUserId]
      );
    },

    async moveDraftToInbox(draftId, telegramUserId) {
      await pool.query(
        `UPDATE drafts
         SET status = 'inbox'
         WHERE id = $1 AND user_id = (SELECT id FROM users WHERE telegram_user_id = $2)`,
        [draftId, telegramUserId]
      );
    },

    async updateExpenseForTelegramUser(expenseId, telegramUserId, patch) {
      const item = normalizeDraftItem(patch);
      const spentAt = new Date(item.spent_at);
      const user = await this.getUserByTelegramId(telegramUserId);
      const baseCurrency = user?.base_currency ?? "THB";
      const moneyAmounts = await buildMoneyAmounts(exchangeRates, item.amount, item.currency, spentAt, user);
      const result = await pool.query(
        `UPDATE expenses
         SET amount_original = $1,
             currency_original = $2,
             amount_base = $3,
             converted_amounts = $4,
             exchange_rate_date = $5,
             exchange_rate_source = $6,
             description = $7,
             category_slug = $8,
             tags = $9,
             spent_at = $10
         WHERE id = $11
           AND user_id = (SELECT id FROM users WHERE telegram_user_id = $12)
         RETURNING id, amount_original, currency_original, description, category_slug, tags, spent_at`,
        [
          item.amount,
          item.currency,
          moneyAmounts.amountBase,
          JSON.stringify(moneyAmounts.convertedAmounts),
          spentAt.toISOString().slice(0, 10),
          moneyAmounts.source,
          item.description,
          item.category_slug,
          item.tags,
          spentAt,
          expenseId,
          telegramUserId
        ]
      );
      return result.rows[0] ?? null;
    },

    async deleteExpenseForTelegramUser(expenseId, telegramUserId) {
      const result = await pool.query(
        `DELETE FROM expenses
         WHERE id = $1
           AND user_id = (SELECT id FROM users WHERE telegram_user_id = $2)
         RETURNING id`,
        [expenseId, telegramUserId]
      );
      return result.rows[0] ?? null;
    },

    async listExpensesForTelegramUser(telegramUserId, options = {}) {
      const user = await this.getUserByTelegramId(telegramUserId);
      if (!user) return [];
      const bounds = localPeriodBounds(options.now ?? new Date(), options.period ?? "month");
      const search = String(options.search ?? "").trim();
      const params = [user.id, bounds.start, bounds.end];
      let searchSql = "";
      if (search) {
        params.push(`%${search.toLowerCase()}%`);
        searchSql = `AND (
          lower(description) LIKE $4
          OR lower(category_slug) LIKE $4
          OR EXISTS (SELECT 1 FROM unnest(tags) AS tag WHERE lower(tag) LIKE $4)
        )`;
      }
      const result = await pool.query(
        `SELECT id, amount_original, currency_original, amount_base, converted_amounts,
                description, category_slug, tags, spent_at
         FROM expenses
         WHERE user_id = $1 AND spent_at >= $2 AND spent_at < $3
         ${searchSql}
         ORDER BY spent_at DESC`,
        params
      );
      return result.rows.map((row) => withDisplay(row, user));
    },

    async topCategories(userId, now = new Date()) {
      const userResult = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
      const user = userResult.rows[0] ?? {};
      const bounds = localPeriodBounds(now, "month");
      const result = await pool.query(
        `SELECT category_slug,
                COALESCE(SUM(amount_base), 0)::float AS total,
                COALESCE(SUM(COALESCE(NULLIF(converted_amounts->>$4, '')::float, amount_base / NULLIF($5::numeric, 0))), 0)::float AS display_total
         FROM expenses
         WHERE user_id = $1 AND spent_at >= $2 AND spent_at < $3
         GROUP BY category_slug
         ORDER BY total DESC
         LIMIT 6`,
        [userId, bounds.start, bounds.end, user.display_currency ?? "USD", displayThbRate(user)]
      );
      return result.rows.map((row) => withDisplayTotal(row, user));
    },

    async listPlannedExpensesForTelegramUser(telegramUserId) {
      const result = await pool.query(
        `SELECT planned_expenses.*, COALESCE(paid.paid_count, 0)::int AS paid_count
         FROM planned_expenses
         JOIN users ON users.id = planned_expenses.user_id
         LEFT JOIN (
           SELECT planned_expense_id, COUNT(*)::int AS paid_count
           FROM planned_expense_payments
           WHERE paid_month = $2
           GROUP BY planned_expense_id
         ) paid ON paid.planned_expense_id = planned_expenses.id
         WHERE users.telegram_user_id = $1 AND planned_expenses.active = true
         ORDER BY planned_expenses.id DESC`,
        [telegramUserId, monthKey(new Date())]
      );
      return result.rows;
    },

    async createPlannedExpense(telegramUserId, input) {
      const user = await this.getUserByTelegramId(telegramUserId);
      if (!user) return null;
      const planned = normalizePlannedExpense(input);
      const moneyAmounts = await buildMoneyAmounts(exchangeRates, planned.amount, planned.currency, new Date(), user);
      const result = await pool.query(
        `INSERT INTO planned_expenses (
           user_id, amount, currency, amount_base, description, category_slug, tags,
           recurrence, due_day, due_days, weekday, due_date, active
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true)
         RETURNING *`,
        [
          user.id,
          planned.amount,
          planned.currency,
          moneyAmounts.amountBase,
          planned.description,
          planned.category_slug,
          planned.tags,
          planned.recurrence,
          planned.due_day,
          planned.due_days,
          planned.weekday,
          planned.due_date
        ]
      );
      return result.rows[0] ?? null;
    },

    async updatePlannedExpense(telegramUserId, plannedExpenseId, input) {
      const planned = normalizePlannedExpense(input);
      const user = await this.getUserByTelegramId(telegramUserId);
      const moneyAmounts = await buildMoneyAmounts(exchangeRates, planned.amount, planned.currency, new Date(), user);
      const result = await pool.query(
        `UPDATE planned_expenses
         SET amount = $1,
             currency = $2,
             amount_base = $3,
             description = $4,
             category_slug = $5,
             tags = $6,
             recurrence = $7,
             due_day = $8,
             due_days = $9,
             weekday = $10,
             due_date = $11,
             active = $12
         WHERE id = $13
           AND user_id = (SELECT id FROM users WHERE telegram_user_id = $14)
         RETURNING *`,
        [
          planned.amount,
          planned.currency,
          moneyAmounts.amountBase,
          planned.description,
          planned.category_slug,
          planned.tags,
          planned.recurrence,
          planned.due_day,
          planned.due_days,
          planned.weekday,
          planned.due_date,
          planned.active,
          plannedExpenseId,
          telegramUserId
        ]
      );
      return result.rows[0] ?? null;
    },

    async deactivatePlannedExpense(telegramUserId, plannedExpenseId) {
      const result = await pool.query(
        `UPDATE planned_expenses
         SET active = false
         WHERE id = $1
           AND user_id = (SELECT id FROM users WHERE telegram_user_id = $2)
         RETURNING id`,
        [plannedExpenseId, telegramUserId]
      );
      return result.rows[0] ?? null;
    },

    async payPlannedExpenseForTelegramUser(plannedExpenseId, telegramUserId, paidAt = new Date()) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const plannedResult = await client.query(
          `SELECT planned_expenses.*, users.base_currency, users.usd_thb_rate
           FROM planned_expenses
           JOIN users ON users.id = planned_expenses.user_id
           WHERE planned_expenses.id = $1
             AND users.telegram_user_id = $2
             AND planned_expenses.active = true
           FOR UPDATE`,
          [plannedExpenseId, telegramUserId]
        );
        const planned = plannedResult.rows[0];
        if (!planned) throw new Error("Planned expense not found");

        const moneyAmounts = await buildMoneyAmounts(exchangeRates, planned.amount, planned.currency, paidAt, planned);
        const expenseResult = await client.query(
          `INSERT INTO expenses (
             user_id, draft_id, amount_original, currency_original, amount_base, base_currency,
             converted_amounts, exchange_rate_date, exchange_rate_source, description, category_slug, tags, spent_at, budget_impact
           )
           VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING *`,
          [
            planned.user_id,
            planned.amount,
            planned.currency,
            moneyAmounts.amountBase,
            planned.base_currency,
            JSON.stringify(moneyAmounts.convertedAmounts),
            paidAt.toISOString().slice(0, 10),
            moneyAmounts.source,
            planned.description,
            planned.category_slug,
            planned.tags ?? [],
            paidAt,
            "planned"
          ]
        );
        const expense = expenseResult.rows[0];
        const paidKey = plannedPaymentKey(planned, paidAt);
        await client.query(
          `INSERT INTO planned_expense_payments (planned_expense_id, expense_id, paid_month, paid_at, paid_key)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (planned_expense_id, paid_key)
           DO UPDATE SET expense_id = EXCLUDED.expense_id, paid_at = EXCLUDED.paid_at`,
          [planned.id, expense.id, monthKey(paidAt), paidAt, paidKey]
        );
        await client.query("COMMIT");
        return expense;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async totals(userId, now = new Date()) {
      const userResult = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
      const user = userResult.rows[0] ?? {};
      const [today, week, month] = await Promise.all([
        totalForPeriod(pool, userId, "today", now, user),
        totalForPeriod(pool, userId, "week", now, user),
        totalForPeriod(pool, userId, "month", now, user)
      ]);
      return {
        today: today.regularTotal,
        todayTotal: today.total,
        plannedToday: today.plannedTotal,
        largeToday: today.largeOneOffTotal,
        week: week.total,
        month: month.total,
        regularWeek: week.regularTotal,
        regularMonth: month.regularTotal,
        plannedMonth: month.plannedTotal,
        largeMonth: month.largeOneOffTotal,
        todayDisplay: today.regularDisplayTotal,
        todayDisplayTotal: today.displayTotal,
        plannedTodayDisplay: today.plannedDisplayTotal,
        largeTodayDisplay: today.largeOneOffDisplayTotal,
        weekDisplay: week.displayTotal,
        regularWeekDisplay: week.regularDisplayTotal,
        monthDisplay: month.displayTotal,
        regularMonthDisplay: month.regularDisplayTotal,
        plannedMonthDisplay: month.plannedDisplayTotal,
        largeMonthDisplay: month.largeOneOffDisplayTotal
      };
    },

    async dashboard(telegramUserId, now = new Date()) {
      const user = await this.getUserByTelegramId(telegramUserId);
      if (!user) return null;
      const currentBudget = await currentMonthBudget(pool, user, now);
      const totals = await this.totals(user.id, now);
      const monthBaseline = await monthBaselineTotal(pool, user.id, now);
      totals.month += monthBaseline;
      totals.monthDisplay += displayFromBase(monthBaseline, user);
      totals.regularMonth += monthBaseline;
      totals.regularMonthDisplay += displayFromBase(monthBaseline, user);
      const plannedExpenses = await listPlannedExpensesForTelegramUserAt(pool, telegramUserId, now);
      const plannedRemainingTotal = calculatePlannedRemaining(plannedExpenses, now);
      const plannedThisWeekTotal = calculatePlannedThisWeek(plannedExpenses, now);
      const paidPlannedMonthTotal = await paidPlannedTotalForMonth(pool, user.id, now);
      const dayBudgetSnapshot = await getOrCreateDailyBudgetSnapshot(pool, user, now, {
        todayTotal: totals.today,
        monthTotal: totals.month,
        todayDisplayTotal: totals.todayDisplay,
        monthDisplayTotal: totals.monthDisplay,
        monthlyBudget: currentBudget.amount,
        weeklyBudget: user.weekly_budget_amount == null ? null : Number(user.weekly_budget_amount),
        plannedRemainingTotal,
        plannedRemainingDisplayTotal: displayFromBase(plannedRemainingTotal, user),
        plannedThisWeekTotal,
        plannedThisWeekDisplayTotal: displayFromBase(plannedThisWeekTotal, user),
        paidPlannedMonthTotal,
        largeOneOffMonthTotal: totals.largeMonth,
        baseCurrency: user.base_currency ?? "THB",
        displayCurrency: user.display_currency ?? "USD",
        budgetAdviceEnabled: user.budget_advice_enabled !== false
      });
      const latest = await pool.query(
        `SELECT id, amount_original, currency_original, amount_base, converted_amounts, budget_impact,
                description, category_slug, tags, spent_at
         FROM expenses
         WHERE user_id = $1
         ORDER BY spent_at DESC
         LIMIT 5`,
        [user.id]
      );
      const snapshot = calculateBudgetSnapshot({
        todayTotal: totals.today,
        weekTotal: totals.week,
        monthTotal: totals.month,
        todayDisplayTotal: totals.todayDisplay,
        weekDisplayTotal: totals.weekDisplay,
        monthDisplayTotal: totals.monthDisplay,
        displayCurrency: user.display_currency ?? "USD",
        monthlyBudget: currentBudget.amount,
        weeklyBudget: user.weekly_budget_amount == null ? null : Number(user.weekly_budget_amount),
        budgetAdviceEnabled: user.budget_advice_enabled !== false,
        plannedRemainingTotal,
        plannedRemainingDisplayTotal: displayFromBase(plannedRemainingTotal, user),
        plannedThisWeekTotal,
        plannedThisWeekDisplayTotal: displayFromBase(plannedThisWeekTotal, user),
        paidPlannedMonthTotal,
        largeOneOffMonthTotal: totals.largeMonth,
        dayPlanLimit: dayBudgetSnapshot.budgetAmountBase,
        dayDisplayPlanLimit: dayBudgetSnapshot.budgetDisplayAmount,
        baseCurrency: user.base_currency ?? "THB",
        now
      });
      snapshot.todayTotal = roundMoney(totals.todayTotal);
      snapshot.plannedToday = roundMoney(totals.plannedToday);
      snapshot.largeToday = roundMoney(totals.largeToday);
      snapshot.display.todayTotal = roundMoney(totals.todayDisplayTotal);
      snapshot.display.plannedToday = roundMoney(totals.plannedTodayDisplay);
      snapshot.display.largeToday = roundMoney(totals.largeTodayDisplay);
      const topCategories = await this.topCategories(user.id, now);
      const analytics = await dashboardAnalytics(pool, user, topCategories, snapshot, now);
      return {
        user,
        currentMonthBudget: currentBudget,
        snapshot,
        latestExpenses: latest.rows.map((row) => withDisplay(row, user)),
        topCategories,
        analytics,
        plannedExpenses: plannedExpenses.map((row) => withDisplayPlanned(row, user))
      };
    }
  };
}

async function dashboardAnalytics(pool, user, topCategories, snapshot, now) {
  const [largestWeek, largestMonth, topTags, dailyHeatmap, previousWeek] = await Promise.all([
    largestExpenseForPeriod(pool, user.id, "week", now, user),
    largestExpenseForPeriod(pool, user.id, "month", now, user),
    topTagsForMonth(pool, user.id, now, user),
    dailyHeatmapForMonth(pool, user.id, now),
    totalForPreviousWeek(pool, user.id, now, user)
  ]);
  const otherCategory = topCategories.find((category) => category.category_slug === "other");
  const otherTotal = Number(otherCategory?.total ?? 0);
  const otherPercent = snapshot.month > 0 ? Math.round((otherTotal / snapshot.month) * 100) : 0;

  return {
    largestWeek,
    largestMonth,
    topTags,
    dailyHeatmap,
    weekComparison: {
      current: snapshot.week,
      previous: previousWeek.total,
      delta: roundMoney(snapshot.week - previousWeek.total),
      display: {
        currency: user.display_currency ?? "USD",
        current: snapshot.display.week,
        previous: previousWeek.displayTotal,
        delta: roundMoney(snapshot.display.week - previousWeek.displayTotal)
      }
    },
    otherCategoryWarning: {
      active: otherPercent > 10,
      percent: otherPercent,
      total: roundMoney(otherTotal),
      display: otherCategory?.display ?? { currency: user.display_currency ?? "USD", amount: 0 }
    }
  };
}

async function largestExpenseForPeriod(pool, userId, period, now, user) {
  const bounds = localPeriodBounds(now, period);
  const result = await pool.query(
    `SELECT id, amount_original, currency_original, amount_base, converted_amounts,
            description, category_slug, tags, spent_at
     FROM expenses
     WHERE user_id = $1 AND spent_at >= $2 AND spent_at < $3
     ORDER BY amount_base DESC, spent_at DESC
     LIMIT 1`,
    [userId, bounds.start, bounds.end]
  );
  return result.rows[0] ? withDisplay(result.rows[0], user) : null;
}

async function topTagsForMonth(pool, userId, now, user) {
  const bounds = localPeriodBounds(now, "month");
  const result = await pool.query(
    `SELECT tag,
            COALESCE(SUM(amount_base), 0)::float AS total,
            COALESCE(SUM(COALESCE(NULLIF(converted_amounts->>$4, '')::float, amount_base / NULLIF($5::numeric, 0))), 0)::float AS display_total
     FROM expenses, unnest(tags) AS tag
     WHERE user_id = $1 AND spent_at >= $2 AND spent_at < $3
     GROUP BY tag
     ORDER BY total DESC
     LIMIT 8`,
    [userId, bounds.start, bounds.end, user.display_currency ?? "USD", displayThbRate(user)]
  );
  return result.rows.map((row) => ({
    tag: row.tag,
    total: roundMoney(Number(row.total)),
    display: {
      currency: user.display_currency ?? "USD",
      amount: roundMoney(Number(row.display_total ?? 0))
    }
  }));
}

async function dailyHeatmapForMonth(pool, userId, now) {
  const bounds = localPeriodBounds(now, "month");
  const result = await pool.query(
    `SELECT EXTRACT(DAY FROM (spent_at + interval '7 hours'))::int AS day,
            COALESCE(SUM(amount_base), 0)::float AS total
     FROM expenses
     WHERE user_id = $1 AND spent_at >= $2 AND spent_at < $3
     GROUP BY day
     ORDER BY day`,
    [userId, bounds.start, bounds.end]
  );
  return result.rows.map((row) => ({
    day: Number(row.day),
    total: roundMoney(Number(row.total))
  }));
}

async function totalForPreviousWeek(pool, userId, now, user) {
  const week = localPeriodBounds(now, "week");
  const previousNow = new Date(week.start.getTime() - 24 * 60 * 60_000);
  return totalForPeriod(pool, userId, "week", previousNow, user);
}

async function paidPlannedTotalForMonth(pool, userId, now) {
  const bounds = localPeriodBounds(now, "month");
  const result = await pool.query(
    `SELECT COALESCE(SUM(expenses.amount_base), 0)::float AS total
     FROM planned_expense_payments
     JOIN expenses ON expenses.id = planned_expense_payments.expense_id
     WHERE expenses.user_id = $1
       AND expenses.spent_at >= $2
       AND expenses.spent_at < $3`,
    [userId, bounds.start, bounds.end]
  );
  return Number(result.rows[0]?.total ?? 0);
}

async function getOrCreateDailyBudgetSnapshot(pool, user, now, input) {
  const dayKey = localDayKey(now);
  const existing = await pool.query(
    `SELECT budget_amount_base, budget_display_amount
     FROM daily_budget_snapshots
     WHERE user_id = $1 AND day_key = $2`,
    [user.id, dayKey]
  );
  const row = existing.rows[0];
  if (row) {
    return {
      budgetAmountBase: Number(row.budget_amount_base ?? 0),
      budgetDisplayAmount: Number(row.budget_display_amount ?? 0)
    };
  }

  const snapshot = calculateBudgetSnapshot({
    ...input,
    now
  });
  const inserted = await pool.query(
    `INSERT INTO daily_budget_snapshots (user_id, day_key, budget_amount_base, budget_display_amount)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, day_key)
     DO UPDATE SET budget_amount_base = daily_budget_snapshots.budget_amount_base
     RETURNING budget_amount_base, budget_display_amount`,
    [user.id, dayKey, snapshot.dayPlanLimit, snapshot.display.dayPlanLimit]
  );
  return {
    budgetAmountBase: Number(inserted.rows[0]?.budget_amount_base ?? snapshot.dayPlanLimit),
    budgetDisplayAmount: Number(inserted.rows[0]?.budget_display_amount ?? snapshot.display.dayPlanLimit)
  };
}

function normalizeDraft(draft) {
  if (!draft) return null;
  return {
    ...draft,
    items: Array.isArray(draft.items) ? draft.items : JSON.parse(draft.items)
  };
}

function normalizePlannedDraft(draft) {
  if (!draft) return null;
  return {
    ...draft,
    item: typeof draft.item === "string" ? JSON.parse(draft.item) : draft.item
  };
}

async function monthBaselineTotal(pool, userId, now) {
  const result = await pool.query(
    `SELECT COALESCE(amount_base, 0)::float AS total
     FROM month_baselines
     WHERE user_id = $1 AND month_key = $2`,
    [userId, monthKey(now)]
  );
  return Number(result.rows[0]?.total ?? 0);
}

async function currentMonthBudget(pool, user, now) {
  const regularAmount = roundMoney(Number(user.monthly_budget_amount ?? 0));
  const result = await pool.query(
    `SELECT COALESCE(budget_amount_base, 0)::float AS budget_amount_base,
            is_partial_month
     FROM monthly_budget_overrides
     WHERE user_id = $1 AND month_key = $2`,
    [user.id, monthKey(now)]
  );
  const override = result.rows[0];
  const amount = override ? roundMoney(Number(override.budget_amount_base ?? 0)) : regularAmount;
  return {
    monthKey: monthKey(now),
    amount,
    regularMonthlyBudget: regularAmount,
    isPartialMonth: Boolean(override?.is_partial_month),
    hasOverride: Boolean(override),
    display: {
      currency: user.display_currency ?? "USD",
      amount: displayFromBase(amount, user)
    }
  };
}

async function moveExpiredPendingDraftsToInbox(pool, telegramUserId, expireAfterMinutes) {
  await pool.query(
    `UPDATE drafts
     SET status = 'inbox'
     WHERE status = 'pending'
       AND created_at < now() - ($2 * interval '1 minute')
       AND user_id = (SELECT id FROM users WHERE telegram_user_id = $1)`,
    [telegramUserId, expireAfterMinutes]
  );
}

async function listPlannedExpensesForTelegramUserAt(pool, telegramUserId, now) {
  const result = await pool.query(
    `SELECT planned_expenses.*, COALESCE(paid.paid_count, 0)::int AS paid_count
     FROM planned_expenses
     JOIN users ON users.id = planned_expenses.user_id
     LEFT JOIN (
       SELECT planned_expense_id, COUNT(*)::int AS paid_count
       FROM planned_expense_payments
       WHERE paid_month = $2
       GROUP BY planned_expense_id
     ) paid ON paid.planned_expense_id = planned_expenses.id
     WHERE users.telegram_user_id = $1 AND planned_expenses.active = true
     ORDER BY planned_expenses.id DESC`,
    [telegramUserId, monthKey(now)]
  );
  return result.rows;
}

function normalizeDraftItem(item) {
  const amount = Number(item.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Expense amount must be positive");
  }
  return {
    amount,
    currency: item.currency || "THB",
    description: String(item.description || "расход").trim(),
    category_slug: item.category_slug || "other",
    tags: Array.isArray(item.tags) ? item.tags.map(String).filter(Boolean) : [],
    spent_at: item.spent_at || new Date().toISOString(),
    budget_impact: ["regular", "planned", "large_oneoff"].includes(item.budget_impact) ? item.budget_impact : "regular",
    confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : 1,
    needs_review: Boolean(item.needs_review)
  };
}

function normalizePlannedExpense(item) {
  const amount = Number(item.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Planned expense amount must be positive");
  const recurrence = ["monthly", "weekly", "twice_monthly", "one_off"].includes(item.recurrence) ? item.recurrence : "monthly";
  const dueDays = normalizeDueDays(item.due_days ?? item.dueDays ?? item.due_day);
  const dueDay = recurrence === "weekly" ? null : (dueDays[0] ?? null);
  return {
    amount,
    currency: item.currency || "THB",
    amount_base: Number(item.amount_base ?? amount),
    description: String(item.description || "плановая трата").trim(),
    category_slug: item.category_slug || "other",
    tags: Array.isArray(item.tags) ? item.tags.map(String).filter(Boolean) : [],
    recurrence,
    due_day: dueDay,
    due_days: recurrence === "weekly" ? [] : dueDays,
    weekday: recurrence === "weekly" ? normalizeWeekday(item.weekday) : null,
    due_date: item.due_date || null,
    active: item.active ?? true
  };
}

function normalizeDueDays(value) {
  const values = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(values
    .map((day) => Number(day))
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 31))]
    .sort((a, b) => a - b);
}

function normalizeWeekday(value) {
  const weekday = Number(value);
  return Number.isInteger(weekday) && weekday >= 1 && weekday <= 7 ? weekday : 1;
}

function normalizeLanguage(value) {
  return ["en", "ru"].includes(value) ? value : "en";
}

function normalizeTheme(value) {
  return ["dark", "light"].includes(value) ? value : "light";
}

async function buildMoneyAmounts(exchangeRates, amount, currency, date, user = {}) {
  const rates = await exchangeRates.ratesFor(date);
  const normalizedCurrency = normalizeCurrency(currency, "THB");
  const baseCurrency = normalizeCurrency(user?.base_currency, "THB");
  const amounts = convertedAmounts(amount, normalizedCurrency, baseCurrency, rates);
  return {
    amountBase: amounts[baseCurrency],
    convertedAmounts: amounts,
    source: rates.source ?? "manual-fallback"
  };
}

function amountBase(amount, currency, rates = {}) {
  const numeric = Number(amount);
  if (currency !== "THB") return roundMoney(numeric * currencyThbRate(currency, rates));
  return roundMoney(numeric);
}

function convertedAmounts(amount, currency, baseCurrency = "THB", rates = {}) {
  const base = amountBase(amount, currency, rates);
  const converted = {};
  for (const code of SUPPORTED_CURRENCY_CODES) {
    converted[code] = code === "THB"
      ? roundMoney(base)
      : roundMoney(currency === code ? Number(amount) : base / currencyThbRate(code, rates));
  }
  converted[baseCurrency] = converted[normalizeCurrency(baseCurrency, "THB")] ?? roundMoney(base);
  return converted;
}

function currencyThbRate(currency, rates = {}) {
  return Number(rates[currency]?.THB ?? fallbackThbRate(currency));
}

function withDisplay(row, user) {
  return {
    ...row,
    display: {
      currency: user.display_currency ?? "USD",
      amount: displayAmount(row, user)
    }
  };
}

function withDisplayTotal(row, user) {
  return {
    ...row,
    display: {
      currency: user.display_currency ?? "USD",
      amount: roundMoney(Number(row.display_total ?? displayFromBase(row.total, user)))
    }
  };
}

function withDisplayPlanned(row, user) {
  return {
    ...row,
    display: {
      currency: user.display_currency ?? "USD",
      amount: displayFromBase(row.amount_base, user)
    }
  };
}

function displayAmount(row, user) {
  const converted = typeof row.converted_amounts === "string"
    ? JSON.parse(row.converted_amounts)
    : row.converted_amounts;
  const currency = user.display_currency ?? "USD";
  if (converted && converted[currency] != null) return roundMoney(Number(converted[currency]));
  return displayFromBase(row.amount_base, user);
}

function displayFromBase(amountBaseValue, user) {
  const currency = user.display_currency ?? "USD";
  const baseCurrency = normalizeCurrency(user.base_currency, "THB");
  const numeric = Number(amountBaseValue);
  if (currency === baseCurrency) return roundMoney(numeric);
  const thbAmount = baseCurrency === "THB" ? numeric : numeric * currencyThbRate(baseCurrency);
  if (currency === "THB") return roundMoney(thbAmount);
  return roundMoney(thbAmount / displayThbRate(user));
}

function displayThbRate(user) {
  const currency = user.display_currency ?? "USD";
  if (currency === "THB") return 1;
  return currency === "USD" ? Number(user.usd_thb_rate ?? fallbackThbRate("USD")) : currencyThbRate(currency);
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function calculatePlannedRemaining(plannedExpenses, now) {
  return plannedExpenses.reduce((sum, item) => {
    const legacyPaid = item.paid_month === monthKey(now) ? 1 : 0;
    const paidCount = Number(item.paid_count ?? legacyPaid);
    const unpaidCount = Math.max(occurrencesThisMonth(item, now) - paidCount, 0);
    return sum + Number(item.amount_base) * unpaidCount;
  }, 0);
}

function calculatePlannedThisWeek(plannedExpenses, now) {
  const bounds = localFullWeekBounds(now);
  return plannedExpenses.reduce((sum, item) => {
    const legacyPaid = item.paid_month === monthKey(now) ? 1 : 0;
    const paidCount = Number(item.paid_count ?? legacyPaid);
    const dueDates = plannedDueDatesThisMonth(item, now)
      .filter((date) => date >= bounds.start && date < bounds.end);
    const unpaidCount = Math.max(dueDates.length - paidCount, 0);
    return sum + Number(item.amount_base) * unpaidCount;
  }, 0);
}

function localFullWeekBounds(now) {
  const current = localPeriodBounds(now, "week");
  return {
    start: current.start,
    end: new Date(current.start.getTime() + 7 * 24 * 60 * 60_000)
  };
}

function plannedDueDatesThisMonth(item, now) {
  if (item.recurrence === "weekly") return weeklyDueDatesThisMonth(now, Number(item.weekday ?? localWeekday(now)));
  if (item.recurrence === "one_off") {
    if (!item.due_date) return [];
    const dueDate = plannedLocalDate(item.due_date);
    return monthKey(dueDate) === monthKey(now) ? [dueDate] : [];
  }
  return dueDaysInMonthValues(item).map((day) => plannedLocalDateForMonthDay(now, day));
}

function occurrencesThisMonth(item, now) {
  if (item.recurrence === "weekly") return weekdaysInMonth(now, Number(item.weekday ?? localWeekday(now)));
  if (item.recurrence === "twice_monthly") return dueDaysInMonth(item);
  if (item.recurrence === "one_off") return item.due_date && monthKey(new Date(item.due_date)) === monthKey(now) ? 1 : 0;
  return dueDaysInMonth(item);
}

function dueDaysInMonth(item) {
  const days = Array.isArray(item.due_days) && item.due_days.length ? item.due_days : [Number(item.due_day ?? 1)];
  return days.filter((day) => Number(day) >= 1 && Number(day) <= 31).length;
}

function dueDaysInMonthValues(item) {
  const days = Array.isArray(item.due_days) && item.due_days.length ? item.due_days : [Number(item.due_day ?? 1)];
  return days.map(Number).filter((day) => day >= 1 && day <= 31);
}

function weekdaysInMonth(now, weekday) {
  const local = new Date(now.getTime() + 7 * 60 * 60_000);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  let count = 0;
  for (let currentDay = 1; currentDay <= daysInMonth; currentDay += 1) {
    const current = new Date(Date.UTC(year, month, currentDay));
    const currentWeekday = current.getUTCDay() === 0 ? 7 : current.getUTCDay();
    if (currentWeekday === weekday) count += 1;
  }
  return count;
}

function weeklyDueDatesThisMonth(now, weekday) {
  const local = new Date(now.getTime() + 7 * 60 * 60_000);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const dates = [];
  for (let currentDay = 1; currentDay <= daysInMonth; currentDay += 1) {
    const current = new Date(Date.UTC(year, month, currentDay));
    const currentWeekday = current.getUTCDay() === 0 ? 7 : current.getUTCDay();
    if (currentWeekday === weekday) dates.push(plannedLocalDateForMonthDay(now, currentDay));
  }
  return dates;
}

function plannedLocalDate(value) {
  const [year, month, day] = String(value).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day) - 7 * 60 * 60_000);
}

function plannedLocalDateForMonthDay(now, day) {
  const local = new Date(now.getTime() + 7 * 60 * 60_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), day) - 7 * 60 * 60_000);
}

function localWeekday(now) {
  const local = new Date(now.getTime() + 7 * 60 * 60_000);
  const weekday = local.getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function startOfLocalDay(now) {
  const local = new Date(now.getTime() + 7 * 60 * 60_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 7 * 60 * 60_000);
}

function monthKey(now) {
  const local = new Date(now.getTime() + 7 * 60 * 60_000);
  const month = String(local.getUTCMonth() + 1).padStart(2, "0");
  return `${local.getUTCFullYear()}-${month}`;
}

function localDayKey(now) {
  const local = new Date(now.getTime() + 7 * 60 * 60_000);
  const month = String(local.getUTCMonth() + 1).padStart(2, "0");
  const day = String(local.getUTCDate()).padStart(2, "0");
  return `${local.getUTCFullYear()}-${month}-${day}`;
}

function plannedPaymentKey(planned, paidAt) {
  if (planned.recurrence === "weekly" || planned.recurrence === "twice_monthly") {
    return `${monthKey(paidAt)}:${paidAt.toISOString().slice(0, 10)}`;
  }
  return monthKey(paidAt);
}

async function totalForPeriod(pool, userId, period, now, user = {}) {
  const bounds = localPeriodBounds(now, period);
  const result = await pool.query(
    `SELECT COALESCE(SUM(amount_base), 0)::float AS total,
            COALESCE(SUM(amount_base) FILTER (WHERE budget_impact = 'regular'), 0)::float AS regular_total,
            COALESCE(SUM(amount_base) FILTER (WHERE budget_impact = 'planned'), 0)::float AS planned_total,
            COALESCE(SUM(amount_base) FILTER (WHERE budget_impact = 'large_oneoff'), 0)::float AS large_oneoff_total,
            COALESCE(SUM(COALESCE(NULLIF(converted_amounts->>$4, '')::float, amount_base / NULLIF($5::numeric, 0))), 0)::float AS display_total,
            COALESCE(SUM(COALESCE(NULLIF(converted_amounts->>$4, '')::float, amount_base / NULLIF($5::numeric, 0))) FILTER (WHERE budget_impact = 'regular'), 0)::float AS regular_display_total,
            COALESCE(SUM(COALESCE(NULLIF(converted_amounts->>$4, '')::float, amount_base / NULLIF($5::numeric, 0))) FILTER (WHERE budget_impact = 'planned'), 0)::float AS planned_display_total,
            COALESCE(SUM(COALESCE(NULLIF(converted_amounts->>$4, '')::float, amount_base / NULLIF($5::numeric, 0))) FILTER (WHERE budget_impact = 'large_oneoff'), 0)::float AS large_oneoff_display_total
     FROM expenses
     WHERE user_id = $1 AND spent_at >= $2 AND spent_at < $3`,
    [userId, bounds.start, bounds.end, user.display_currency ?? "USD", displayThbRate(user)]
  );
  return {
    total: Number(result.rows[0]?.total ?? 0),
    regularTotal: Number(result.rows[0]?.regular_total ?? result.rows[0]?.total ?? 0),
    plannedTotal: Number(result.rows[0]?.planned_total ?? 0),
    largeOneOffTotal: Number(result.rows[0]?.large_oneoff_total ?? 0),
    displayTotal: Number(result.rows[0]?.display_total ?? 0),
    regularDisplayTotal: Number(result.rows[0]?.regular_display_total ?? result.rows[0]?.display_total ?? 0),
    plannedDisplayTotal: Number(result.rows[0]?.planned_display_total ?? 0),
    largeOneOffDisplayTotal: Number(result.rows[0]?.large_oneoff_display_total ?? 0)
  };
}
