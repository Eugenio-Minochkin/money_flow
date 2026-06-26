import { calculateBudgetSnapshot } from "../../../packages/shared/src/budget.js";
import { SUPPORTED_CURRENCY_CODES, fallbackThbRate, normalizeCurrency } from "../../../packages/shared/src/currencies.js";
import {
  localDateKey as sharedLocalDateKey,
  localDateRangeBounds,
  localMonthDay,
  localMonthKey,
  localPeriodBounds,
  localWeekday as sharedLocalWeekday,
  normalizeTimeZone,
  resolveUserTimeZone,
  timeZoneDayKey,
  timeZoneMonthBounds,
  timeZoneMonthKey,
  timeZoneMonthState
} from "../../../packages/shared/src/time.js";
import { calculateReserveState, validateReserveCapacity } from "../../../packages/shared/src/reserve.js";
import { createExchangeRateProvider } from "./exchangeRates.js";

export class DraftCanceledError extends Error {
  constructor() { super("Draft is canceled"); this.name = "DraftCanceledError"; }
}
export class CategoryRequiredError extends Error {
  constructor() { super("Category is required"); this.name = "CategoryRequiredError"; }
}
export class DraftNotFoundError extends Error {
  constructor() { super("Draft not found"); this.name = "DraftNotFoundError"; }
}

