import { calculateBudgetSnapshot } from "../../../packages/shared/src/budget.js";
import { localPeriodBounds } from "../../../packages/shared/src/time.js";

export function createRepository(pool, options = {}) {
  const defaultMonthlyBudget = options.defaultMonthlyBudget ?? 45000;

  return {
    async upsertTelegramUser(profile) {
      const result = await pool.query(
        `INSERT INTO users (telegram_user_id, first_name, username, monthly_budget_amount)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (telegram_user_id)
         DO UPDATE SET first_name = EXCLUDED.first_name, username = EXCLUDED.username
         RETURNING *`,
        [profile.id, profile.firstName ?? null, profile.username ?? null, defaultMonthlyBudget]
      );
      return result.rows[0];
    },

    async getUserByTelegramId(telegramUserId) {
      const result = await pool.query("SELECT * FROM users WHERE telegram_user_id = $1", [telegramUserId]);
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

    async confirmDraft(draftId, telegramUserId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const draftResult = await client.query(
          `SELECT drafts.*, users.base_currency
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
          const result = await client.query(
            `INSERT INTO expenses (
               user_id, draft_id, amount_original, currency_original, amount_base, base_currency,
               converted_amounts, exchange_rate_date, description, category_slug, tags, spent_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             RETURNING *`,
            [
              draft.user_id,
              draft.id,
              item.amount,
              item.currency,
              item.currency === draft.base_currency ? item.amount : item.amount,
              draft.base_currency,
              JSON.stringify({ [draft.base_currency]: item.amount }),
              spentAt.toISOString().slice(0, 10),
              item.description,
              item.category_slug,
              item.tags ?? [],
              spentAt
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

    async totals(userId, now = new Date()) {
      const [today, month] = await Promise.all([
        totalForPeriod(pool, userId, "today", now),
        totalForPeriod(pool, userId, "month", now)
      ]);
      return { today, month };
    },

    async dashboard(telegramUserId, now = new Date()) {
      const user = await this.getUserByTelegramId(telegramUserId);
      if (!user) return null;
      const totals = await this.totals(user.id, now);
      const latest = await pool.query(
        `SELECT id, amount_original, currency_original, description, category_slug, tags, spent_at
         FROM expenses
         WHERE user_id = $1
         ORDER BY spent_at DESC
         LIMIT 5`,
        [user.id]
      );
      const snapshot = calculateBudgetSnapshot({
        todayTotal: totals.today,
        monthTotal: totals.month,
        monthlyBudget: Number(user.monthly_budget_amount),
        now
      });
      return { user, snapshot, latestExpenses: latest.rows };
    }
  };
}

async function totalForPeriod(pool, userId, period, now) {
  const bounds = localPeriodBounds(now, period);
  const result = await pool.query(
    `SELECT COALESCE(SUM(amount_base), 0)::float AS total
     FROM expenses
     WHERE user_id = $1 AND spent_at >= $2 AND spent_at < $3`,
    [userId, bounds.start, bounds.end]
  );
  return Number(result.rows[0].total);
}