export function createRepository(pool, options = {}) {
  const defaultMonthlyBudget = options.defaultMonthlyBudget ?? 45000;
  const exchangeRates = options.exchangeRates ?? createExchangeRateProvider({ fetchImpl: null });

  return {
    async health() {
      await pool.query("SELECT 1 AS ok");
      return { db: true };
    },

    async recordAppEvent(userId, eventName, metadata = {}) {
      try {
        await pool.query(
          `INSERT INTO app_events (user_id, event_name, metadata)
           VALUES ($1, $2, $3::jsonb)`,
          [userId ?? null, eventName, JSON.stringify(metadata ?? {})]
        );
      } catch (error) {
        console.warn("[events] record failed", {
          userId: userId ?? null,
          eventName,
          message: error.message
        });
      }
    },

    async upsertTelegramUser(profile) {
      const result = await pool.query(
        `INSERT INTO users (telegram_user_id, first_name, username, monthly_budget_amount, onboarding_step)
         VALUES ($1, $2, $3, $4, 'language')
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

    async syncUserTimezone(telegramUserId, timeZone) {
      const normalized = normalizeTimeZone(timeZone);
      const result = await pool.query(
        `UPDATE users SET timezone = $1 WHERE telegram_user_id = $2 RETURNING *`,
        [normalized.timeZone, telegramUserId]
      );
      return result.rows[0] ?? null;
    },

    async upsertCurrentReserve(telegramUserId, input, now = new Date()) {
      const user = await this.getUserByTelegramId(telegramUserId);
      if (!user) return null;
      const timeZone = normalizeTimeZone(user.timezone);
      const period = timeZoneMonthKey(now, timeZone);
      const currentBudget = await currentMonthBudget(pool, user, now);
      const plannedExpenses = await listPlannedExpensesForTelegramUserAt(pool, telegramUserId, now);
      const plannedAmount = calculatePlannedTotal(plannedExpenses, now);
      const amount = Number(input.amount);
      const capacity = validateReserveCapacity({
        budgetAmount: currentBudget.amount,
        plannedAmount,
        reserveAmount: amount
      });
      if (!Number.isFinite(amount) || amount <= 0 || !capacity.valid) {
        throw Object.assign(new Error("reserve_exceeds_free_budget"), {
          code: "reserve_exceeds_free_budget"
        });
      }
      const title = normalizeReserveTitle(input.title);
      const reserveResult = await pool.query(
        `INSERT INTO monthly_reserve_instances (
           user_id, period, timezone, currency, budget_amount, reserve_amount, title, status, disabled_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NULL, now())
         ON CONFLICT (user_id, period)
         DO UPDATE SET timezone = EXCLUDED.timezone,
                       currency = EXCLUDED.currency,
                       budget_amount = EXCLUDED.budget_amount,
                       reserve_amount = EXCLUDED.reserve_amount,
                       title = EXCLUDED.title,
                       status = 'active',
                       disabled_at = NULL,
                       updated_at = now()
         WHERE monthly_reserve_instances.status <> 'closed'
         RETURNING *`,
        [user.id, period, timeZone, user.base_currency, currentBudget.amount, amount, title]
      );
      const reserveRow = reserveResult.rows[0] ?? null;
      if (!reserveRow) throw Object.assign(new Error("reserve_period_closed"), { code: "reserve_period_closed" });

      let template = null;
      if (input.scope === "current_and_future" || input.scope === "future") {
        const templateResult = await pool.query(
          `INSERT INTO recurring_reserve_templates (
             user_id, amount, title, currency, is_active, updated_at
           )
           VALUES ($1, $2, $3, $4, true, now())
           ON CONFLICT (user_id)
           DO UPDATE SET amount = EXCLUDED.amount,
                         title = EXCLUDED.title,
                         currency = EXCLUDED.currency,
                         is_active = true,
                         updated_at = now()
           RETURNING *`,
          [user.id, amount, title, user.base_currency]
        );
        template = templateResult.rows[0] ?? null;
      }
      return { reserve: reserveRow, template };
    },

    async disableCurrentReserve(telegramUserId, scope = "current", now = new Date()) {
      const user = await this.getUserByTelegramId(telegramUserId);
      if (!user) return null;
      const period = timeZoneMonthKey(now, normalizeTimeZone(user.timezone));
      const reserveResult = await pool.query(
        `UPDATE monthly_reserve_instances
         SET status = 'disabled', disabled_at = now(), updated_at = now()
         WHERE user_id = $1 AND period = $2 AND status = 'active'
         RETURNING *`,
        [user.id, period]
      );
      let template = null;
      if (scope === "current_and_future") {
        const templateResult = await pool.query(
          `UPDATE recurring_reserve_templates
           SET is_active = false, updated_at = now()
           WHERE user_id = $1
           RETURNING *`,
          [user.id]
        );
        template = templateResult.rows[0] ?? null;
      }
      return { reserve: reserveResult.rows[0] ?? null, template };
    },

    async ackReserveEvents(telegramUserId, eventIds) {
      const ids = [...new Set((eventIds ?? []).map(Number).filter(Number.isInteger))];
      if (!ids.length) return [];
      const result = await pool.query(
        `UPDATE closed_reserve_events
         SET miniapp_delivered_at = now()
         WHERE id = ANY($1::bigint[])
           AND user_id = (SELECT id FROM users WHERE telegram_user_id = $2)
           AND miniapp_delivered_at IS NULL
         RETURNING id`,
        [ids, telegramUserId]
      );
      return result.rows;
    },

    async latestPendingTelegramReserveEvent(telegramUserId) {
      const result = await pool.query(
        `SELECT closed_reserve_events.*
         FROM closed_reserve_events
         JOIN users ON users.id = closed_reserve_events.user_id
         WHERE users.telegram_user_id = $1
           AND closed_reserve_events.telegram_delivered_at IS NULL
         ORDER BY closed_reserve_events.period DESC, closed_reserve_events.id DESC
         LIMIT 1`,
        [telegramUserId]
      );
      return result.rows[0] ?? null;
    },

    async markTelegramReserveEventDelivered(eventId) {
      const result = await pool.query(
        `UPDATE closed_reserve_events
         SET telegram_delivered_at = now()
         WHERE id = $1 AND telegram_delivered_at IS NULL
         RETURNING *`,
        [eventId]
      );
      return result.rows[0] ?? null;
    },

    async openReserveMonth(telegramUserId, now = new Date()) {
      if (typeof pool.connect !== "function") return null;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const userResult = await client.query(
          `SELECT * FROM users WHERE telegram_user_id = $1 FOR UPDATE`,
          [telegramUserId]
        );
        const user = userResult.rows[0];
        if (!user) {
          await client.query("ROLLBACK");
          return null;
        }
        const userTimeZone = normalizeTimeZone(user.timezone);
        const currentPeriod = timeZoneMonthKey(now, userTimeZone);
        const pastResult = await client.query(
          `SELECT * FROM monthly_reserve_instances
           WHERE user_id = $1 AND status = 'active' AND period < $2
           ORDER BY period
           FOR UPDATE`,
          [user.id, currentPeriod]
        );
        for (const instance of pastResult.rows) {
          await closeReserveInstance(client, user, instance, now);
        }

        const currentResult = await client.query(
          `SELECT * FROM monthly_reserve_instances
           WHERE user_id = $1 AND period = $2
           FOR UPDATE`,
          [user.id, currentPeriod]
        );
        let current = currentResult.rows[0] ?? null;
        let recurringReserveBlocked = false;
        if (!current) {
          const templateResult = await client.query(
            `SELECT * FROM recurring_reserve_templates
             WHERE user_id = $1 AND is_active = true
             FOR UPDATE`,
            [user.id]
          );
          const template = templateResult.rows[0];
          if (template) {
            const currentBudget = await currentMonthBudget(client, user, now);
            const plannedAmount = await plannedObligationsForPeriod(client, user.id, currentPeriod, userTimeZone);
            const capacity = validateReserveCapacity({
              budgetAmount: currentBudget.amount,
              plannedAmount,
              reserveAmount: template.amount
            });
            if (capacity.valid) {
              const inserted = await client.query(
                `INSERT INTO monthly_reserve_instances (
                   user_id, period, timezone, currency, budget_amount, reserve_amount, title, status
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
                 ON CONFLICT (user_id, period) DO NOTHING
                 RETURNING *`,
                [user.id, currentPeriod, userTimeZone, template.currency, currentBudget.amount, template.amount, template.title]
              );
              current = inserted.rows[0] ?? null;
            } else {
              recurringReserveBlocked = true;
            }
          }
        }
        await client.query("COMMIT");
        return { current, recurringReserveBlocked };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async setOnboardingStep(telegramUserId, step) {
      const safeStep = ["language", "budget_setup", "base_currency", "monthly_budget", "current_month_budget", "month_opening_spend", "completed"].includes(step) ? step : "completed";
      const result = await pool.query(
        "UPDATE users SET onboarding_step = $1 WHERE telegram_user_id = $2 RETURNING *",
        [safeStep, telegramUserId]
      );
      return result.rows[0] ?? null;
    },

    async updateOnboardingLanguage(telegramUserId, language) {
      const interfaceLanguage = normalizeLanguage(language);
      const result = await pool.query(
        `UPDATE users
         SET interface_language = $1,
             onboarding_step = 'budget_setup',
             onboarding_data = '{}'::jsonb
         WHERE telegram_user_id = $2
         RETURNING *`,
        [interfaceLanguage, telegramUserId]
      );
      return result.rows[0] ?? null;
    },

    async updateOnboardingData(telegramUserId, data) {
      const result = await pool.query(
        `UPDATE users
         SET onboarding_data = $1::jsonb
         WHERE telegram_user_id = $2
         RETURNING *`,
        [JSON.stringify(data ?? {}), telegramUserId]
      );
      return result.rows[0] ?? null;
    },

    async completeOnboardingBudgetSetup(telegramUserId, settings) {
      const baseCurrency = normalizeCurrency(settings.baseCurrency, "THB");
      const monthlyBudgetAmount = Number(settings.monthlyBudgetAmount);
      if (!Number.isFinite(monthlyBudgetAmount) || monthlyBudgetAmount <= 0) {
        throw new Error("Monthly budget must be positive");
      }
      const nextStep = ["current_month_budget", "completed"].includes(settings.nextStep) ? settings.nextStep : "completed";
      const result = await pool.query(
        `UPDATE users
         SET base_currency = $1,
             monthly_budget_amount = $2,
             onboarding_step = $3,
             onboarding_data = '{}'::jsonb
         WHERE telegram_user_id = $4
         RETURNING *`,
        [baseCurrency, monthlyBudgetAmount, nextStep, telegramUserId]
      );
      const user = result.rows[0] ?? null;
      if (user) await invalidateDailyBudgetSnapshot(pool, user.id, new Date(), resolveUserTimeZone(user));
      return user;
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
      const user = result.rows[0] ?? null;
      if (user) await invalidateDailyBudgetSnapshot(pool, user.id, new Date(), resolveUserTimeZone(user));
      return user;
    },

    async setCurrentMonthBudget(telegramUserId, input, now = new Date()) {
      const user = await this.getUserByTelegramId(telegramUserId);
      if (!user) return null;
      const amount = Number(input.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error("Current month budget must be positive");
      }
      const moneyAmounts = await buildMoneyAmounts(exchangeRates, amount, input.currency ?? user.base_currency, now, user);
      await assertReserveBudgetCapacity(pool, user, moneyAmounts.amountBase, now);
      const timeZone = userTimezone(user);
      const result = await pool.query(
        `INSERT INTO monthly_budget_overrides (
           user_id, month_key, budget_amount_base, source, is_partial_month, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, month_key)
         DO UPDATE SET budget_amount_base = EXCLUDED.budget_amount_base,
                       source = EXCLUDED.source,
                       is_partial_month = EXCLUDED.is_partial_month,
                       updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [user.id, monthKey(now, timeZone), moneyAmounts.amountBase, input.source ?? "manual", input.isPartialMonth === true, now]
      );
      await updateOpenReserveBudget(pool, user.id, moneyAmounts.amountBase);
      if (input.completeOnboarding) await this.setOnboardingStep(telegramUserId, "completed");
      await invalidateDailyBudgetSnapshot(pool, user.id, now, resolveUserTimeZone(user));
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
        [user.id, monthKey(now, userTimezone(user)), moneyAmounts.amountBase, input.sourceText ?? null]
      );
      await this.setOnboardingStep(telegramUserId, "completed");
      await invalidateDailyBudgetSnapshot(pool, user.id, now, resolveUserTimeZone(user));
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

    async createReleaseNote(input) {
      const result = await pool.query(
        `INSERT INTO release_notes (
           version, audience, category, title_ru, title_en, body_ru, body_en, is_public
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          input.version,
          input.audience,
          input.category ?? null,
          input.titleRu,
          input.titleEn ?? null,
          input.bodyRu,
          input.bodyEn ?? null,
          input.isPublic !== false
        ]
      );
      return result.rows[0];
    },

    async createReleaseNoteFromSource(input) {
      const result = await pool.query(
        `INSERT INTO release_notes (
           version, audience, category, title_ru, title_en, body_ru, body_en,
           is_public, source_type, source_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (source_type, source_id, audience)
           WHERE source_type IS NOT NULL AND source_id IS NOT NULL
         DO UPDATE SET source_id = EXCLUDED.source_id
         RETURNING *`,
        [
          input.version,
          input.audience,
          input.category ?? null,
          input.titleRu,
          input.titleEn ?? null,
          input.bodyRu,
          input.bodyEn ?? null,
          input.isPublic !== false,
          input.sourceType,
          input.sourceId
        ]
      );
      return result.rows[0];
    },

    async getLatestPublicReleaseVersion() {
      const result = await pool.query(
        `SELECT version
         FROM release_notes
         WHERE audience = 'user'
           AND is_public = true
           AND version ~ '^v\\.1\\.[0-9]+$'
         ORDER BY split_part(version, '.', 3)::numeric DESC
         LIMIT 1`
      );
      return result.rows[0]?.version ?? null;
    },

    async getUnsentPublicReleaseNotesSince(_since, until = new Date()) {
      const result = await pool.query(
        `SELECT *
         FROM release_notes
         WHERE created_at <= $1
           AND sent_at IS NULL
           AND is_public = true
           AND audience = 'user'
         ORDER BY created_at ASC, id ASC`,
        [until]
      );
      return result.rows;
    },

    async getHiddenReleaseNotesSince(since, until = new Date()) {
      const result = await pool.query(
        `SELECT *
         FROM release_notes
         WHERE created_at > COALESCE($1, '-infinity'::timestamptz)
           AND created_at <= $2
           AND audience IN ('admin', 'internal')
         ORDER BY created_at ASC, id ASC`,
        [since, until]
      );
      return result.rows;
    },

    async getLastSuccessfulReleaseDigestRun() {
      const result = await pool.query(
        `SELECT *
         FROM release_digest_runs
         WHERE status = 'success'
         ORDER BY sent_to DESC, id DESC
         LIMIT 1`
      );
      return result.rows[0] ?? null;
    },

    async getReleaseDigestRunForLocalDate(localDate, timezone) {
      const result = await pool.query(
        `SELECT *
         FROM release_digest_runs
         WHERE trigger = 'auto'
           AND digest_local_date = $1
           AND timezone = $2
           AND status IN ('running', 'success', 'skipped')
         ORDER BY id DESC
         LIMIT 1`,
        [localDate, timezone]
      );
      return result.rows[0] ?? null;
    },

    async createReleaseDigestRun(input) {
      try {
        const result = await pool.query(
          `WITH recovered AS (
             UPDATE release_digest_runs
             SET status = 'failed',
                 finished_at = now(),
                 error_message = 'stale_running_run_recovered'
             WHERE status = 'running'
               AND started_at < now() - interval '2 hours'
             RETURNING id
           )
           INSERT INTO release_digest_runs (
             trigger, sent_from, sent_to, digest_local_date, timezone
           )
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [input.trigger, input.sentFrom, input.sentTo, input.digestLocalDate, input.timezone]
        );
        return result.rows[0];
      } catch (error) {
        if (
          error.code === "23505" &&
          [
            "release_digest_runs_auto_date_unique",
            "release_digest_runs_single_running_unique"
          ].includes(error.constraint)
        ) {
          return null;
        }
        throw error;
      }
    },

    async markReleaseDigestRunSuccess(id, summary) {
      await pool.query(
        `UPDATE release_digest_runs
         SET status = 'success',
             finished_at = now(),
             version_from = $2,
             version_to = $3,
             users_count = $4,
             success_count = $5,
             error_count = $6,
             skipped_count = $7,
             blocked_count = $8
         WHERE id = $1`,
        [
          id,
          summary.versionFrom,
          summary.versionTo,
          summary.users,
          summary.success,
          summary.errors,
          summary.skipped ?? 0,
          summary.blocked
        ]
      );
    },

    async markReleaseDigestRunFailed(id, error, summary = {}) {
      await pool.query(
        `UPDATE release_digest_runs
         SET status = 'failed',
             finished_at = now(),
             users_count = $2,
             success_count = $3,
             error_count = $4,
             skipped_count = $5,
             blocked_count = $6,
             error_message = $7
         WHERE id = $1`,
        [
          id,
          summary.users ?? 0,
          summary.success ?? 0,
          summary.errors ?? 0,
          summary.skipped ?? 0,
          summary.blocked ?? 0,
          error.message
        ]
      );
    },

    async markReleaseDigestRunSkipped(id, reason) {
      await pool.query(
        `UPDATE release_digest_runs
         SET status = 'skipped',
             finished_at = now(),
             error_message = $2
         WHERE id = $1`,
        [id, reason]
      );
    },

    async getTodayUnsentPublicReleaseNotes(now = new Date()) {
      const bounds = localDayBounds(now);
      const result = await pool.query(
        `SELECT *
         FROM release_notes
         WHERE released_at >= $1
           AND released_at < $2
           AND sent_at IS NULL
           AND is_public = true
           AND audience = 'user'
         ORDER BY released_at ASC, id ASC`,
        [bounds.start, bounds.end]
      );
      return result.rows;
    },

    async getTodayHiddenReleaseNotes(now = new Date()) {
      const bounds = localDayBounds(now);
      const result = await pool.query(
        `SELECT *
         FROM release_notes
         WHERE released_at >= $1
           AND released_at < $2
           AND audience IN ('admin', 'internal')
         ORDER BY released_at ASC, id ASC`,
        [bounds.start, bounds.end]
      );
      return result.rows;
    },

    async getLatestUnsentPublicReleaseNote(now = new Date()) {
      const notes = await this.getTodayUnsentPublicReleaseNotes(now);
      return notes.at(-1) ?? null;
    },

    async getActiveUsersForReleasePush() {
      const result = await pool.query(
        `SELECT *
         FROM users
         WHERE telegram_user_id IS NOT NULL
           AND onboarding_step = 'completed'
           AND bot_blocked = false
         ORDER BY id ASC`
      );
      return result.rows;
    },

    async hasReleaseNoteDelivery(releaseNoteId, userId) {
      const result = await pool.query(
        `SELECT 1 FROM release_note_deliveries
         WHERE release_note_id = $1 AND user_id = $2`,
        [releaseNoteId, userId]
      );
      return result.rows.length > 0;
    },

    async markReleaseNoteDelivered(releaseNoteId, userId) {
      await pool.query(
        `INSERT INTO release_note_deliveries (release_note_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (release_note_id, user_id) DO NOTHING`,
        [releaseNoteId, userId]
      );
    },

    async markReleaseNotesDelivered(releaseNoteIds, userId) {
      await pool.query(
        `INSERT INTO release_note_deliveries (release_note_id, user_id)
         SELECT release_note_id, $2
         FROM unnest($1::bigint[]) AS release_note_id
         ON CONFLICT DO NOTHING`,
        [releaseNoteIds, userId]
      );
    },

    async countMissingReleaseNoteDeliveries(releaseNoteId) {
      const result = await pool.query(
        `SELECT count(*)::integer AS count
         FROM users u
         WHERE u.telegram_user_id IS NOT NULL
           AND u.onboarding_step = 'completed'
           AND u.bot_blocked = false
           AND NOT EXISTS (
             SELECT 1
             FROM release_note_deliveries d
             WHERE d.release_note_id = $1 AND d.user_id = u.id
           )`,
        [releaseNoteId]
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    async markReleaseNoteSent(releaseNoteId) {
      await pool.query(
        "UPDATE release_notes SET sent_at = now() WHERE id = $1",
        [releaseNoteId]
      );
    },

    async markUserBotBlocked(userId) {
      await pool.query(
        "UPDATE users SET bot_blocked = true WHERE id = $1",
        [userId]
      );
    },

    async updateMonthlyBudget(telegramUserId, monthlyBudgetAmount, now = new Date()) {
      const amount = Number(monthlyBudgetAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error("Monthly budget must be positive");
      }
      if (typeof pool.connect === "function") {
        const user = await this.getUserByTelegramId(telegramUserId);
        if (!user) return null;
        await assertReserveBudgetCapacity(pool, user, amount, new Date());
      }
      const result = await pool.query(
        `UPDATE users
         SET monthly_budget_amount = $1
         WHERE telegram_user_id = $2
         RETURNING *`,
        [amount, telegramUserId]
      );
      const user = result.rows[0] ?? null;
      if (user) await invalidateDailyBudgetSnapshot(pool, user.id, now, resolveUserTimeZone(user));
      return user;
    },

    async updateUserSettings(telegramUserId, settings, now = new Date()) {
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
      const timeZone = normalizeTimeZone(settings.timezone).timeZone;
      if (typeof pool.connect === "function") {
        const currentUser = await this.getUserByTelegramId(telegramUserId);
        if (!currentUser) return null;
        if (baseCurrency !== currentUser.base_currency) {
          await assertReserveCurrencyChangeAllowed(pool, currentUser.id);
        }
        await assertReserveBudgetCapacity(pool, currentUser, monthlyBudgetAmount, new Date());
      }
      const result = await pool.query(
        `UPDATE users
         SET monthly_budget_amount = $1,
             base_currency = $2,
             display_currency = $3,
             usd_thb_rate = $4,
             weekly_budget_amount = $5,
             interface_language = $6,
             budget_advice_enabled = $7,
             interface_theme = $8,
             timezone = $9
         WHERE telegram_user_id = $10
         RETURNING *`,
        [monthlyBudgetAmount, baseCurrency, displayCurrency, usdThbRate, weeklyBudgetAmount, interfaceLanguage, budgetAdviceEnabled, interfaceTheme, timeZone, telegramUserId]
      );
      const user = result.rows[0] ?? null;
      if (user) await invalidateDailyBudgetSnapshot(pool, user.id, new Date(), resolveUserTimeZone(user));
      return user;
    },

    async listDailyReminderCandidates() {
      const result = await pool.query(
        `SELECT *
         FROM users
         WHERE telegram_user_id IS NOT NULL
           AND onboarding_step = 'completed'
           AND bot_blocked = false
           AND daily_entry_reminder_enabled = true
         ORDER BY id ASC`
      );
      return result.rows;
    },

    async hasConfirmedFinancialActivity(userId, bounds) {
      const result = await pool.query(
        `SELECT 1 FROM expenses
         WHERE user_id = $1
           AND spent_at >= $2
           AND spent_at < $3
         LIMIT 1`,
        [userId, bounds.start, bounds.end]
      );
      return result.rows.length > 0;
    },

    async hasNoSpendingMark(userId, localDate) {
      const result = await pool.query(
        `SELECT 1 FROM no_spending_marks
         WHERE user_id = $1 AND local_date = $2`,
        [userId, localDate]
      );
      return result.rows.length > 0;
    },

    async createNoSpendingMark(userId, localDate, timezoneUsed) {
      await pool.query(
        `INSERT INTO no_spending_marks (user_id, local_date, timezone_used)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, local_date) DO NOTHING`,
        [userId, localDate, timezoneUsed]
      );
    },

    async setDailyEntryReminderEnabled(telegramUserId, enabled) {
      const result = await pool.query(
        `UPDATE users
         SET daily_entry_reminder_enabled = $1
         WHERE telegram_user_id = $2
         RETURNING *`,
        [enabled === true, telegramUserId]
      );
      return result.rows[0] ?? null;
    },

    async hasDailyReminderDelivery(userId, localDate, reminderType = "daily_empty_day") {
      const result = await pool.query(
        `SELECT 1 FROM daily_reminder_deliveries
         WHERE user_id = $1 AND local_date = $2 AND reminder_type = $3`,
        [userId, localDate, reminderType]
      );
      return result.rows.length > 0;
    },

    async hasRecentDailyReminderDelivery(userId, since, reminderType = "daily_empty_day") {
      const result = await pool.query(
        `SELECT 1 FROM daily_reminder_deliveries
         WHERE user_id = $1
           AND reminder_type = $2
           AND sent_at >= $3
         LIMIT 1`,
        [userId, reminderType, since]
      );
      return result.rows.length > 0;
    },

    async recordDailyReminderDelivery(input) {
      const result = await pool.query(
        `INSERT INTO daily_reminder_deliveries (
           user_id, local_date, timezone_used, reminder_type, status,
           sent_at, error_code, error_message
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id, local_date, reminder_type) DO NOTHING
         RETURNING *`,
        [
          input.userId,
          input.localDate,
          input.timezoneUsed,
          input.reminderType ?? "daily_empty_day",
          input.status,
          input.sentAt ?? null,
          input.errorCode ?? null,
          input.errorMessage ?? null
        ]
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

    async updateDraftItems(draftId, telegramUserId, items, options = {}) {
      const normalized = items.map(normalizeDraftItem);
      const expectedVersion = options.expectedVersion;
      const sql = expectedVersion == null
        ? `UPDATE drafts
           SET items = $1, version = version + 1
           WHERE id = $2
             AND status IN ('pending', 'inbox')
             AND user_id = (SELECT id FROM users WHERE telegram_user_id = $3)
           RETURNING *`
        : `UPDATE drafts
           SET items = $1, version = version + 1
           WHERE id = $2
             AND status IN ('pending', 'inbox')
             AND version = $4
             AND user_id = (SELECT id FROM users WHERE telegram_user_id = $3)
           RETURNING *`;
      const params = expectedVersion == null
        ? [JSON.stringify(normalized), draftId, telegramUserId]
        : [JSON.stringify(normalized), draftId, telegramUserId, expectedVersion];
      const result = await pool.query(sql, params);
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
      const result = await this.saveDraftAsExpense(draftId, telegramUserId);
      return result.expenses;
    },

    async saveDraftAsExpense(draftId, telegramUserId) {
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
        if (!draft) {
          await client.query("ROLLBACK");
          throw new DraftNotFoundError();
        }
        const status = draft.status;
        if (status !== "pending" && status !== "inbox") {
          await client.query("ROLLBACK");
          if (status === "cancelled") throw new DraftCanceledError();
          // already confirmed -> loser path: return the already-created expenses
          const existing = await pool.query(
            `SELECT * FROM expenses WHERE draft_id = $1 ORDER BY id`,
            [draftId]
          );
          const snapshot = (await this.dashboard(telegramUserId)).snapshot;
          return { expenses: existing.rows, dashboardSnapshot: snapshot, alreadySaved: true };
        }

        const items = Array.isArray(draft.items) ? draft.items : JSON.parse(draft.items);
        if (!draftHasValidCategories(items)) {
          console.warn("[repository] confirm blocked: missing valid category", { draftId });
          throw new CategoryRequiredError();
        }

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
          `UPDATE drafts SET status = 'confirmed', confirmed_at = now(), version = version + 1 WHERE id = $1`,
          [draft.id]
        );
        await client.query("COMMIT");
        const snapshot = (await this.dashboard(telegramUserId)).snapshot;
        return { expenses: inserted, dashboardSnapshot: snapshot, alreadySaved: false };
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* already rolled back or connection gone */ }
        throw error;
      } finally {
        client.release();
      }
    },

    async cancelDraft(draftId, telegramUserId) {
      const result = await pool.query(
        `UPDATE drafts
         SET status = 'cancelled', cancelled_at = now(), version = version + 1
         WHERE id = $1
           AND user_id = (SELECT id FROM users WHERE telegram_user_id = $2)
           AND status IN ('pending', 'inbox')
         RETURNING *`,
        [draftId, telegramUserId]
      );
      if (result.rows[0]) return { canceled: true };
      const current = await pool.query(
        `SELECT status FROM drafts
         WHERE id = $1 AND user_id = (SELECT id FROM users WHERE telegram_user_id = $2)`,
        [draftId, telegramUserId]
      );
      const status = current.rows[0]?.status;
      if (status === "cancelled") return { canceled: false, reason: "already_cancelled" };
      if (status === "confirmed") return { canceled: false, reason: "already_confirmed" };
      return { canceled: false, reason: "not_found" };
    },

    async moveDraftToInbox(draftId, telegramUserId) {
      await pool.query(
        `UPDATE drafts
         SET status = 'inbox', version = version + 1
         WHERE id = $1
           AND user_id = (SELECT id FROM users WHERE telegram_user_id = $2)
           AND status IN ('pending', 'inbox')`,
        [draftId, telegramUserId]
      );
    },

    async setDraftMessageRef(draftId, telegramUserId, chatId, messageId) {
      await pool.query(
        `UPDATE drafts
         SET tg_chat_id = $3, tg_message_id = $4
         WHERE id = $1 AND user_id = (SELECT id FROM users WHERE telegram_user_id = $2)`,
        [draftId, telegramUserId, chatId ?? null, messageId ?? null]
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
             spent_at = $10,
             budget_impact = $11
         WHERE id = $12
           AND user_id = (SELECT id FROM users WHERE telegram_user_id = $13)
         RETURNING id, amount_original, currency_original, description, category_slug, tags, spent_at, budget_impact`,
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
          item.budget_impact,
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
      const validPeriods = ["today", "yesterday", "last7", "week", "month", "previous_month"];
      const period = validPeriods.includes(options.period) ? options.period : "month";
      const fromDate = options.fromDate ? String(options.fromDate) : "";
      const toDate = options.toDate ? String(options.toDate) : "";
      const timeZone = userTimezone(user);
      const bounds = fromDate && toDate
        ? (localDateRangeBounds(fromDate, toDate, timeZone) ?? localPeriodBounds(options.now ?? new Date(), "month", timeZone))
        : localPeriodBounds(options.now ?? new Date(), period, timeZone);
      const search = String(options.search ?? "").trim();
      const params = [user.id, bounds.start, bounds.end];
      let searchSql = "";
      if (search) {
        params.push(`%${search.toLowerCase()}%`);
        const searchParam = `$${params.length}`;
        searchSql = `AND (
          lower(description) LIKE ${searchParam}
          OR lower(category_slug) LIKE ${searchParam}
          OR EXISTS (SELECT 1 FROM unnest(tags) AS tag WHERE lower(tag) LIKE ${searchParam})
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
      const timeZone = userTimezone(user);
      const bounds = localPeriodBounds(now, "month", timeZone);
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
      return listPlannedExpensesForTelegramUserAt(pool, telegramUserId, new Date());
    },

    async createPlannedExpense(telegramUserId, input) {
      const user = await this.getUserByTelegramId(telegramUserId);
      if (!user) return null;
      const planned = normalizePlannedExpense(input);
      const now = new Date();
      const moneyAmounts = await buildMoneyAmounts(exchangeRates, planned.amount, planned.currency, now, user);
      await assertPlannedMutationCapacity(pool, user, {
        ...planned,
        amount_base: moneyAmounts.amountBase,
        active: true
      }, null, now);
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
      const now = new Date();
      const moneyAmounts = await buildMoneyAmounts(exchangeRates, planned.amount, planned.currency, now, user);
      await assertPlannedMutationCapacity(pool, user, {
        ...planned,
        amount_base: moneyAmounts.amountBase
      }, plannedExpenseId, now);
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

    async payPlannedExpenseForTelegramUser(plannedExpenseId, telegramUserId, paidAt = new Date(), options = {}) {
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
        if (!planned) {
          throw Object.assign(new Error("Planned expense not found"), { code: "not_found" });
        }
        const timeZone = userTimezone(planned);
        const paidResult = await client.query(
          `SELECT pep.occurrence_date::text, pep.paid_key
           FROM planned_expense_payments pep
           JOIN expenses e ON e.id = pep.expense_id
                           AND e.user_id = $3
                           AND (pep.occurrence_date IS NULL
                                OR (e.spent_at AT TIME ZONE $4)::date = pep.occurrence_date)
           WHERE pep.planned_expense_id = $1
             AND pep.paid_month = $2
           ORDER BY pep.occurrence_date`,
          [planned.id, monthKey(paidAt, timeZone), planned.user_id, timeZone]
        );
        const requestedOccurrence = resolveOccurrenceDate(planned, paidAt, options.occurrenceDate, paidResult.rows, timeZone);
        if (requestedOccurrence.error) {
          throw Object.assign(new Error(requestedOccurrence.error), { code: requestedOccurrence.code });
        }
        const occurrenceDate = requestedOccurrence.value;

        const paidKey = plannedPaymentKey(planned, occurrenceDate);
        const existingPaidKeys = new Set(paidResult.rows.map((row) => row.paid_key).filter(Boolean));
        if (existingPaidKeys.has(paidKey)) {
          throw Object.assign(new Error("Planned expense is already paid for this month"), { code: "already_paid" });
        }

        const expenseDate = plannedExpenseSpentAt(occurrenceDate, paidAt, timeZone);
        const occurrenceMonth = monthKey(expenseDate, timeZone);
        const moneyAmounts = await buildMoneyAmounts(exchangeRates, planned.amount, planned.currency, expenseDate, planned);
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
            occurrenceDate,
            moneyAmounts.source,
            planned.description,
            planned.category_slug,
            planned.tags ?? [],
            expenseDate,
            "planned"
          ]
        );
        const expense = expenseResult.rows[0];
        await client.query(
          `INSERT INTO planned_expense_payments (planned_expense_id, expense_id, paid_month, paid_at, occurrence_date, paid_key)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (planned_expense_id, paid_key)
           DO UPDATE SET expense_id = EXCLUDED.expense_id, paid_at = EXCLUDED.paid_at, occurrence_date = EXCLUDED.occurrence_date`,
          [planned.id, expense.id, occurrenceMonth, paidAt, occurrenceDate, paidKey]
        );
        await client.query("COMMIT");
        return expense;
      } catch (error) {
        await client.query("ROLLBACK");
        if (error.code === "23505") {
          throw Object.assign(new Error("Planned expense is already paid for this month"), { code: "already_paid" });
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async totals(userId, now = new Date(), timeZone = null) {
      const userResult = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
      const user = userResult.rows[0] ?? {};
      const resolvedTimeZone = timeZone ?? userTimezone(user);
      const [today, week, month] = await Promise.all([
        totalForPeriod(pool, userId, "today", now, user, resolvedTimeZone),
        totalForPeriod(pool, userId, "week", now, user, resolvedTimeZone),
        totalForPeriod(pool, userId, "month", now, user, resolvedTimeZone)
      ]);
      return {
        today: today.regularTotal,
        todayTotal: today.total,
        plannedToday: today.plannedTotal,
        largeToday: today.largeOneOffTotal,
        week: week.regularTotal,
        month: month.total,
        regularWeek: week.regularTotal,
        regularMonth: month.regularTotal,
        plannedMonth: month.plannedTotal,
        largeMonth: month.largeOneOffTotal,
        todayDisplay: today.regularDisplayTotal,
        todayDisplayTotal: today.displayTotal,
        plannedTodayDisplay: today.plannedDisplayTotal,
        largeTodayDisplay: today.largeOneOffDisplayTotal,
        weekDisplay: week.regularDisplayTotal,
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
      const timeZone = userTimezone(user);
      const reserveOpening = typeof pool.connect === "function"
        ? await this.openReserveMonth(telegramUserId, now)
        : null;
      const reserveInstanceResult = typeof pool.connect === "function"
        ? await pool.query(
            `SELECT * FROM monthly_reserve_instances
             WHERE user_id = $1 AND period = $2`,
            [user.id, timeZoneMonthKey(now, normalizeTimeZone(user.timezone))]
          )
        : { rows: [] };
      const reserveInstance = reserveInstanceResult.rows[0] ?? null;
      const calculationTimeZone = reserveInstance?.status === "active"
        ? reserveInstance.timezone
        : timeZone;
      const reserveTemplateResult = typeof pool.connect === "function"
        ? await pool.query(
            `SELECT * FROM recurring_reserve_templates WHERE user_id = $1`,
            [user.id]
          )
        : { rows: [] };
      const pendingReserveEventsResult = typeof pool.connect === "function"
        ? await pool.query(
            `SELECT * FROM closed_reserve_events
             WHERE user_id = $1 AND miniapp_delivered_at IS NULL
             ORDER BY period, id`,
            [user.id]
          )
        : { rows: [] };
      const currentBudget = await currentMonthBudget(pool, user, now, calculationTimeZone);
      const totals = await this.totals(user.id, now, calculationTimeZone);
      const monthBaseline = await monthBaselineTotal(pool, user.id, now, calculationTimeZone);
      totals.month += monthBaseline;
      totals.monthDisplay += displayFromBase(monthBaseline, user);
      totals.regularMonth += monthBaseline;
      totals.regularMonthDisplay += displayFromBase(monthBaseline, user);
      const plannedExpenses = await listPlannedExpensesForTelegramUserAt(pool, telegramUserId, now);
      const plannedRemainingTotal = calculatePlannedRemaining(plannedExpenses, now, calculationTimeZone);
      const plannedThisWeekTotal = calculatePlannedThisWeek(plannedExpenses, now, calculationTimeZone);
      const paidPlannedMonthTotal = await paidPlannedTotalForMonth(pool, user.id, now, calculationTimeZone);
      const rawActiveReserveAmount = reserveInstance?.status === "active" ? Number(reserveInstance.reserve_amount) : 0;
      const activeReserveAmount = roundForDisplayCurrency(rawActiveReserveAmount, user.base_currency);
      const activeReserveDisplayAmount = displayFromBase(activeReserveAmount, user);
      const plannedRemaining = roundForDisplayCurrency(plannedRemainingTotal, user.base_currency);
      const plannedRemainingDisplayTotal = displayFromBase(plannedRemaining, user);
      const plannedThisWeekDisplayTotal = displayFromBase(plannedThisWeekTotal, user);
      const paidPlannedMonthDisplayTotal = displayFromBase(paidPlannedMonthTotal, user);
      const manualWeeklyBudget = user.weekly_budget_amount == null ? null : Number(user.weekly_budget_amount);
      const daysInCurrentMonth = timeZoneMonthState(now, calculationTimeZone).daysInMonth;
      const resolvedWeeklyBudget = roundMoney(
        Number.isFinite(manualWeeklyBudget) && manualWeeklyBudget > 0
          ? manualWeeklyBudget
          : currentBudget.amount * (7 / daysInCurrentMonth)
      );
      const monthRemaining = roundForDisplayCurrency(currentBudget.amount - totals.month, user.base_currency);
      const reservedAhead = roundForDisplayCurrency(plannedRemaining + activeReserveAmount, user.base_currency);
      const freeRemaining = roundForDisplayCurrency(monthRemaining - reservedAhead, user.base_currency);
      const weekRemainingRaw = roundForDisplayCurrency(resolvedWeeklyBudget - totals.week, user.base_currency);
      const weekAvailable = roundForDisplayCurrency(Math.min(weekRemainingRaw, freeRemaining), user.base_currency);
      const dayBudgetSnapshot = await getOrCreateDailyBudgetSnapshot(pool, user, now, {
        todayTotal: totals.today,
        monthTotal: totals.month,
        todayDisplayTotal: totals.todayDisplay,
        monthDisplayTotal: totals.monthDisplay,
        monthlyBudget: currentBudget.amount,
        monthlyBudgetDisplay: displayFromBase(currentBudget.amount, user),
        dayPlanDays: currentBudget.partialPeriodDays,
        weeklyBudget: manualWeeklyBudget,
        weeklyBudgetDisplay: displayFromBase(resolvedWeeklyBudget, user),
        plannedRemainingTotal,
        plannedRemainingDisplayTotal,
        plannedThisWeekTotal,
        plannedThisWeekDisplayTotal,
        paidPlannedMonthTotal,
        largeOneOffMonthTotal: totals.largeMonth,
        reserveAmount: activeReserveAmount,
        reserveDisplayAmount: activeReserveDisplayAmount,
        monthRemainingDisplay: displayFromBase(monthRemaining, user),
        freeRemainingDisplay: displayFromBase(freeRemaining, user),
        reservedAheadDisplay: displayFromBase(reservedAhead, user),
        weekRemainingRawDisplay: displayFromBase(weekRemainingRaw, user),
        weekAvailableDisplay: displayFromBase(weekAvailable, user),
        baseCurrency: user.base_currency ?? "THB",
        displayCurrency: user.display_currency ?? "USD",
        budgetAdviceEnabled: user.budget_advice_enabled !== false,
        timeZone: calculationTimeZone
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
        monthlyBudgetDisplay: displayFromBase(currentBudget.amount, user),
        dayPlanDays: currentBudget.partialPeriodDays,
        weeklyBudget: manualWeeklyBudget,
        weeklyBudgetDisplay: displayFromBase(resolvedWeeklyBudget, user),
        budgetAdviceEnabled: user.budget_advice_enabled !== false,
        reserveAmount: activeReserveAmount,
        reserveDisplayAmount: activeReserveDisplayAmount,
        plannedRemainingTotal,
        plannedRemainingDisplayTotal,
        plannedThisWeekTotal,
        plannedThisWeekDisplayTotal,
        paidPlannedMonthTotal,
        largeOneOffMonthTotal: totals.largeMonth,
        paidPlannedMonthDisplayTotal,
        largeOneOffMonthDisplayTotal: totals.largeMonthDisplay,
        monthRemainingDisplay: displayFromBase(monthRemaining, user),
        freeRemainingDisplay: displayFromBase(freeRemaining, user),
        reservedAheadDisplay: displayFromBase(reservedAhead, user),
        weekRemainingRawDisplay: displayFromBase(weekRemainingRaw, user),
        weekAvailableDisplay: displayFromBase(weekAvailable, user),
        dayPlanLimit: dayBudgetSnapshot.budgetAmountBase,
        dayDisplayPlanLimit: dayBudgetSnapshot.budgetDisplayAmount,
        baseCurrency: user.base_currency ?? "THB",
        timeZone: calculationTimeZone,
        now
      });
      snapshot.todayTotal = roundMoney(totals.todayTotal);
      snapshot.plannedToday = roundMoney(totals.plannedToday);
      snapshot.largeToday = roundMoney(totals.largeToday);
      snapshot.display.todayTotal = roundMoney(totals.todayDisplayTotal);
      snapshot.display.plannedToday = roundMoney(totals.plannedTodayDisplay);
      snapshot.display.largeToday = roundMoney(totals.largeTodayDisplay);
      const topCategories = await this.topCategories(user.id, now);
      const analytics = await dashboardAnalytics(pool, user, topCategories, snapshot, now, calculationTimeZone);
      return {
        user,
        currentMonthBudget: currentBudget,
        reserveInstance,
        reserveTemplate: reserveTemplateResult.rows[0] ?? null,
        recurringReserveBlocked: reserveOpening?.recurringReserveBlocked === true,
        closedReserveEvents: pendingReserveEventsResult.rows,
        snapshot,
        latestExpenses: latest.rows.map((row) => withDisplay(row, user)),
        topCategories,
        analytics,
        plannedExpenses: plannedExpenses.map((row) => withDisplayPlanned(row, user))
      };
    }
  };
}

async function dashboardAnalytics(pool, user, topCategories, snapshot, now, timeZone = userTimezone(user)) {
  const [largestWeek, largestMonth, topTags, dailyHeatmap, previousWeek] = await Promise.all([
    largestExpenseForPeriod(pool, user.id, "week", now, user, timeZone),
    largestExpenseForPeriod(pool, user.id, "month", now, user, timeZone),
    topTagsForMonth(pool, user.id, now, user, timeZone),
    dailyHeatmapForMonth(pool, user.id, now, timeZone),
    totalForPreviousWeek(pool, user.id, now, user, timeZone)
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
      previous: previousWeek.regularTotal,
      delta: roundMoney(snapshot.week - previousWeek.regularTotal),
      display: {
        currency: user.display_currency ?? "USD",
        current: snapshot.display.week,
        previous: previousWeek.regularDisplayTotal,
        delta: roundMoney(snapshot.display.week - previousWeek.regularDisplayTotal)
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

async function largestExpenseForPeriod(pool, userId, period, now, user, timeZone = userTimezone(user)) {
  const bounds = localPeriodBounds(now, period, timeZone);
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

async function topTagsForMonth(pool, userId, now, user, timeZone = userTimezone(user)) {
  const bounds = localPeriodBounds(now, "month", timeZone);
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

async function dailyHeatmapForMonth(pool, userId, now, timeZone = "Asia/Bangkok") {
  const bounds = localPeriodBounds(now, "month", timeZone);
  const result = await pool.query(
    `SELECT EXTRACT(DAY FROM (spent_at AT TIME ZONE $4))::int AS day,
            COALESCE(SUM(amount_base), 0)::float AS total
     FROM expenses
     WHERE user_id = $1 AND spent_at >= $2 AND spent_at < $3
     GROUP BY day
     ORDER BY day`,
    [userId, bounds.start, bounds.end, timeZone]
  );
  return result.rows.map((row) => ({
    day: Number(row.day),
    total: roundMoney(Number(row.total))
  }));
}

async function totalForPreviousWeek(pool, userId, now, user, timeZone = userTimezone(user)) {
  const week = localPeriodBounds(now, "week", timeZone);
  const previousNow = new Date(week.start.getTime() - 24 * 60 * 60_000);
  return totalForPeriod(pool, userId, "week", previousNow, user, timeZone);
}

async function paidPlannedTotalForMonth(pool, userId, now, timeZone = "Asia/Bangkok") {
  const bounds = localPeriodBounds(now, "month", timeZone);
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

async function invalidateDailyBudgetSnapshot(pool, userId, now = new Date(), timeZone = "Asia/Bangkok") {
  if (userId == null) return;
  await pool.query(
    `DELETE FROM daily_budget_snapshots
     WHERE user_id = $1 AND day_key = $2`,
    [userId, timeZoneDayKey(now, timeZone)]
  );
}

async function getOrCreateDailyBudgetSnapshot(pool, user, now, input) {
  const timeZone = resolveUserTimeZone(user);
  const dayKey = timeZoneDayKey(now, timeZone);
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
    now,
    timeZone
  });
  const dayBudgetBase = Number(snapshot.safeToSpendPerDay ?? snapshot.dayPlanLimit ?? 0);
  const dayBudgetDisplay = Number(snapshot.display?.safeToSpendPerDay ?? snapshot.display?.dayPlanLimit ?? 0);
  const inserted = await pool.query(
    `INSERT INTO daily_budget_snapshots (user_id, day_key, budget_amount_base, budget_display_amount)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, day_key)
     DO UPDATE SET budget_amount_base = daily_budget_snapshots.budget_amount_base
     RETURNING budget_amount_base, budget_display_amount`,
    [user.id, dayKey, dayBudgetBase, dayBudgetDisplay]
  );
  return {
    budgetAmountBase: Number(inserted.rows[0]?.budget_amount_base ?? dayBudgetBase),
    budgetDisplayAmount: Number(inserted.rows[0]?.budget_display_amount ?? dayBudgetDisplay)
  };
}

export function isCategoryValid(item) {
  if (!item) return false;
  if (item.category_source === "user") return true;
  return item.category_slug !== "other" && !item.needs_review;
}

export function draftHasValidCategories(items) {
  return Array.isArray(items) && items.length > 0 && items.every(isCategoryValid);
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

async function monthBaselineTotal(pool, userId, now, timeZone = "Asia/Bangkok") {
  const result = await pool.query(
    `SELECT COALESCE(amount_base, 0)::float AS total
     FROM month_baselines
     WHERE user_id = $1 AND month_key = $2`,
    [userId, monthKey(now, timeZone)]
  );
  return Number(result.rows[0]?.total ?? 0);
}

async function currentMonthBudget(pool, user, now, timeZone = userTimezone(user)) {
  const regularAmount = roundMoney(Number(user.monthly_budget_amount ?? 0));
  const result = await pool.query(
    `SELECT COALESCE(budget_amount_base, 0)::float AS budget_amount_base,
            is_partial_month,
            created_at,
            updated_at
     FROM monthly_budget_overrides
     WHERE user_id = $1 AND month_key = $2`,
    [user.id, monthKey(now, timeZone)]
  );
  const override = result.rows[0];
  const amount = override ? roundMoney(Number(override.budget_amount_base ?? 0)) : regularAmount;
  const isPartialMonth = Boolean(override?.is_partial_month);
  const effectiveDate = override?.updated_at ?? override?.created_at ?? null;
  const partialPeriodDays = isPartialMonth
    ? partialMonthPeriodDays(effectiveDate ?? now, now, normalizeTimeZone(user.timezone))
    : null;
  return {
    monthKey: monthKey(now, timeZone),
    amount,
    regularMonthlyBudget: regularAmount,
    isPartialMonth,
    hasOverride: Boolean(override),
    effectiveDate,
    partialPeriodDays,
    display: {
      currency: user.display_currency ?? "USD",
      amount: displayFromBase(amount, user)
    }
  };
}

function partialMonthPeriodDays(effectiveDate, now, timeZone) {
  const effectiveMonth = timeZoneMonthState(new Date(effectiveDate), timeZone);
  const currentMonth = timeZoneMonthState(now, timeZone);
  const effectiveDay = effectiveMonth.period === currentMonth.period
    ? effectiveMonth.dayOfMonth
    : currentMonth.dayOfMonth;
  return Math.max(currentMonth.daysInMonth - effectiveDay + 1, 1);
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
  const userResult = await pool.query("SELECT timezone FROM users WHERE telegram_user_id = $1", [telegramUserId]);
  const timeZone = userTimezone(userResult.rows[0] ?? {});
  const result = await pool.query(
    `SELECT planned_expenses.*,
            users.timezone,
            COALESCE(paid.paid_count, 0)::int AS paid_count,
            COALESCE(paid.paid_occurrence_dates, '{}'::text[]) AS paid_occurrence_dates,
            COALESCE(paid.paid_occurrences, '{}'::jsonb) AS paid_occurrences
     FROM planned_expenses
     JOIN users ON users.id = planned_expenses.user_id
     LEFT JOIN (
       SELECT pep.planned_expense_id,
              COUNT(*)::int AS paid_count,
              array_agg(DISTINCT pep.occurrence_date::text ORDER BY pep.occurrence_date::text)
                FILTER (WHERE pep.occurrence_date IS NOT NULL) AS paid_occurrence_dates,
              COALESCE(jsonb_object_agg(
                pep.occurrence_date::text,
                jsonb_build_object('expense_id', pep.expense_id, 'paid_at', pep.paid_at)
              ) FILTER (WHERE pep.occurrence_date IS NOT NULL), '{}'::jsonb) AS paid_occurrences
       FROM planned_expense_payments pep
       JOIN planned_expenses pe ON pe.id = pep.planned_expense_id
       JOIN users pu ON pu.id = pe.user_id
     JOIN expenses e ON e.id = pep.expense_id
                     AND e.user_id = pe.user_id
                     AND (pep.occurrence_date IS NULL
                          OR (e.spent_at AT TIME ZONE COALESCE(NULLIF(pu.timezone, ''), 'Asia/Bangkok'))::date = pep.occurrence_date)
     WHERE pep.paid_month = $2
       GROUP BY pep.planned_expense_id
     ) paid ON paid.planned_expense_id = planned_expenses.id
     WHERE users.telegram_user_id = $1 AND planned_expenses.active = true
     ORDER BY planned_expenses.id DESC`,
    [telegramUserId, monthKey(now, timeZone)]
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
    category_source: item.category_source === "user" || item.category_source === "parser" ? item.category_source : null,
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
  const requestedRecurrence = item.recurrence === "one_time" ? "one_off" : item.recurrence;
  const recurrence = ["monthly", "weekly", "twice_monthly", "one_off"].includes(requestedRecurrence) ? requestedRecurrence : "monthly";
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

function userTimezone(user) {
  return normalizeTimeZone(user?.timezone).timeZone;
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

const ZERO_DECIMAL_DISPLAY_CURRENCIES = ["THB", "RUB", "IDR", "BYN"];
const TWO_DECIMAL_DISPLAY_CURRENCIES = ["USD", "EUR", "GEL"];

function roundForDisplayCurrency(value, currency) {
  const decimals = displayDecimalsForCurrency(currency);
  const factor = 10 ** decimals;
  return Math.round((Number(value ?? 0) + Number.EPSILON) * factor) / factor;
}

function displayDecimalsForCurrency(currency) {
  const normalized = normalizeCurrency(currency, "THB");
  if (ZERO_DECIMAL_DISPLAY_CURRENCIES.includes(normalized)) return 0;
  if (TWO_DECIMAL_DISPLAY_CURRENCIES.includes(normalized)) return 2;
  return 2;
}

function calculatePlannedRemaining(plannedExpenses, now, timeZone = "Asia/Bangkok") {
  return plannedExpenses.reduce((sum, item) => {
    return sum + Number(item.amount_base) * unpaidPlannedDueDatesThisMonth(item, now, timeZone).length;
  }, 0);
}

function calculatePlannedTotal(plannedExpenses, now) {
  return plannedExpenses.reduce((sum, item) => {
    return sum + Number(item.amount_base) * plannedDueDatesThisMonth(item, now).length;
  }, 0);
}

function normalizeReserveTitle(value) {
  const title = String(value ?? "").trim();
  return title || null;
}

async function assertReserveBudgetCapacity(pool, user, budgetAmount, now) {
  if (typeof pool.connect !== "function") return;
  const result = await pool.query(
    `SELECT * FROM monthly_reserve_instances
     WHERE user_id = $1 AND status = 'active'
     ORDER BY period DESC
     LIMIT 1`,
    [user.id]
  );
  const reserve = result.rows[0];
  if (!reserve) return;
  const plannedAmount = await plannedObligationsForPeriod(
    pool,
    user.id,
    reserve.period,
    reserve.timezone
  );
  const capacity = validateReserveCapacity({
    budgetAmount,
    plannedAmount,
    reserveAmount: reserve.reserve_amount
  });
  if (!capacity.valid) {
    throw Object.assign(new Error("reserve_conflicts_with_budget_change"), {
      code: "reserve_conflicts_with_budget_change"
    });
  }
}

async function updateOpenReserveBudget(pool, userId, budgetAmount) {
  if (typeof pool.connect !== "function") return;
  await pool.query(
    `UPDATE monthly_reserve_instances
     SET budget_amount = $2, updated_at = now()
     WHERE user_id = $1 AND status = 'active'`,
    [userId, budgetAmount]
  );
}

async function assertReserveCurrencyChangeAllowed(pool, userId) {
  if (typeof pool.connect !== "function") return;
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM monthly_reserve_instances
       WHERE user_id = $1 AND status = 'active'
     ) OR EXISTS (
       SELECT 1 FROM recurring_reserve_templates
       WHERE user_id = $1 AND is_active = true
     ) AS blocked`,
    [userId]
  );
  if (result.rows[0]?.blocked) {
    throw Object.assign(new Error("reserve_blocks_base_currency_change"), {
      code: "reserve_blocks_base_currency_change"
    });
  }
}

async function assertPlannedMutationCapacity(pool, user, changedPlan, changedPlanId, now) {
  if (typeof pool.connect !== "function" || changedPlan.active === false) return;
  const reserveResult = await pool.query(
    `SELECT * FROM monthly_reserve_instances
     WHERE user_id = $1 AND status = 'active'
     ORDER BY period DESC
     LIMIT 1`,
    [user.id]
  );
  const reserve = reserveResult.rows[0];
  if (!reserve) return;
  const plansResult = await pool.query(
    `SELECT * FROM planned_expenses
     WHERE user_id = $1 AND active = true`,
    [user.id]
  );
  const plans = plansResult.rows.filter((item) => String(item.id) !== String(changedPlanId));
  plans.push(changedPlan);
  const plannedAmount = roundMoney(plans.reduce((sum, item) => (
    sum + Number(item.amount_base) * plannedOccurrenceCountForPeriod(item, reserve.period)
  ), 0));
  const capacity = validateReserveCapacity({
    budgetAmount: reserve.budget_amount,
    plannedAmount,
    reserveAmount: reserve.reserve_amount
  });
  if (!capacity.valid) {
    throw Object.assign(new Error("reserve_conflicts_with_planned_change"), {
      code: "reserve_conflicts_with_planned_change"
    });
  }
}

async function closeReserveInstance(client, user, instance, now) {
  const plannedAmount = await plannedObligationsForPeriod(
    client,
    user.id,
    instance.period,
    instance.timezone
  );
  const bounds = timeZoneMonthBounds(instance.period, instance.timezone);
  const spentResult = await client.query(
    `SELECT COALESCE(SUM(amount_base), 0)::float AS regular_spent_amount
     FROM expenses
     WHERE user_id = $1
       AND spent_at >= $2
       AND spent_at < $3
       AND budget_impact = 'regular'`,
    [user.id, bounds.start, bounds.end]
  );
  const regularSpentAmount = Number(spentResult.rows[0]?.regular_spent_amount ?? 0);
  const state = calculateReserveState({
    budgetAmount: Number(instance.budget_amount),
    plannedAmount,
    reserveAmount: Number(instance.reserve_amount),
    regularSpentAmount
  });
  const closedResult = await client.query(
    `UPDATE monthly_reserve_instances
     SET status = 'closed',
         planned_amount = $2,
         regular_spent_amount = $3,
         saved_amount = $4,
         eaten_amount = $5,
         over_budget_amount = $6,
         closed_at = $7,
         updated_at = now()
     WHERE id = $1 AND status = 'active'
     RETURNING *`,
    [
      instance.id,
      plannedAmount,
      regularSpentAmount,
      state.savedAmount,
      state.eatenAmount,
      state.overBudgetAmount,
      now
    ]
  );
  const closed = closedResult.rows[0];
  if (!closed) return null;
  await client.query(
    `INSERT INTO closed_reserve_events (
       monthly_reserve_instance_id, user_id, period, title, currency,
       reserve_amount, saved_amount, eaten_amount, over_budget_amount, status, closed_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (monthly_reserve_instance_id) DO NOTHING`,
    [
      closed.id,
      user.id,
      closed.period,
      closed.title,
      closed.currency,
      closed.reserve_amount,
      state.savedAmount,
      state.eatenAmount,
      state.overBudgetAmount,
      state.status,
      now
    ]
  );
  return closed;
}

async function plannedObligationsForPeriod(client, userId, period, timeZone) {
  const [year, month] = period.split("-").map(Number);
  const nextPeriod = month === 12
    ? `${year + 1}-01`
    : `${year}-${String(month + 1).padStart(2, "0")}`;
  const plansResult = await client.query(
    `SELECT planned_expenses.*,
            COUNT(planned_expense_payments.id)::int AS paid_count
     FROM planned_expenses
     LEFT JOIN planned_expense_payments
       ON planned_expense_payments.planned_expense_id = planned_expenses.id
      AND planned_expense_payments.occurrence_date >= $2::date
      AND planned_expense_payments.occurrence_date < $3::date
     WHERE planned_expenses.user_id = $1
     GROUP BY planned_expenses.id`,
    [
      userId,
      `${period}-01`,
      `${nextPeriod}-01`
    ]
  );
  return roundMoney(plansResult.rows.reduce((sum, item) => {
    const occurrenceCount = plannedOccurrenceCountForPeriod(item, period);
    const paidCount = Math.min(Number(item.paid_count ?? 0), occurrenceCount);
    const includedCount = item.active === false ? paidCount : occurrenceCount;
    return sum + Number(item.amount_base) * includedCount;
  }, 0));
}

function plannedOccurrenceCountForPeriod(item, period) {
  const [year, month] = period.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (item.recurrence === "weekly") {
    let count = 0;
    for (let day = 1; day <= daysInMonth; day += 1) {
      const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
      if (weekday === Number(item.weekday)) count += 1;
    }
    return count;
  }
  if (item.recurrence === "one_off" || item.recurrence === "one_time") {
    return String(item.due_date ?? "").slice(0, 7) === period ? 1 : 0;
  }
  const days = Array.isArray(item.due_days) && item.due_days.length
    ? item.due_days
    : [Number(item.due_day ?? 1)];
  return new Set(days.map(Number).filter((day) => day >= 1).map((day) => Math.min(day, daysInMonth))).size;
}

function calculatePlannedThisWeek(plannedExpenses, now, timeZone = "Asia/Bangkok") {
  const bounds = localFullWeekBounds(now, timeZone);
  return plannedExpenses.reduce((sum, item) => {
    const dueDates = unpaidPlannedDueDatesThisMonth(item, now, timeZone)
      .filter((date) => date >= bounds.start && date < bounds.end);
    return sum + Number(item.amount_base) * dueDates.length;
  }, 0);
}

function localFullWeekBounds(now, timeZone = "Asia/Bangkok") {
  const current = localPeriodBounds(now, "week", timeZone);
  return {
    start: current.start,
    end: new Date(current.start.getTime() + 7 * 24 * 60 * 60_000)
  };
}

function plannedDueDatesThisMonth(item, now, timeZone = userTimezone(item)) {
  if (item.recurrence === "weekly") return weeklyDueDatesThisMonth(now, Number(item.weekday ?? localWeekday(now, timeZone)), timeZone);
  if (item.recurrence === "one_off" || item.recurrence === "one_time") {
    if (!item.due_date) return [];
    const dueDate = plannedLocalDate(item.due_date, timeZone);
    return monthKey(dueDate, timeZone) === monthKey(now, timeZone) ? [dueDate] : [];
  }
  return dueDaysInMonthValues(item, now, timeZone).map((day) => plannedLocalDateForMonthDay(now, day, timeZone));
}

function unpaidPlannedDueDatesThisMonth(item, now, timeZone = userTimezone(item)) {
  const dueDates = plannedDueDatesThisMonth(item, now, timeZone);
  const paidDates = new Set(Array.isArray(item.paid_occurrence_dates) ? item.paid_occurrence_dates : []);
  if (paidDates.size) return dueDates.filter((date) => !paidDates.has(localDayKey(date, timeZone)));
  const legacyPaid = item.paid_month === monthKey(now, timeZone) ? 1 : 0;
  const paidCount = Math.min(Number(item.paid_count ?? legacyPaid), dueDates.length);
  return dueDates.slice(paidCount);
}

function occurrencesThisMonth(item, now) {
  const timeZone = userTimezone(item);
  if (item.recurrence === "weekly") return weekdaysInMonth(now, Number(item.weekday ?? localWeekday(now, timeZone)), timeZone);
  if (item.recurrence === "twice_monthly") return dueDaysInMonth(item);
  if (item.recurrence === "one_off" || item.recurrence === "one_time") return item.due_date && monthKey(new Date(item.due_date), timeZone) === monthKey(now, timeZone) ? 1 : 0;
  return dueDaysInMonth(item);
}

function dueDaysInMonth(item) {
  const days = Array.isArray(item.due_days) && item.due_days.length ? item.due_days : [Number(item.due_day ?? 1)];
  return days.filter((day) => Number(day) >= 1 && Number(day) <= 31).length;
}

function dueDaysInMonthValues(item, now, timeZone = userTimezone(item)) {
  const days = Array.isArray(item.due_days) && item.due_days.length ? item.due_days : [Number(item.due_day ?? 1)];
  const [year, month] = monthKey(now, timeZone).split("-").map(Number);
  const daysInCurrentMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return [...new Set(days.map(Number).filter((day) => day >= 1).map((day) => Math.min(day, daysInCurrentMonth)))]
    .sort((left, right) => left - right);
}

function weekdaysInMonth(now, weekday, timeZone = "Asia/Bangkok") {
  const [year, monthKeyValue] = monthKey(now, timeZone).split("-").map(Number);
  const month = monthKeyValue - 1;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  let count = 0;
  for (let currentDay = 1; currentDay <= daysInMonth; currentDay += 1) {
    const current = new Date(Date.UTC(year, month, currentDay));
    const currentWeekday = current.getUTCDay() === 0 ? 7 : current.getUTCDay();
    if (currentWeekday === weekday) count += 1;
  }
  return count;
}

function weeklyDueDatesThisMonth(now, weekday, timeZone = "Asia/Bangkok") {
  const [year, monthKeyValue] = monthKey(now, timeZone).split("-").map(Number);
  const month = monthKeyValue - 1;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const dates = [];
  for (let currentDay = 1; currentDay <= daysInMonth; currentDay += 1) {
    const current = new Date(Date.UTC(year, month, currentDay));
    const currentWeekday = current.getUTCDay() === 0 ? 7 : current.getUTCDay();
    if (currentWeekday === weekday) dates.push(plannedLocalDateForMonthDay(now, currentDay, timeZone));
  }
  return dates;
}

function plannedLocalDate(value, timeZone = "Asia/Bangkok") {
  const [year, month, day] = String(value).slice(0, 10).split("-").map(Number);
  return localPeriodBounds(new Date(Date.UTC(year, month - 1, day, 12)), "today", timeZone).start;
}

function plannedExpenseSpentAt(occurrenceDate, paidAt = new Date(), timeZone = "Asia/Bangkok") {
  const occurrenceKey = String(occurrenceDate).slice(0, 10);
  if (occurrenceKey === localDayKey(paidAt, timeZone)) return paidAt;
  const [year, month, day] = occurrenceKey.split("-").map(Number);
  const start = localPeriodBounds(new Date(Date.UTC(year, month - 1, day, 12)), "today", timeZone).start;
  return new Date(start.getTime() + 12 * 60 * 60_000);
}

function plannedLocalDateForMonthDay(now, day, timeZone = "Asia/Bangkok") {
  const [year, month] = monthKey(now, timeZone).split("-").map(Number);
  return localPeriodBounds(new Date(Date.UTC(year, month - 1, day, 12)), "today", timeZone).start;
}

function localWeekday(now, timeZone = "Asia/Bangkok") {
  return sharedLocalWeekday(now, timeZone);
}

function startOfLocalDay(now, timeZone = "Asia/Bangkok") {
  return localPeriodBounds(now, "today", timeZone).start;
}

function monthKey(now, timeZone = "Asia/Bangkok") {
  return localMonthKey(now, timeZone);
}

function localDayKey(now, timeZone = "Asia/Bangkok") {
  return sharedLocalDateKey(now, timeZone);
}

function localDayBounds(now, timeZone = "Asia/Bangkok") {
  const start = startOfLocalDay(now, timeZone);
  return {
    start,
    end: new Date(start.getTime() + 24 * 60 * 60_000)
  };
}

function nextUnpaidOccurrenceDate(planned, now, paidOccurrenceDates = [], timeZone = userTimezone(planned)) {
  const paid = new Set(paidOccurrenceDates.filter(Boolean).map((date) => String(date).slice(0, 10)));
  const unpaid = plannedDueDatesThisMonth(planned, now, timeZone)
    .map((date) => localDayKey(date, timeZone))
    .filter((date) => !paid.has(date));
  const today = localDayKey(now, timeZone);
  return unpaid.filter((date) => date <= today).sort()[0] ?? unpaid.filter((date) => date > today).sort()[0] ?? null;
}

function resolveOccurrenceDate(planned, now, requested, paidRows = [], timeZone = userTimezone(planned)) {
  if (!requested) {
    const fallback = nextUnpaidOccurrenceDate(planned, now, paidRows.map((row) => row.occurrence_date), timeZone);
    if (!fallback) return { error: "Planned expense is already paid for this month", code: "already_paid" };
    return { value: fallback };
  }
  const normalized = normalizeOccurrenceKey(requested);
  if (!normalized) return { error: "Invalid occurrence date", code: "invalid_occurrence" };
  const dueDates = new Set(plannedDueDatesThisMonth(planned, now, timeZone).map((date) => localDayKey(date, timeZone)));
  if (!dueDates.has(normalized)) return { error: "Invalid occurrence date", code: "invalid_occurrence" };
  const today = localDayKey(now, timeZone);
  if (normalized > today) return { error: "Occurrence is in the future", code: "future_occurrence" };
  const paidDates = new Set(paidRows.map((row) => String(row.occurrence_date ?? "").slice(0, 10)));
  if (paidDates.has(normalized)) return { error: "Planned expense is already paid for this month", code: "already_paid" };
  return { value: normalized };
}

function normalizeOccurrenceKey(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) {
    return null;
  }
  return `${year}-${month}-${day}`;
}

function plannedPaymentKey(planned, occurrenceDate) {
  if (planned.recurrence === "weekly" || planned.recurrence === "twice_monthly") {
    return `${String(occurrenceDate).slice(0, 7)}:${occurrenceDate}`;
  }
  return String(occurrenceDate).slice(0, 7);
}

async function totalForPeriod(pool, userId, period, now, user = {}, timeZone = userTimezone(user)) {
  const bounds = localPeriodBounds(now, period, timeZone);
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
