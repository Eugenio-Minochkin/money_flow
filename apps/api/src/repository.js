import { calculateBudgetSnapshot } from "../../../packages/shared/src/budget.js";
import crypto from "node:crypto";
import { SUPPORTED_CURRENCY_CODES, fallbackThbRate, isSupportedCurrency, normalizeCurrency } from "../../../packages/shared/src/currencies.js";
import {
  localDateKey as sharedLocalDateKey,
  localDateRangeBounds,
  localMonthDay,
  localMonthKey,
  localPeriodBounds,
  normalizeTimeZone,
  resolveUserTimeZone,
  timeZoneDayKey,
  timeZoneMonthBounds,
  timeZoneMonthKey,
  timeZoneMonthState
} from "../../../packages/shared/src/time.js";
import { calculateReserveState, validateReserveCapacity } from "../../../packages/shared/src/reserve.js";
import { createExchangeRateProvider } from "./exchangeRates.js";
import { matchesExpenseSearch, parseAmountSearch } from "./expenseSearch.js";
import {
  normalizePlannedDateKey,
  plannedOccurrenceDateKeysForPeriod
} from "./plannedOccurrenceDates.js";
import { normalizeAcquisitionSource, SINGLETON_ONBOARDING_EVENTS } from "./productAnalytics.js";
import { buildReportMetrics } from "./reportService.js";
import { formatReportMoney } from "./reportFormat.js";
import { priorMonthlyBounds, priorWeeklyBounds } from "./reportPeriods.js";
import { categoryLabel } from "../../../packages/shared/src/categories.js";
import { classifyExplicitAcceptanceDraft } from "./smartSave.js";
import { classifyExpenseEvidenceDuplicate } from "./expenseEvidenceDedupe.js";
import {
  MONTHLY_CHANGE_ABSOLUTE_TOTAL_SHARE,
  MONTHLY_CHANGE_RELATIVE_MIN,
  categoryChanges,
  categoryPercentages,
  largestExpenses,
  monthlyTakeaway,
  needsAttentionFromUnpaid,
  weeklyComparison,
  weeklyTakeaway
} from "./reportAnalytics.js";

const INVALID_PLANNED_DUE_DATE_LOGGED = Symbol("invalidPlannedDueDateLogged");
const ACCOUNT_DELETION_TTL_MINUTES = 15;
const ACCOUNT_DELETION_SOURCES = new Set(["miniapp", "telegram"]);

export class DraftCanceledError extends Error {
  constructor() { super("Draft is canceled"); this.name = "DraftCanceledError"; }
}
export class CategoryRequiredError extends Error {
  constructor() { super("Category is required"); this.name = "CategoryRequiredError"; }
}
export class DraftNotFoundError extends Error {
  constructor() { super("Draft not found"); this.name = "DraftNotFoundError"; }
}
export class BudgetTopupDraftNotFoundError extends Error {
  constructor() { super("Budget top-up draft not found"); this.name = "BudgetTopupDraftNotFoundError"; }
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

    async recordAppEventOnce(userId, eventName, metadata = {}) {
      if (!SINGLETON_ONBOARDING_EVENTS.has(eventName)) {
        throw codedError("Invalid singleton event", "invalid_singleton_event");
      }
      try {
        const result = await pool.query(
          `INSERT INTO app_events (user_id, event_name, metadata)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [userId, eventName, JSON.stringify(metadata ?? {})]
        );
        return { recorded: (result.rowCount ?? result.rows?.length ?? 0) > 0 };
      } catch (error) {
        console.warn("[events] record failed", {
          userId: userId ?? null,
          eventName,
          message: error.message
        });
        return { recorded: false };
      }
    },

    async reservePaidProviderUsage({ userId, provider, windowMs, maxRequests, maxAudioSeconds, audioSeconds = 0, requestUnits = 1, requestKey = null }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const requestKeyHash = requestKey == null ? null : hashPaidProviderRequestKey(requestKey);
        await client.query(
          `INSERT INTO paid_provider_usage_windows (user_id, provider)
           VALUES ($1, $2)
           ON CONFLICT (user_id, provider) DO NOTHING`,
          [userId, provider]
        );
        const selected = await client.query(
          `SELECT window_started_at, request_count, audio_seconds,
                  now() - window_started_at >= ($3::bigint * interval '1 millisecond') AS reset_due
           FROM paid_provider_usage_windows
           WHERE user_id = $1 AND provider = $2 FOR UPDATE`,
          [userId, provider, windowMs]
        );
        const row = selected.rows[0];
        if (requestKeyHash) {
          const existing = await client.query(
            `SELECT 1 FROM paid_provider_usage_reservations
             WHERE user_id = $1 AND provider = $2 AND request_key_hash = $3`,
            [userId, provider, requestKeyHash]
          );
          if (existing.rows[0]) {
            await client.query("COMMIT");
            return { allowed: true, replayed: true };
          }
        }
        const requestCount = row.reset_due ? 0 : Number(row.request_count);
        const usedAudioSeconds = row.reset_due ? 0 : Number(row.audio_seconds);
        const nextRequests = requestCount + Number(requestUnits);
        const nextAudioSeconds = usedAudioSeconds + Number(audioSeconds);
        if (nextRequests > Number(maxRequests) || (maxAudioSeconds != null && nextAudioSeconds > Number(maxAudioSeconds))) {
          await client.query("ROLLBACK");
          return { allowed: false };
        }
        await client.query(
          `UPDATE paid_provider_usage_windows
           SET window_started_at = CASE WHEN $3 THEN now() ELSE window_started_at END,
               request_count = $4, audio_seconds = $5
           WHERE user_id = $1 AND provider = $2`,
          [userId, provider, row.reset_due, nextRequests, nextAudioSeconds]
        );
        if (requestKeyHash) {
          await client.query(
            `INSERT INTO paid_provider_usage_reservations (user_id, provider, request_key_hash)
             VALUES ($1, $2, $3)`,
            [userId, provider, requestKeyHash]
          );
        }
        await client.query("COMMIT");
        return { allowed: true };
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
        throw error;
      } finally { client.release(); }
    },

    async createFeedback(input) {
      const message = String(input.message ?? "").trim();
      const result = await pool.query(
        `INSERT INTO feedback (user_id, telegram_user_id, message, status, source)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          input.userId ?? null,
          input.telegramUserId,
          message,
          input.status ?? "new",
          input.source ?? "bot"
        ]
      );
      const feedback = result.rows[0] ?? null;
      if (feedback && input.userId != null) {
        await this.recordAppEvent(input.userId, "feedback_sent", {
          source: input.source === "miniapp" ? "miniapp" : "telegram"
        });
      }
      return feedback;
    },

    async upsertTelegramUser(profile) {
      const acquisitionSource = normalizeAcquisitionSource(profile.acquisitionSource);
      const acquisitionSeenAt = profile.acquisitionSeenAt instanceof Date
        ? profile.acquisitionSeenAt
        : new Date(profile.acquisitionSeenAt ?? Date.now());
      const result = await pool.query(
        `INSERT INTO users (
           telegram_user_id, first_name, username, monthly_budget_amount, onboarding_step,
           acquisition_source, acquisition_first_seen_at
         )
         VALUES ($1, $2, $3, $4, 'language', $5, $6)
         ON CONFLICT (telegram_user_id)
         DO UPDATE SET
           first_name = COALESCE(EXCLUDED.first_name, users.first_name),
           username = COALESCE(EXCLUDED.username, users.username),
           acquisition_source = COALESCE(users.acquisition_source, EXCLUDED.acquisition_source),
           acquisition_first_seen_at = COALESCE(users.acquisition_first_seen_at, EXCLUDED.acquisition_first_seen_at)
         RETURNING *, (xmax = 0) AS is_new`,
        [
          profile.id,
          profile.firstName ?? null,
          profile.username ?? null,
          defaultMonthlyBudget,
          acquisitionSource,
          acquisitionSeenAt
        ]
      );
      return result.rows[0];
    },

    async getUserByTelegramId(telegramUserId) {
      const result = await pool.query("SELECT * FROM users WHERE telegram_user_id = $1", [telegramUserId]);
      return result.rows[0] ?? null;
    },

    async claimExpenseEvidenceImport(userId, chatId, messageId) {
      const result = await pool.query(
        `INSERT INTO expense_evidence_imports AS imports (user_id, source_chat_id, source_message_id, image_bytes_hmac, status, claim_version, lease_expires_at)
         VALUES ($1, $2, $3, 'pending', 'processing', 1, now() + interval '60 seconds')
         ON CONFLICT (user_id, source_chat_id, source_message_id) DO UPDATE
           SET claim_version = imports.claim_version + 1, lease_expires_at = now() + interval '60 seconds'
         WHERE imports.status = 'processing' AND imports.lease_expires_at <= now()
         RETURNING claim_version`,
        [userId, chatId, messageId]
      );
      if (result.rows[0]) return { state: 'claimed', claimVersion: result.rows[0].claim_version };
      const prior = await pool.query(
        `SELECT id, status FROM expense_evidence_imports WHERE user_id = $1 AND source_chat_id = $2 AND source_message_id = $3`,
        [userId, chatId, messageId]
      );
      return prior.rows[0] ? { state: prior.rows[0].status, id: prior.rows[0].id } : null;
    },

    async releaseExpenseEvidenceImport(userId, chatId, messageId, claimVersion) {
      await pool.query(
        `UPDATE expense_evidence_imports SET status = 'failed', lease_expires_at = NULL, failure_code = 'analysis_failed', updated_at = now()
         WHERE user_id = $1 AND source_chat_id = $2 AND source_message_id = $3 AND status = 'processing' AND claim_version = $4`,
        [userId, chatId, messageId, claimVersion]
      );
    },

    async completeExpenseEvidenceImport({ userId, chatId, messageId, claimVersion, imageBytesHmac, telegramFileHmac, candidateSetHmac, candidates }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const claimed = await client.query(
          `SELECT id FROM expense_evidence_imports WHERE user_id = $1 AND source_chat_id = $2 AND source_message_id = $3
           AND status = 'processing' AND claim_version = $4 AND lease_expires_at > now() FOR UPDATE`,
          [userId, chatId, messageId, claimVersion]
        );
        const importRow = claimed.rows[0];
        if (!importRow) { await client.query('ROLLBACK'); return null; }
        for (const candidate of candidates) {
          const draftStatus = candidate.items.some((item) => item.needs_review) ? 'inbox' : 'pending';
          const draft = await client.query(
            `INSERT INTO drafts (user_id, status, source_text, items) VALUES ($1, $2, 'Image evidence import', $3) RETURNING id`,
            [userId, draftStatus, JSON.stringify(candidate.items)]
          );
          await client.query(
            `INSERT INTO expense_evidence_candidates (import_id, ordinal, evidence_type, draft_id, status, dedupe_classification, dedupe_reason_code)
             VALUES ($1, $2, $3, $4, 'ready', $5, $6)`,
            [importRow.id, candidate.ordinal, candidate.evidenceType, draft.rows[0].id, candidate.dedupeClassification, candidate.dedupeReasonCode]
          );
        }
        const completed = await client.query(
          `UPDATE expense_evidence_imports SET image_bytes_hmac = $5, telegram_file_hmac = $6, candidate_set_hmac = $7,
             status = 'ready', lease_expires_at = NULL, completed_at = now(), updated_at = now()
           WHERE id = $1 RETURNING id`,
          [importRow.id, userId, chatId, messageId, imageBytesHmac, telegramFileHmac, candidateSetHmac]
        );
        await client.query('COMMIT');
        return completed.rows[0];
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    },

    async startOrResumeExpenseEvidenceSession({ userId, chatId, ttlMs }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
        await client.query(
          `UPDATE expense_evidence_sessions SET status = 'expired', updated_at = now()
           WHERE user_id = $1 AND source_chat_id = $2 AND status = 'collecting' AND expires_at <= now()`,
          [userId, chatId]
        );
        const existing = await client.query(
          `SELECT id, status, expires_at FROM expense_evidence_sessions
           WHERE user_id = $1 AND source_chat_id = $2 AND status = 'collecting' AND expires_at > now()
           FOR UPDATE`,
          [userId, chatId]
        );
        if (existing.rows[0]) {
          const resumed = await client.query(
            `UPDATE expense_evidence_sessions SET expires_at = now() + ($2 * interval '1 millisecond'), updated_at = now()
             WHERE id = $1 RETURNING id, status, expires_at`,
            [existing.rows[0].id, ttlMs]
          );
          await client.query("COMMIT");
          return evidenceSessionResult(resumed.rows[0], "resumed");
        }
        const created = await client.query(
          `INSERT INTO expense_evidence_sessions (user_id, source_chat_id, status, expires_at)
           VALUES ($1, $2, 'collecting', now() + ($3 * interval '1 millisecond'))
           RETURNING id, status, expires_at`,
          [userId, chatId, ttlMs]
        );
        await client.query("COMMIT");
        return evidenceSessionResult(created.rows[0], "started");
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
        throw error;
      } finally { client.release(); }
    },

    async linkExpenseEvidenceImportToSession({ userId, chatId, sessionId, importId }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const session = await client.query(
          `SELECT id FROM expense_evidence_sessions
           WHERE id = $1 AND user_id = $2 AND source_chat_id = $3
             AND status = 'collecting' AND expires_at > now()
           FOR UPDATE`,
          [sessionId, userId, chatId]
        );
        if (!session.rows[0]) { await client.query("ROLLBACK"); return { state: "unavailable" }; }
        const imported = await client.query(
          `SELECT id FROM expense_evidence_imports
           WHERE id = $1 AND user_id = $2 AND source_chat_id = $3 AND status IN ('ready', 'completed')
           FOR UPDATE`,
          [importId, userId, chatId]
        );
        if (!imported.rows[0]) { await client.query("ROLLBACK"); return { state: "unavailable" }; }
        const linked = await client.query(
          `INSERT INTO expense_evidence_session_imports (session_id, import_id, ordinal)
           VALUES ($1, $2, (SELECT COALESCE(MAX(ordinal) + 1, 0) FROM expense_evidence_session_imports WHERE session_id = $1))
           ON CONFLICT (session_id, import_id) DO UPDATE SET import_id = EXCLUDED.import_id
           RETURNING ordinal`,
          [sessionId, importId]
        );
        await client.query("COMMIT");
        return { state: "linked", ordinal: linked.rows[0].ordinal };
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
        throw error;
      } finally { client.release(); }
    },

    async finishExpenseEvidenceSession({ userId, chatId, sessionId }) {
      const result = await pool.query(
        `UPDATE expense_evidence_sessions SET status = 'ready', completed_at = now(), updated_at = now(), lease_expires_at = NULL
         WHERE id = $1 AND user_id = $2 AND source_chat_id = $3 AND status = 'collecting' AND expires_at > now()
         RETURNING id, status`,
        [sessionId, userId, chatId]
      );
      return result.rows[0] ? { state: result.rows[0].status, id: result.rows[0].id } : { state: "unavailable" };
    },

    async cancelExpenseEvidenceSession({ userId, chatId, sessionId }) {
      const result = await pool.query(
        `UPDATE expense_evidence_sessions SET status = 'cancelled', completed_at = now(), updated_at = now(), lease_expires_at = NULL
         WHERE id = $1 AND user_id = $2 AND source_chat_id = $3 AND status IN ('collecting', 'finalizing', 'ready')
         RETURNING id, status`,
        [sessionId, userId, chatId]
      );
      return result.rows[0] ? { state: result.rows[0].status, id: result.rows[0].id } : { state: "unavailable" };
    },

    async expireExpenseEvidenceSessions() {
      const result = await pool.query(
        `UPDATE expense_evidence_sessions SET status = 'expired', updated_at = now(), lease_expires_at = NULL
         WHERE status = 'collecting' AND expires_at <= now()`
      );
      return result.rowCount ?? 0;
    },

    async getExpenseEvidenceSessionCandidates({ userId, sessionId }) {
      const result = await pool.query(
        `SELECT sessions.id AS session_id, imports.id AS import_id, links.ordinal AS import_ordinal,
                candidates.id AS candidate_id, candidates.ordinal AS candidate_ordinal, candidates.evidence_type,
                candidates.draft_id, candidates.status AS candidate_status, candidates.dedupe_classification,
                candidates.dedupe_reason_code
         FROM expense_evidence_sessions AS sessions
         JOIN expense_evidence_session_imports AS links ON links.session_id = sessions.id
         JOIN expense_evidence_imports AS imports ON imports.id = links.import_id
         JOIN expense_evidence_candidates AS candidates ON candidates.import_id = imports.id
         WHERE sessions.user_id = $1 AND sessions.id = $2
         ORDER BY links.ordinal, candidates.ordinal`,
        [userId, sessionId]
      );
      return result.rows.map((row) => ({
        sessionId: row.session_id,
        importId: row.import_id,
        importOrdinal: row.import_ordinal,
        candidateId: row.candidate_id,
        candidateOrdinal: row.candidate_ordinal,
        evidenceType: row.evidence_type,
        draftId: row.draft_id,
        status: row.candidate_status,
        dedupeClassification: row.dedupe_classification,
        dedupeReasonCode: row.dedupe_reason_code
      }));
    },

    async listExpenseEvidenceDuplicateCandidates(userId, client = pool, excludedDraftId = null) {
      const result = await client.query(
        `SELECT expenses.amount_original AS amount, expenses.currency_original AS currency,
                to_char(expenses.spent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "spentOn", to_char(expenses.spent_at AT TIME ZONE 'UTC', 'HH24:MI') AS "spentAt",
                item->>'merchant' AS merchant
         FROM expenses
         LEFT JOIN drafts ON drafts.id = expenses.draft_id
         LEFT JOIN LATERAL jsonb_array_elements(drafts.items) AS item ON item->>'description' = expenses.description
         WHERE expenses.user_id = $1
         UNION ALL
         SELECT (item->>'amount')::numeric AS amount, item->>'currency' AS currency,
                substring(item->>'spent_at', 1, 10) AS "spentOn", substring(item->>'spent_at', 12, 5) AS "spentAt",
                item->>'description' AS merchant
         FROM drafts CROSS JOIN LATERAL jsonb_array_elements(items) AS item
         WHERE drafts.user_id = $1 AND drafts.status IN ('pending', 'inbox') AND ($2::bigint IS NULL OR drafts.id <> $2)`,
        [userId, excludedDraftId]
      );
      return result.rows;
    },

    async getExpenseEvidenceImport(userId, importId) {
      const result = await pool.query(
        `SELECT imports.id, imports.status, imports.candidate_set_hmac, imports.created_at, imports.completed_at,
                candidates.id AS candidate_id, candidates.ordinal, candidates.evidence_type, candidates.draft_id,
                candidates.status AS candidate_status, candidates.dedupe_classification, candidates.dedupe_reason_code
         FROM expense_evidence_imports AS imports
         LEFT JOIN expense_evidence_candidates AS candidates ON candidates.import_id = imports.id
         WHERE imports.id = $1 AND imports.user_id = $2
         ORDER BY candidates.ordinal`,
        [importId, userId]
      );
      if (!result.rows[0]) return null;
      const first = result.rows[0];
      return {
        id: first.id,
        status: first.status,
        candidateSetHmac: first.candidate_set_hmac,
        createdAt: first.created_at,
        completedAt: first.completed_at,
        candidates: result.rows.filter((row) => row.candidate_id != null).map((row) => ({
          id: row.candidate_id, ordinal: row.ordinal, evidenceType: row.evidence_type, draftId: row.draft_id,
          status: row.candidate_status, dedupeClassification: row.dedupe_classification, dedupeReasonCode: row.dedupe_reason_code
        }))
      };
    },

    async getActiveExpenseEvidenceCandidateForDraft(userId, draftId) {
      const result = await pool.query(
        `SELECT candidates.import_id, candidates.id AS candidate_id, candidates.draft_id, candidates.status AS candidate_status
         FROM expense_evidence_candidates AS candidates
         JOIN expense_evidence_imports AS imports ON imports.id = candidates.import_id
         WHERE imports.user_id = $1 AND candidates.draft_id = $2 AND candidates.status IN ('ready', 'reviewing')`,
        [userId, draftId]
      );
      return normalizeEvidenceCandidateLink(result.rows[0]);
    },

    async markExpenseEvidenceCandidateSavedForDraft(userId, draftId) {
      const result = await pool.query(
        `UPDATE expense_evidence_candidates AS candidates
         SET status = 'saved', resolved_at = now(), updated_at = now()
         FROM expense_evidence_imports AS imports
         WHERE candidates.import_id = imports.id AND imports.user_id = $1 AND candidates.draft_id = $2
           AND candidates.status IN ('ready', 'reviewing')
         RETURNING candidates.import_id, candidates.id AS candidate_id, candidates.draft_id, candidates.status AS candidate_status`,
        [userId, draftId]
      );
      return normalizeEvidenceCandidateLink(result.rows[0]);
    },

    async resolveExpenseEvidenceCandidate({ userId, importId, candidateId, action }) {
      const client = await pool.connect();
      let reviewingCandidateId = null;
      try {
        await client.query("BEGIN");
        const locked = await client.query(
          `SELECT candidates.id AS candidate_id, candidates.status AS candidate_status, candidates.draft_id, users.telegram_user_id
           FROM expense_evidence_candidates AS candidates
           JOIN expense_evidence_imports AS imports ON imports.id = candidates.import_id
           JOIN users ON users.id = imports.user_id
           WHERE candidates.id = $1 AND candidates.import_id = $2 AND imports.user_id = $3
           FOR UPDATE`,
          [candidateId, importId, userId]
        );
        const candidate = locked.rows[0];
        if (!candidate) { await client.query("ROLLBACK"); return { state: "not_found" }; }
        if (["saved", "already_accounted", "cancelled", "reviewing"].includes(candidate.candidate_status)) {
          await client.query("ROLLBACK");
          return { state: candidate.candidate_status, draftId: candidate.draft_id };
        }
        if (action === "already_accounted") {
          await client.query(
            `UPDATE expense_evidence_candidates SET status = 'already_accounted', resolved_at = now(), updated_at = now() WHERE id = $1`,
            [candidate.candidate_id]
          );
          await client.query("COMMIT");
          return { state: "already_accounted", draftId: candidate.draft_id };
        }
        if (action === "cancel") {
          if (candidate.draft_id) {
            await client.query(
              `UPDATE drafts SET status = 'cancelled', cancelled_at = now(), version = version + 1
               WHERE id = $1 AND status IN ('pending', 'inbox')`,
              [candidate.draft_id]
            );
          }
          await client.query(
            `UPDATE expense_evidence_candidates SET status = 'cancelled', resolved_at = now(), updated_at = now() WHERE id = $1`,
            [candidate.candidate_id]
          );
          await client.query("COMMIT");
          return { state: "cancelled", draftId: candidate.draft_id };
        }
        if (!["save", "add"].includes(action) || !candidate.draft_id) { await client.query("ROLLBACK"); return { state: "invalid_action" }; }

        if (candidate.candidate_status === "likely_duplicate" && action !== "add") {
          await client.query("ROLLBACK");
          return { state: "blocked", reasonCode: "likely_duplicate" };
        }
        await client.query(
          `UPDATE expense_evidence_candidates SET status = 'reviewing', updated_at = now() WHERE id = $1`,
          [candidate.candidate_id]
        );
        reviewingCandidateId = candidate.candidate_id;
        let saved;
        try {
          saved = await this.saveDraftAsExpense(candidate.draft_id, candidate.telegram_user_id, {
            explicitCategoryAcceptance: true,
            client,
            beforeSave: async (draft) => {
              if (action === "add") return;
              const current = evidenceCandidateFromDraft(draft);
              const existing = await this.listExpenseEvidenceDuplicateCandidates(userId, client, candidate.draft_id);
              const duplicate = current && classifyExpenseEvidenceDuplicate(current, existing);
              if (duplicate?.classification === "likely_duplicate") throw evidenceDuplicateError(duplicate.reasonCode);
            }
          });
        } catch (error) {
          if (error?.code !== "evidence_likely_duplicate") throw error;
          await client.query(
            `UPDATE expense_evidence_candidates SET status = 'likely_duplicate', dedupe_classification = 'likely_duplicate', dedupe_reason_code = $2, updated_at = now() WHERE id = $1`,
            [candidate.candidate_id, error.reasonCode]
          );
          await client.query("COMMIT");
          return { state: "blocked", reasonCode: error.reasonCode };
        }
        await client.query(
          `UPDATE expense_evidence_candidates SET status = 'saved', resolved_at = now(), updated_at = now() WHERE id = $1 AND status IN ('ready', 'reviewing')`,
          [candidate.candidate_id]
        );
        await client.query("COMMIT");
        return { state: "saved", draftId: candidate.draft_id, alreadySaved: Boolean(saved.alreadySaved) };
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* preserve the original error */ }
        if (reviewingCandidateId != null) {
          try {
            await pool.query(
              `UPDATE expense_evidence_candidates SET status = 'ready', updated_at = now()
               WHERE id = $1 AND status = 'reviewing'`,
              [reviewingCandidateId]
            );
          } catch { /* preserve the original error */ }
        }
        throw error;
      } finally { client.release(); }
    },

    async prepareQuickAccessToken(userId, tokenHash) {
      const result = await pool.query(
        `INSERT INTO quick_access_tokens (user_id, token_hash, prepared_expires_at)
         VALUES ($1, $2, now() + interval '10 minutes')
         RETURNING *`,
        [userId, tokenHash]
      );
      return result.rows[0] ?? null;
    },

    async activatePreparedQuickAccessToken(userId, preparationId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const owner = await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
        if (!owner.rows[0]) { await client.query("ROLLBACK"); return { state: "not_found" }; }
        const prepared = await client.query(
          `SELECT id, activated_at, revoked_at, prepared_expires_at > now() AS preparation_valid
           FROM quick_access_tokens
           WHERE id = $1 AND user_id = $2
           FOR UPDATE`,
          [preparationId, userId]
        );
        const token = prepared.rows[0] ?? null;
        if (!token) { await client.query("ROLLBACK"); return { state: "not_found" }; }
        if (token.activated_at) {
          await client.query("ROLLBACK");
          return { state: token.revoked_at ? "superseded" : "active" };
        }
        if (!token.preparation_valid || token.revoked_at) { await client.query("ROLLBACK"); return { state: "expired" }; }
        await client.query(
          "UPDATE quick_access_tokens SET revoked_at = now() WHERE user_id = $1 AND activated_at IS NOT NULL AND revoked_at IS NULL",
          [userId]
        );
        const activated = await client.query(
          "UPDATE quick_access_tokens SET activated_at = now(), prepared_expires_at = NULL WHERE id = $1 AND user_id = $2 AND activated_at IS NULL AND revoked_at IS NULL RETURNING id",
          [preparationId, userId]
        );
        if (!activated.rows[0]) { await client.query("ROLLBACK"); return { state: "expired" }; }
        await client.query("COMMIT");
        return { state: "activated" };
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* preserve the original error */ }
        throw error;
      } finally { client.release(); }
    },

    async revokeQuickAccessTokens(userId) {
      const result = await pool.query(
        "UPDATE quick_access_tokens SET revoked_at = now() WHERE user_id = $1 AND activated_at IS NOT NULL AND revoked_at IS NULL RETURNING id",
        [userId]
      );
      return result.rowCount > 0;
    },

    async getQuickAccessStatus(userId) {
      const result = await pool.query(
        `SELECT last_used_at FROM quick_access_tokens
         WHERE user_id = $1 AND activated_at IS NOT NULL AND revoked_at IS NULL
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [userId]
      );
      const token = result.rows[0] ?? null;
      return { configured: Boolean(token), lastUsedAt: token?.last_used_at ?? null };
    },

    async findQuickAccessToken(tokenHash) {
      const result = await pool.query(
        `UPDATE quick_access_tokens AS token SET last_used_at = now()
         FROM users WHERE token.user_id = users.id AND token.token_hash = $1 AND token.activated_at IS NOT NULL AND token.revoked_at IS NULL
         RETURNING token.id AS token_id, users.*`,
        [tokenHash]
      );
      return result.rows[0] ?? null;
    },

    async claimMiniAppQuickCaptureRequest(userId, clientRequestId) {
      const claimed = await pool.query(
        `INSERT INTO quick_capture_requests AS requests (user_id, client_request_id, status, claim_version, lease_expires_at)
         VALUES ($1, $2, 'processing', 1, now() + interval '60 seconds')
         ON CONFLICT (user_id, client_request_id) DO UPDATE
           SET claim_version = requests.claim_version + 1,
               lease_expires_at = now() + interval '60 seconds'
         WHERE requests.status = 'processing' AND requests.lease_expires_at <= now()
         RETURNING claim_version`,
        [userId, clientRequestId]
      );
      if (claimed.rows[0]) return { state: "claimed", claimVersion: claimed.rows[0].claim_version };
      return this.readMiniAppQuickCaptureRequest(userId, clientRequestId);
    },

    async readMiniAppQuickCaptureRequest(userId, clientRequestId) {
      const result = await pool.query(
        `SELECT requests.status AS request_status, drafts.* FROM quick_capture_requests requests
         LEFT JOIN drafts ON drafts.id = requests.draft_id
         WHERE requests.user_id = $1 AND requests.client_request_id = $2`,
        [userId, clientRequestId]
      );
      const row = result.rows[0] ?? null;
      if (!row) return null;
      return row.request_status === "completed" ? { state: "completed", draft: normalizeDraft(row) } : { state: "processing" };
    },

    async waitForMiniAppQuickCaptureRequest(userId, clientRequestId) {
      for (let attempt = 0; attempt < 1200; attempt += 1) {
        const result = await this.readMiniAppQuickCaptureRequest(userId, clientRequestId);
        if (!result || result.state === "completed") return result;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return null;
    },

    async releaseMiniAppQuickCaptureRequest(userId, clientRequestId, claimVersion) {
      await pool.query(
        `DELETE FROM quick_capture_requests
         WHERE user_id = $1 AND client_request_id = $2
           AND status = 'processing' AND claim_version = $3`,
        [userId, clientRequestId, claimVersion]
      );
    },

    async completeMiniAppQuickCaptureRequest({ userId, clientRequestId, claimVersion, sourceText, items }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const prior = await client.query(
          `SELECT id, status, claim_version, lease_expires_at > now() AS lease_active
           FROM quick_capture_requests
           WHERE user_id = $1 AND client_request_id = $2 FOR UPDATE`,
          [userId, clientRequestId]
        );
        if (!prior.rows[0] || prior.rows[0].status !== "processing" || String(prior.rows[0].claim_version) !== String(claimVersion) || !prior.rows[0].lease_active) { await client.query("ROLLBACK"); return null; }
        const status = items.some((item) => item.needs_review) ? "inbox" : "pending";
        const created = await client.query(
          "INSERT INTO drafts (user_id, status, source_text, items) VALUES ($1, $2, $3, $4) RETURNING *",
          [userId, status, sourceText, JSON.stringify(items)]
        );
        const completed = await client.query(
          `UPDATE quick_capture_requests
           SET draft_id = $3, status = 'completed', completed_at = now(), lease_expires_at = NULL
           WHERE user_id = $1 AND client_request_id = $2 AND status = 'processing'
             AND claim_version = $4 AND lease_expires_at > now()
           RETURNING id`,
          [userId, clientRequestId, created.rows[0].id, claimVersion]
        );
        if (completed.rowCount !== 1) throw new Error("quick_capture_claim_lost");
        await client.query("COMMIT");
        return { draft: normalizeDraft(created.rows[0]) };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    },

    async claimTelegramExpenseCapture(userId, chatId, messageId, payload = null) {
      const hasPayload = payload != null;
      const claimed = await pool.query(
        `INSERT INTO telegram_expense_captures AS captures (user_id, chat_id, message_id, status, claim_version, lease_expires_at${hasPayload ? ", payload, attempt_count" : ""})
         VALUES ($1, $2, $3, 'processing', 1, now() + interval '60 seconds'${hasPayload ? ", $4, 0" : ""})
         ON CONFLICT (user_id, chat_id, message_id) DO UPDATE
           SET claim_version = captures.claim_version + 1,
               lease_expires_at = now() + interval '60 seconds'${hasPayload ? ", payload = COALESCE(captures.payload, EXCLUDED.payload), attempt_count = captures.attempt_count + 1" : ""}
         WHERE captures.status = 'processing' AND captures.lease_expires_at <= now()
         RETURNING claim_version`,
        hasPayload ? [userId, chatId, messageId, JSON.stringify(payload)] : [userId, chatId, messageId]
      );
      if (claimed.rows[0]) return { state: "claimed", claimVersion: claimed.rows[0].claim_version };
      return this.readTelegramExpenseCapture(userId, chatId, messageId);
    },

    async listRunnableTelegramExpenseCaptures(limit = 100) {
      const result = await pool.query(
        `SELECT captures.user_id, captures.chat_id, captures.message_id, captures.claim_version, captures.payload,
                users.telegram_user_id, users.first_name
         FROM telegram_expense_captures captures
         JOIN users ON users.id = captures.user_id
         WHERE captures.status = 'processing' AND captures.payload IS NOT NULL
           AND (captures.lease_expires_at IS NULL OR captures.lease_expires_at <= now())
         ORDER BY captures.created_at, captures.id
         LIMIT $1`,
        [Math.max(1, Math.min(Number(limit) || 100, 500))]
      );
      return result.rows;
    },

    async readTelegramExpenseCapture(userId, chatId, messageId) {
      const result = await pool.query(
        `SELECT captures.status AS request_status, drafts.*
         FROM telegram_expense_captures captures
         LEFT JOIN drafts ON drafts.id = captures.draft_id
         WHERE captures.user_id = $1 AND captures.chat_id = $2 AND captures.message_id = $3`,
        [userId, chatId, messageId]
      );
      const row = result.rows[0] ?? null;
      if (!row) return null;
      return row.request_status === "completed"
        ? { state: "completed", draft: normalizeDraft(row) }
        : { state: "processing" };
    },

    async waitForTelegramExpenseCapture(userId, chatId, messageId) {
      for (let attempt = 0; attempt < 1200; attempt += 1) {
        const result = await this.readTelegramExpenseCapture(userId, chatId, messageId);
        if (!result || result.state === "completed") return result;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return null;
    },

    async releaseTelegramExpenseCapture(userId, chatId, messageId, claimVersion) {
      await pool.query(
        `DELETE FROM telegram_expense_captures
         WHERE user_id = $1 AND chat_id = $2 AND message_id = $3
           AND status = 'processing' AND claim_version = $4`,
        [userId, chatId, messageId, claimVersion]
      );
    },

    async completeTelegramExpenseCapture({ userId, chatId, messageId, claimVersion, sourceText, items }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const prior = await client.query(
          `SELECT id, status, claim_version, lease_expires_at > now() AS lease_active
           FROM telegram_expense_captures
           WHERE user_id = $1 AND chat_id = $2 AND message_id = $3 FOR UPDATE`,
          [userId, chatId, messageId]
        );
        if (!prior.rows[0] || prior.rows[0].status !== "processing" || String(prior.rows[0].claim_version) !== String(claimVersion) || !prior.rows[0].lease_active) {
          await client.query("ROLLBACK");
          return null;
        }
        const status = items.some((item) => item.needs_review) ? "inbox" : "pending";
        const created = await client.query(
          "INSERT INTO drafts (user_id, status, source_text, items) VALUES ($1, $2, $3, $4) RETURNING *",
          [userId, status, sourceText, JSON.stringify(items)]
        );
        const completed = await client.query(
          `UPDATE telegram_expense_captures
           SET draft_id = $4, status = 'completed', completed_at = now(), lease_expires_at = NULL,
               payload = NULL, finished_at = now()
           WHERE user_id = $1 AND chat_id = $2 AND message_id = $3 AND status = 'processing'
             AND claim_version = $5 AND lease_expires_at > now()
           RETURNING id`,
          [userId, chatId, messageId, created.rows[0].id, claimVersion]
        );
        if (completed.rowCount !== 1) throw new Error("telegram_expense_capture_claim_lost");
        await client.query("COMMIT");
        return { draft: normalizeDraft(created.rows[0]) };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    },

    async claimShortcutRequest(tokenId, userId, clientRequestId) {
      const token = await pool.query("SELECT id FROM quick_access_tokens WHERE id = $1 AND user_id = $2 AND activated_at IS NOT NULL AND revoked_at IS NULL", [tokenId, userId]);
      if (!token.rows[0]) return null;
      const claimed = await pool.query(
        `INSERT INTO quick_access_requests AS requests (token_id, client_request_id, status, claim_version, lease_expires_at)
         VALUES ($1, $2, 'processing', 1, now() + interval '60 seconds')
         ON CONFLICT (token_id, client_request_id) DO UPDATE
           SET claim_version = requests.claim_version + 1,
               lease_expires_at = now() + interval '60 seconds'
         WHERE requests.status = 'processing' AND requests.lease_expires_at <= now()
         RETURNING claim_version`,
        [tokenId, clientRequestId]
      );
      if (claimed.rows[0]) return { state: "claimed", claimVersion: claimed.rows[0].claim_version };
      return this.readShortcutRequest(tokenId, userId, clientRequestId);
    },

    async readShortcutRequest(tokenId, userId, clientRequestId) {
      const result = await pool.query(
        `SELECT requests.status AS request_status, drafts.* FROM quick_access_requests requests
         JOIN quick_access_tokens token ON token.id = requests.token_id AND token.user_id = $2 AND token.activated_at IS NOT NULL AND token.revoked_at IS NULL
         LEFT JOIN drafts ON drafts.id = requests.draft_id
         WHERE requests.token_id = $1 AND requests.client_request_id = $3`,
        [tokenId, userId, clientRequestId]
      );
      const row = result.rows[0] ?? null;
      if (!row) return null;
      return row.request_status === "completed" ? { state: "completed", draft: normalizeDraft(row) } : { state: "processing" };
    },

    async waitForShortcutRequest(tokenId, userId, clientRequestId) {
      for (let attempt = 0; attempt < 1200; attempt += 1) {
        const result = await this.readShortcutRequest(tokenId, userId, clientRequestId);
        if (!result || result.state === "completed") return result;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return null;
    },

    async releaseShortcutRequest(tokenId, userId, clientRequestId, claimVersion) {
      await pool.query(
        `DELETE FROM quick_access_requests requests USING quick_access_tokens token
         WHERE requests.token_id = token.id AND token.id = $1 AND token.user_id = $2
           AND requests.client_request_id = $3 AND requests.status = 'processing' AND requests.claim_version = $4`,
        [tokenId, userId, clientRequestId, claimVersion]
      );
    },

    async completeShortcutRequest({ tokenId, userId, clientRequestId, claimVersion, sourceText, items }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const token = await client.query("SELECT id FROM quick_access_tokens WHERE id = $1 AND user_id = $2 AND activated_at IS NOT NULL AND revoked_at IS NULL FOR UPDATE", [tokenId, userId]);
        if (!token.rows[0]) { await client.query("ROLLBACK"); return null; }
        const prior = await client.query(
          `SELECT id, status, claim_version, lease_expires_at > now() AS lease_active
           FROM quick_access_requests
           WHERE token_id = $1 AND client_request_id = $2 FOR UPDATE`,
          [tokenId, clientRequestId]
        );
        if (!prior.rows[0] || prior.rows[0].status !== "processing" || String(prior.rows[0].claim_version) !== String(claimVersion) || !prior.rows[0].lease_active) { await client.query("ROLLBACK"); return null; }
        const status = items.some((item) => item.needs_review) ? "inbox" : "pending";
        const created = await client.query(
          "INSERT INTO drafts (user_id, status, source_text, items) VALUES ($1, $2, $3, $4) RETURNING *",
          [userId, status, sourceText, JSON.stringify(items)]
        );
        const completed = await client.query(
          `UPDATE quick_access_requests
           SET draft_id = $3, status = 'completed', completed_at = now(), lease_expires_at = NULL
           WHERE token_id = $1 AND client_request_id = $2 AND status = 'processing'
             AND claim_version = $4 AND lease_expires_at > now()
           RETURNING id`,
          [tokenId, clientRequestId, created.rows[0].id, claimVersion]
        );
        if (completed.rowCount !== 1) throw new Error("shortcut_claim_lost");
        await client.query("COMMIT");
        return { draft: normalizeDraft(created.rows[0]) };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    },

    async requestAccountDeletion(telegramUserId, { source, ttlMinutes = ACCOUNT_DELETION_TTL_MINUTES, now = new Date() } = {}) {
      assertAccountDeletionSource(source);
      const currentNow = normalizeNow(now);
      const user = await this.getUserByTelegramId(telegramUserId);
      if (!user) return null;

      await expireAccountDeletionRequests(pool, user.id, currentNow);
      const pendingResult = await pool.query(
        `SELECT * FROM account_deletion_requests
         WHERE user_id = $1
           AND status = 'pending'
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
        [user.id]
      );
      const pending = pendingResult.rows[0] ?? null;
      const expiresAt = new Date(currentNow.getTime() + Number(ttlMinutes) * 60 * 1000);

      if (pending && pending.source !== source) {
        throw codedError("Account deletion already pending", "account_deletion_already_pending");
      }
      if (pending) {
        const refreshed = await pool.query(
          `UPDATE account_deletion_requests
           SET stage = 'requested',
               expires_at = $2,
               updated_at = $3
           WHERE id = $1
           RETURNING *`,
          [pending.id, expiresAt, currentNow]
        );
        return mapAccountDeletionRequest(refreshed.rows[0]);
      }

      const inserted = await pool.query(
        `INSERT INTO account_deletion_requests (user_id, source, stage, status, expires_at, created_at, updated_at)
         VALUES ($1, $2, 'requested', 'pending', $3, $4, $4)
         RETURNING *`,
        [user.id, source, expiresAt, currentNow]
      );
      return mapAccountDeletionRequest(inserted.rows[0]);
    },

    async advanceAccountDeletion(telegramUserId, { source, now = new Date() } = {}) {
      assertAccountDeletionSource(source);
      const currentNow = normalizeNow(now);
      const result = await pool.query(
        `UPDATE account_deletion_requests
         SET stage = 'awaiting_text',
             updated_at = $3
         FROM users
         WHERE account_deletion_requests.user_id = users.id
           AND users.telegram_user_id = $1
           AND account_deletion_requests.source = $2
           AND account_deletion_requests.expires_at > $3
           AND account_deletion_requests.status = 'pending'
           AND account_deletion_requests.stage = 'requested'
         RETURNING account_deletion_requests.*`,
        [telegramUserId, source, currentNow]
      );
      return mapAccountDeletionRequest(result.rows[0]);
    },

    async cancelAccountDeletion(telegramUserId, { source, now = new Date() } = {}) {
      assertAccountDeletionSource(source);
      const currentNow = normalizeNow(now);
      await pool.query(
        `UPDATE account_deletion_requests
         SET status = 'cancelled',
             updated_at = $3
         FROM users
         WHERE account_deletion_requests.user_id = users.id
           AND users.telegram_user_id = $1
           AND account_deletion_requests.source = $2
           AND account_deletion_requests.status = 'pending'
         RETURNING account_deletion_requests.*`,
        [telegramUserId, source, currentNow]
      );
      return { status: "cancelled" };
    },

    async getPendingAccountDeletion(telegramUserId, { source, now = new Date() } = {}) {
      assertAccountDeletionSource(source);
      const currentNow = normalizeNow(now);
      const result = await pool.query(
        `SELECT account_deletion_requests.*
         FROM account_deletion_requests
         JOIN users ON users.id = account_deletion_requests.user_id
         WHERE users.telegram_user_id = $1
           AND account_deletion_requests.source = $2
           AND account_deletion_requests.status = 'pending'
           AND account_deletion_requests.expires_at > $3
         ORDER BY account_deletion_requests.updated_at DESC, account_deletion_requests.id DESC
         LIMIT 1`,
        [telegramUserId, source, currentNow]
      );
      return mapAccountDeletionRequest(result.rows[0]);
    },

    async confirmAccountDeletion({ telegramUserId, source, confirmationText, now = new Date() }) {
      assertAccountDeletionSource(source);
      if (confirmationText !== "DELETE") {
        throw codedError("Invalid account deletion confirmation", "invalid_account_deletion_confirmation");
      }

      const currentNow = normalizeNow(now);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const userResult = await client.query(
          "SELECT * FROM users WHERE telegram_user_id = $1 FOR UPDATE",
          [telegramUserId]
        );
        const user = userResult.rows[0] ?? null;
        if (!user) {
          throw codedError("User not found", "user_not_found");
        }

        const requestResult = await client.query(
          `SELECT * FROM account_deletion_requests
           WHERE user_id = $1
             AND status = 'pending'
           ORDER BY updated_at DESC, id DESC
           LIMIT 1
           FOR UPDATE`,
          [user.id]
        );
        const request = requestResult.rows[0] ?? null;
        if (!request || request.status !== "pending" || request.source !== source || request.stage !== "awaiting_text") {
          throw codedError("Account deletion is not pending", "account_deletion_not_pending");
        }
        const expiresAt = request.expires_at instanceof Date ? request.expires_at : new Date(request.expires_at);
        if (Number.isNaN(expiresAt.getTime()) || expiresAt <= currentNow) {
          throw codedError("Account deletion request expired", "account_deletion_expired");
        }

        await client.query("DELETE FROM app_events WHERE user_id = $1", [user.id]);
        await client.query("DELETE FROM feedback WHERE user_id = $1 OR telegram_user_id = $2", [user.id, telegramUserId]);
        await client.query("DELETE FROM release_note_deliveries WHERE user_id = $1", [user.id]);
        await client.query(
          `INSERT INTO app_events (user_id, event_name, metadata, created_at)
           VALUES ($1, $2, $3::jsonb, $4)`,
          [null, "account_deleted", { source }, currentNow]
        );
        await client.query("DELETE FROM users WHERE id = $1", [user.id]);
        await client.query("COMMIT");
        return { status: "deleted" };
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* preserve original transaction error */ }
        throw error;
      } finally {
        client.release();
      }
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
      const timeZone = normalizeTimeZone(user.timezone).timeZone;
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
      await invalidateDailyBudgetSnapshot(pool, user.id, now, resolveUserTimeZone(user));
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
      if (reserveResult.rows[0] || template) {
        await invalidateDailyBudgetSnapshot(pool, user.id, now, resolveUserTimeZone(user));
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

    async openReserveMonth(telegramUserId, now = new Date(), timing = null) {
      if (typeof pool.connect !== "function") return null;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const userResult = await measureStartupPhase(timing, "reserve_user_lock", () => client.query(
          `SELECT * FROM users WHERE telegram_user_id = $1 FOR UPDATE`,
          [telegramUserId]
        ));
        const user = userResult.rows[0];
        if (!user) {
          await client.query("ROLLBACK");
          return null;
        }
        const userTimeZone = normalizeTimeZone(user.timezone);
        const currentPeriod = timeZoneMonthKey(now, userTimeZone);
        const pastResult = await measureStartupPhase(timing, "reserve_past_lock", () => client.query(
          `SELECT * FROM monthly_reserve_instances
           WHERE user_id = $1 AND status = 'active' AND period < $2
           ORDER BY period
           FOR UPDATE`,
          [user.id, currentPeriod]
        ));
        await lockFinancialMonths(
          client,
          user.id,
          [...pastResult.rows.map((instance) => instance.period), currentPeriod],
          timing
        );
        await measureStartupPhase(timing, "reserve_rollover", async () => {
          for (const instance of pastResult.rows) {
            await closeReserveInstance(client, user, instance, now);
          }
        });

        const currentResult = await measureStartupPhase(timing, "reserve_current_lock", () => client.query(
          `SELECT * FROM monthly_reserve_instances
           WHERE user_id = $1 AND period = $2
           FOR UPDATE`,
          [user.id, currentPeriod]
        ));
        let current = currentResult.rows[0] ?? null;
        let recurringReserveBlocked = false;
        if (!current) {
          const templateResult = await measureStartupPhase(timing, "reserve_template_lock", () => client.query(
            `SELECT * FROM recurring_reserve_templates
             WHERE user_id = $1 AND is_active = true
             FOR UPDATE`,
            [user.id]
          ));
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
             display_currency_follows_base = true,
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
             display_currency_follows_base = true,
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

    async setUserBotBlocked(userId, { blocked, source, now = new Date() }) {
      const result = await pool.query(
        `UPDATE users
         SET bot_blocked = $2,
             bot_blocked_at = CASE WHEN $2 THEN $3 ELSE bot_blocked_at END,
             bot_unblocked_at = CASE WHEN $2 THEN bot_unblocked_at ELSE $3 END
         WHERE id = $1
           AND bot_blocked IS DISTINCT FROM $2
         RETURNING id`,
        [userId, Boolean(blocked), now]
      );
      const transitionedUserId = result.rows[0]?.id;
      if (!transitionedUserId) return { changed: false };
      try {
        await this.recordAppEvent(transitionedUserId, blocked ? "bot_blocked" : "bot_unblocked", { source });
      } catch (error) {
        console.error("[repository] failed to record bot availability transition", error);
      }
      return { changed: true };
    },

    async setTelegramUserBotBlocked(telegramUserId, { blocked, source, now = new Date() }) {
      const result = await pool.query(
        `UPDATE users
         SET bot_blocked = $2,
             bot_blocked_at = CASE WHEN $2 THEN $3 ELSE bot_blocked_at END,
             bot_unblocked_at = CASE WHEN $2 THEN bot_unblocked_at ELSE $3 END
         WHERE telegram_user_id = $1
           AND bot_blocked IS DISTINCT FROM $2
         RETURNING id`,
        [telegramUserId, Boolean(blocked), now]
      );
      const userId = result.rows[0]?.id;
      if (!userId) return { changed: false };
      try {
        await this.recordAppEvent(userId, blocked ? "bot_blocked" : "bot_unblocked", { source });
      } catch (error) {
        console.error("[repository] failed to record bot availability transition", error);
      }
      return { changed: true };
    },

    async clearTelegramUserBotBlocked(telegramUserId, { source, now = new Date() }) {
      const result = await pool.query(
        `UPDATE users
         SET bot_blocked = false,
             bot_unblocked_at = $2
         WHERE telegram_user_id = $1
           AND bot_blocked = true
         RETURNING id`,
        [telegramUserId, now]
      );
      const userId = result.rows[0]?.id;
      if (!userId) return { changed: false };
      try {
        await this.recordAppEvent(userId, "bot_unblocked", { source });
      } catch (error) {
        console.error("[repository] failed to record bot availability transition", error);
      }
      return { changed: true };
    },

    async markUserBotBlocked(userId) {
      return this.setUserBotBlocked(userId, { blocked: true, source: "telegram_error" });
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
        `WITH existing_user AS MATERIALIZED (
           SELECT id, monthly_budget_amount
           FROM users
           WHERE telegram_user_id = $2
         ), updated AS (
           UPDATE users u
           SET monthly_budget_amount = $1
           FROM existing_user existing
           WHERE u.id = existing.id
           RETURNING u.*, existing.monthly_budget_amount IS DISTINCT FROM $1 AS budget_changed
         )
         SELECT * FROM updated`,
        [amount, telegramUserId]
      );
      const user = result.rows[0] ?? null;
      const budgetChanged = user?.budget_changed !== false;
      if (user && budgetChanged) await invalidateDailyBudgetSnapshot(pool, user.id, now, resolveUserTimeZone(user));
      if (user && budgetChanged) await this.recordAppEvent(user.id, "budget_changed", { source: "settings" });
      return user;
    },

    async updateUserSettings(telegramUserId, settings, now = new Date()) {
      const hasMonthlyBudgetAmount = Object.hasOwn(settings, "monthlyBudgetAmount");
      const monthlyBudgetAmount = hasMonthlyBudgetAmount ? Number(settings.monthlyBudgetAmount) : null;
      const weeklyBudgetAmount = settings.weeklyBudgetAmount === "" || settings.weeklyBudgetAmount == null
        ? null
        : Number(settings.weeklyBudgetAmount);
      const usdThbRate = Number(settings.usdThbRate ?? 32.65);
      if (hasMonthlyBudgetAmount && (!Number.isFinite(monthlyBudgetAmount) || monthlyBudgetAmount <= 0)) {
        throw new Error("Monthly budget must be positive");
      }
      if (weeklyBudgetAmount != null && (!Number.isFinite(weeklyBudgetAmount) || weeklyBudgetAmount <= 0)) {
        throw new Error("Weekly budget must be positive");
      }
      if (!Number.isFinite(usdThbRate) || usdThbRate <= 0) {
        throw new Error("USD/THB rate must be positive");
      }
      if (!isSupportedCurrency(settings.baseCurrency) || !isSupportedCurrency(settings.displayCurrency)) {
        throw codedError("Currency is not supported", "unsupported_currency");
      }
      const baseCurrency = normalizeCurrency(settings.baseCurrency, "THB");
      const displayCurrency = normalizeCurrency(settings.displayCurrency, "USD");
      const interfaceLanguage = normalizeLanguage(settings.interfaceLanguage);
      const interfaceTheme = normalizeTheme(settings.interfaceTheme);
      const timeZone = normalizeTimeZone(settings.timezone).timeZone;
      const currentUser = await this.getUserByTelegramId(telegramUserId);
      if (!currentUser) return null;
      const displayCurrencyFollowsBase = Object.hasOwn(settings, "displayCurrencyFollowsBase")
        ? settings.displayCurrencyFollowsBase === true
        : currentUser.display_currency_follows_base === true;
      const budgetAdviceEnabled = Object.hasOwn(settings, "budgetAdviceEnabled")
        ? settings.budgetAdviceEnabled === true
        : currentUser.budget_advice_enabled !== false;
      const dailyEntryReminderEnabled = Object.hasOwn(settings, "dailyEntryReminderEnabled")
        ? settings.dailyEntryReminderEnabled === true
        : currentUser.daily_entry_reminder_enabled !== false;
      if (typeof pool.connect === "function") {
        if (baseCurrency !== currentUser.base_currency) {
          await assertReserveCurrencyChangeAllowed(pool, currentUser.id);
        }
        if (hasMonthlyBudgetAmount) await assertReserveBudgetCapacity(pool, currentUser, monthlyBudgetAmount, now);
      }
      const result = await pool.query(
        `UPDATE users
         SET monthly_budget_amount = COALESCE($1, monthly_budget_amount),
             base_currency = $2,
             display_currency = $3,
             display_currency_follows_base = $4,
             usd_thb_rate = $5,
             weekly_budget_amount = $6,
             interface_language = $7,
             budget_advice_enabled = $8,
             daily_entry_reminder_enabled = $9,
             interface_theme = $10,
             timezone = $11
         WHERE telegram_user_id = $12
         RETURNING *`,
        [
          monthlyBudgetAmount,
          baseCurrency,
          displayCurrency,
          displayCurrencyFollowsBase,
          usdThbRate,
          weeklyBudgetAmount,
          interfaceLanguage,
          budgetAdviceEnabled,
          dailyEntryReminderEnabled,
          interfaceTheme,
          timeZone,
          telegramUserId
        ]
      );
      const user = result.rows[0] ?? null;
      if (user) await invalidateDailyBudgetSnapshot(pool, user.id, now, resolveUserTimeZone(user));
      if (user && baseCurrency !== currentUser.base_currency) {
        await this.recordAppEvent(user.id, "currency_changed", {
          currency: baseCurrency,
          source: "settings"
        });
      }
      if (user && hasMonthlyBudgetAmount && Number(monthlyBudgetAmount) !== Number(currentUser.monthly_budget_amount)) {
        await this.recordAppEvent(user.id, "budget_changed", { source: "settings" });
      }
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

    async listPlannedPaymentReminderCandidates() {
      const result = await pool.query(
        `SELECT pe.*,
                users.telegram_user_id,
                users.timezone,
                users.interface_language,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'occurrence_date', reminders.occurrence_date::text,
                    'next_reminder_local_date', reminders.next_reminder_local_date::text,
                    'last_sent_local_date', reminders.last_sent_local_date::text,
                    'status', reminders.status,
                    'tg_chat_id', reminders.tg_chat_id,
                    'tg_message_id', reminders.tg_message_id
                  ) ORDER BY reminders.occurrence_date)
                  FROM planned_payment_reminders reminders
                  WHERE reminders.planned_expense_id = pe.id
                ), '[]'::jsonb) AS reminder_states,
                COALESCE((
                  SELECT array_agg(payments.occurrence_date::text ORDER BY payments.occurrence_date)
                  FROM planned_expense_payments payments
                  JOIN expenses linked_expense
                    ON linked_expense.id = payments.expense_id
                   AND linked_expense.user_id = pe.user_id
                  WHERE payments.planned_expense_id = pe.id
                ), ARRAY[]::text[]) AS paid_occurrence_dates
         FROM planned_expenses pe
         JOIN users ON users.id = pe.user_id
         WHERE pe.active = true
           AND users.telegram_user_id IS NOT NULL
           AND users.onboarding_step = 'completed'
           AND users.bot_blocked = false
         ORDER BY users.id ASC, pe.id ASC`
      );
      return result.rows;
    },

    async claimPlannedPaymentReminder(input) {
      const result = await pool.query(
        `INSERT INTO planned_payment_reminders (
           user_id, planned_expense_id, occurrence_date, next_reminder_local_date,
           last_sent_local_date, timezone_used, status, updated_at
         )
         VALUES ($1, $2, $3, NULL, $4, $5, 'active', now())
         ON CONFLICT (planned_expense_id, occurrence_date)
         DO UPDATE SET
           next_reminder_local_date = NULL,
           last_sent_local_date = EXCLUDED.last_sent_local_date,
           timezone_used = EXCLUDED.timezone_used,
           updated_at = now()
         WHERE planned_payment_reminders.status = 'active'
           AND planned_payment_reminders.last_sent_local_date IS DISTINCT FROM EXCLUDED.last_sent_local_date
           AND (
             planned_payment_reminders.next_reminder_local_date IS NULL
             OR planned_payment_reminders.next_reminder_local_date <= EXCLUDED.last_sent_local_date
           )
         RETURNING *`,
        [
          input.userId,
          input.plannedExpenseId,
          input.occurrenceDate,
          input.localDate,
          input.timezoneUsed
        ]
      );
      return result.rows[0] ?? null;
    },

    async releasePlannedPaymentReminderClaim(input) {
      const result = await pool.query(
        `UPDATE planned_payment_reminders
         SET last_sent_local_date = $5,
             next_reminder_local_date = $6,
             updated_at = now()
         WHERE user_id = $1
           AND planned_expense_id = $2
           AND occurrence_date = $3
           AND last_sent_local_date = $4
           AND status = 'active'
         RETURNING *`,
        [
          input.userId,
          input.plannedExpenseId,
          input.occurrenceDate,
          input.localDate,
          input.previousLastSentLocalDate,
          input.previousNextReminderLocalDate
        ]
      );
      return result.rows[0] ?? null;
    },

    async recordPlannedPaymentReminderMessage(input) {
      const result = await pool.query(
        `UPDATE planned_payment_reminders
         SET tg_chat_id = $1,
             tg_message_id = $2,
             sent_count = sent_count + 1,
             updated_at = $3
         WHERE user_id = $4
           AND planned_expense_id = $5
           AND occurrence_date = $6
           AND status = 'active'
         RETURNING *`,
        [
          input.telegramChatId,
          input.telegramMessageId,
          input.sentAt ?? new Date(),
          input.userId,
          input.plannedExpenseId,
          input.occurrenceDate
        ]
      );
      return result.rows[0] ?? null;
    },

    async getPlannedPaymentReminderForTelegramUser(plannedExpenseId, telegramUserId, occurrenceDate) {
      const result = await pool.query(
        `SELECT reminders.*,
                pe.description,
                pe.amount,
                pe.currency,
                pe.recurrence,
                pe.active,
                users.interface_language,
                users.timezone,
                EXISTS (
                  SELECT 1
                  FROM planned_expense_payments payments
                  JOIN expenses linked_expense
                    ON linked_expense.id = payments.expense_id
                   AND linked_expense.user_id = pe.user_id
                  WHERE payments.planned_expense_id = pe.id
                    AND payments.occurrence_date = $3
                ) AS paid
         FROM planned_payment_reminders reminders
         JOIN planned_expenses pe ON pe.id = reminders.planned_expense_id
         JOIN users ON users.id = pe.user_id
         WHERE reminders.planned_expense_id = $1
           AND users.telegram_user_id = $2
           AND reminders.occurrence_date = $3`,
        [plannedExpenseId, telegramUserId, occurrenceDate]
      );
      return result.rows[0] ?? null;
    },

    async snoozePlannedPaymentReminderForTelegramUser(
      plannedExpenseId,
      telegramUserId,
      occurrenceDate,
      nextReminderLocalDate,
      timezoneUsed
    ) {
      const result = await pool.query(
        `UPDATE planned_payment_reminders reminders
         SET next_reminder_local_date = $4,
             timezone_used = $5,
             updated_at = now()
         FROM planned_expenses pe, users
         WHERE reminders.planned_expense_id = $1
           AND reminders.occurrence_date = $3
           AND reminders.planned_expense_id = pe.id
           AND pe.user_id = users.id
           AND users.telegram_user_id = $2
           AND pe.active = true
           AND reminders.status = 'active'
           AND NOT EXISTS (
             SELECT 1
             FROM planned_expense_payments payments
             JOIN expenses linked_expense
               ON linked_expense.id = payments.expense_id
              AND linked_expense.user_id = pe.user_id
             WHERE payments.planned_expense_id = pe.id
               AND payments.occurrence_date = reminders.occurrence_date
           )
         RETURNING reminders.*`,
        [plannedExpenseId, telegramUserId, occurrenceDate, nextReminderLocalDate, timezoneUsed]
      );
      return result.rows[0] ?? null;
    },

    async markPlannedPaymentReminderTerminal(plannedExpenseId, occurrenceDate, status) {
      const normalizedStatus = status === "disabled" ? "disabled" : "paid";
      const result = await pool.query(
        `UPDATE planned_payment_reminders
         SET status = $3,
             next_reminder_local_date = NULL,
             updated_at = now()
         WHERE planned_expense_id = $1
           AND occurrence_date = $2
         RETURNING *`,
        [plannedExpenseId, occurrenceDate, normalizedStatus]
      );
      return result.rows[0] ?? null;
    },

    async markAllPlannedPaymentRemindersTerminal(plannedExpenseId, status) {
      const normalizedStatus = status === "disabled" ? "disabled" : "paid";
      const result = await pool.query(
        `UPDATE planned_payment_reminders
         SET status = $2,
             next_reminder_local_date = NULL,
             updated_at = now()
         WHERE planned_expense_id = $1
           AND status = 'active'
         RETURNING *`,
        [plannedExpenseId, normalizedStatus]
      );
      return result.rows;
    },

    async listOutstandingPlannedPaymentReminders(plannedExpenseId, occurrenceDate = null) {
      const params = occurrenceDate == null
        ? [plannedExpenseId]
        : [plannedExpenseId, occurrenceDate];
      const occurrenceFilter = occurrenceDate == null ? "" : "AND reminders.occurrence_date = $2";
      const result = await pool.query(
        `SELECT reminders.*, users.interface_language
         FROM planned_payment_reminders reminders
         JOIN planned_expenses pe ON pe.id = reminders.planned_expense_id
         JOIN users ON users.id = pe.user_id
         WHERE reminders.planned_expense_id = $1
           AND reminders.status = 'active'
           AND reminders.tg_chat_id IS NOT NULL
           AND reminders.tg_message_id IS NOT NULL
           ${occurrenceFilter}
         ORDER BY reminders.occurrence_date`,
        params
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

    async getReportDelivery(userId, reportType, periodKey) {
      const result = await pool.query(
        `SELECT *
         FROM report_deliveries
         WHERE user_id = $1
           AND report_type = $2
           AND period_key = $3`,
        [userId, reportType, periodKey]
      );
      return result.rows[0] ?? null;
    },

    async hasReportDelivery(userId, reportType, reportKey) {
      const result = await pool.query(
        `SELECT EXISTS (
           SELECT 1
           FROM report_deliveries
           WHERE user_id = $1
             AND report_type = $2
             AND period_key = $3
             AND status = 'sent'
         ) AS exists`,
        [userId, reportType, reportKey]
      );
      return Boolean(result.rows[0]?.exists);
    },

    async createReportDelivery(input) {
      const result = await pool.query(
        `INSERT INTO report_deliveries (
           user_id, report_type, period_key, period_start_utc, period_end_utc,
           timezone_used, status, generated_at, error_code, error_message,
           skip_reason, metadata
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
         ON CONFLICT (user_id, report_type, period_key) DO NOTHING
         RETURNING *`,
        [
          input.userId,
          input.reportType,
          input.periodKey,
          input.periodStartUtc,
          input.periodEndUtc,
          input.timezoneUsed,
          input.status ?? "pending",
          input.generatedAt ?? null,
          input.errorCode ?? null,
          input.errorMessage ?? null,
          input.skipReason ?? null,
          JSON.stringify(input.metadata ?? {})
        ]
      );
      return result.rows[0] ?? null;
    },

    async claimReportDelivery(input) {
      const result = await pool.query(
        `INSERT INTO report_deliveries (
           user_id, report_type, period_key, period_start_utc, period_end_utc,
           timezone_used, status, generated_at, error_code, error_message,
           skip_reason, metadata
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, NULL, NULL, NULL, $8::jsonb)
         ON CONFLICT (user_id, report_type, period_key) DO UPDATE
         SET status = 'pending',
             period_start_utc = EXCLUDED.period_start_utc,
             period_end_utc = EXCLUDED.period_end_utc,
             timezone_used = EXCLUDED.timezone_used,
             generated_at = EXCLUDED.generated_at,
             sent_at = NULL,
             telegram_message_id = NULL,
             error_code = NULL,
             error_message = NULL,
             skip_reason = NULL,
             metadata = EXCLUDED.metadata,
             updated_at = now()
         WHERE report_deliveries.status = 'failed' OR $9 = true
         RETURNING *`,
        [
          input.userId,
          input.reportType,
          input.periodKey,
          input.periodStartUtc,
          input.periodEndUtc,
          input.timezoneUsed,
          input.generatedAt ?? new Date(),
          JSON.stringify(input.metadata ?? {}),
          input.force === true
        ]
      );
      return result.rows[0] ?? null;
    },

    async markReportDeliverySent(input) {
      const result = await pool.query(
        `UPDATE report_deliveries
         SET status = 'sent',
             telegram_message_id = $4,
             sent_at = $5,
             error_code = NULL,
             error_message = NULL,
             skip_reason = NULL,
             metadata = $6::jsonb,
             updated_at = now()
         WHERE user_id = $1
           AND report_type = $2
           AND period_key = $3
         RETURNING *`,
        [
          input.userId,
          input.reportType,
          input.periodKey,
          input.telegramMessageId ?? null,
          input.sentAt ?? new Date(),
          JSON.stringify(input.metadata ?? {})
        ]
      );
      return result.rows[0] ?? null;
    },

    async markReportDeliveryFailed(input) {
      const result = await pool.query(
        `UPDATE report_deliveries
         SET status = 'failed',
             error_code = $4,
             error_message = $5,
             metadata = $6::jsonb,
             updated_at = now()
         WHERE user_id = $1
           AND report_type = $2
           AND period_key = $3
         RETURNING *`,
        [
          input.userId,
          input.reportType,
          input.periodKey,
          input.errorCode ?? null,
          input.errorMessage ?? null,
          JSON.stringify(input.metadata ?? {})
        ]
      );
      return result.rows[0] ?? null;
    },

    async markReportDeliverySkipped(input) {
      const result = await pool.query(
        `UPDATE report_deliveries
         SET status = 'skipped',
             skip_reason = $4,
             metadata = $5::jsonb,
             updated_at = now()
         WHERE user_id = $1
           AND report_type = $2
           AND period_key = $3
         RETURNING *`,
        [
          input.userId,
          input.reportType,
          input.periodKey,
          input.skipReason ?? null,
          JSON.stringify(input.metadata ?? {})
        ]
      );
      return result.rows[0] ?? null;
    },

    async listReportCandidates() {
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

    async buildReportDataForDelivery(user, reportType, period, now = new Date()) {
      const timeZone = period.timezoneUsed ?? userTimezone(user);
      const bounds = { start: period.periodStartUtc, end: period.periodEndUtc };
      const reportDate = reportType === "monthly" ? new Date(period.periodStartUtc.getTime() + 12 * 60 * 60_000) : now;
      const paidMonths = reportPeriodMonthKeys(period, timeZone);
      const [expenses, paidPlannedPayments, budgetTopups, allCategories, plannedExpenses] = await Promise.all([
        reportExpensesForPeriod(pool, user, bounds, timeZone),
        reportPaidPlannedPaymentsForPeriod(pool, user, bounds, timeZone),
        reportBudgetTopupsForPeriod(pool, user, bounds, timeZone),
        reportAllCategoriesForPeriod(pool, user, bounds),
        listPlannedExpensesForTelegramUserAt(pool, user.telegram_user_id, reportDate, paidMonths)
      ]);
      const budgetDate = reportDate;
      const budget = await currentMonthBudget(pool, user, budgetDate, timeZone);
      const monthBaseline = reportType === "monthly"
        ? await monthBaselineTotal(pool, user.id, budgetDate, timeZone)
        : 0;
      const days = Math.max(Math.round((period.periodEndUtc.getTime() - period.periodStartUtc.getTime()) / 86_400_000), 1);
      const largeThreshold = reportLargeExpenseThreshold(user, budget);
      const language = user.interface_language === "en" ? "en" : "ru";
      const currency = user.base_currency ?? "THB";
      const isWeekly = reportType === "weekly";
      const metrics = buildReportMetrics({
        currency,
        displayCurrency: effectiveDisplayCurrency(user),
        expenses,
        paidPlannedPayments,
        budgetTopups,
        monthBaseline,
        largeThreshold,
        periodDays: days
      });
      metrics.averagePerDay = roundMoney(metrics.totalSpent / days);
      metrics.regularAveragePerDay = roundMoney(metrics.regularTotal / days);
      const displaySpent = roundForDisplayCurrency(metrics.totalSpent, currency);
      const displayBudget = roundForDisplayCurrency(Number(budget.amount ?? 0), currency);
      const remaining = roundMoney(displayBudget - displaySpent);
      const budgetAvailable = displayBudget > 0;
      const budgetUsedPercent = budgetAvailable
        ? Math.round((displaySpent / displayBudget) * 100)
        : null;
      const budgetExceeded = budgetAvailable && displaySpent > displayBudget;
      const budgetOverAmount = budgetExceeded ? roundMoney(displaySpent - displayBudget) : 0;
      const notableExpenses = reportNotableExpenses(expenses, paidPlannedPayments, largeThreshold, reportType === "monthly" ? 5 : 3, language);
      const unpaidPlanned = reportUnpaidPlannedPayments(plannedExpenses, user, budgetDate, timeZone, period, isWeekly ? 7 : 0);
      const plannedPayments = [
        ...paidPlannedPayments.map((payment) => ({
          name: payment.name,
          amount: Number(payment.amount_base ?? 0),
          paid: true,
          dueDate: payment.occurrence_date
        })),
        ...unpaidPlanned
      ];
      const topCategoryResult = categoryPercentages(allCategories, metrics.totalSpent, { language, limit: isWeekly ? 3 : 5 });

      let comparison = { available: false };
      let changes = [];
      let reportLargest = [];
      let needsAttention = null;
      let takeaway = null;
      let firstWeek = false;
      let firstMonth = false;
      if (isWeekly) {
        const priorBounds = priorWeeklyBounds(period, timeZone);
        const priorAllCategories = await reportAllCategoriesForPeriod(pool, user, priorBounds);
        const priorTotal = priorAllCategories.reduce((total, category) => total + Number(category.total ?? 0), 0);
        comparison = weeklyComparison({ currentTotal: metrics.totalSpent, priorTotal });
        const usageStart = user.created_at ? new Date(user.created_at) : null;
        const priorFullyObservable = !usageStart || usageStart.getTime() <= priorBounds.start.getTime();
        comparison.available = comparison.available && priorFullyObservable;
        firstWeek = Boolean(usageStart && usageStart.getTime() >= period.periodStartUtc.getTime());
        changes = comparison.available
          ? categoryChanges({ current: allCategories, prior: priorAllCategories, language, currency })
          : [];
        reportLargest = largestExpenses(expenses, { language, limit: 5 });
        takeaway = weeklyTakeaway({
          comparable: comparison.available,
          comparisonDirection: comparison.direction,
          currentTotal: metrics.totalSpent,
          priorTotal,
          largestExpense: reportLargest[0] ?? null,
          changes,
          language
        });
        const unpaidForAttention = plannedPayments.filter((payment) => !payment.paid);
        needsAttention = unpaidForAttention.length > 0 ? needsAttentionFromUnpaid(unpaidForAttention) : null;
      } else {
        const priorBoundsObj = priorMonthlyBounds(period, timeZone);
        let priorAllCategories = [];
        let priorTotal = 0;
        if (priorBoundsObj) {
          priorAllCategories = await reportAllCategoriesForPeriod(pool, user, priorBoundsObj);
          priorTotal = priorAllCategories.reduce((total, category) => total + Number(category.total ?? 0), 0);
        }
        comparison = weeklyComparison({ currentTotal: metrics.totalSpent, priorTotal });
        const usageStart = user.created_at ? new Date(user.created_at) : null;
        const currentFullyObservable = !usageStart || usageStart.getTime() <= period.periodStartUtc.getTime();
        const priorFullyObservable = Boolean(priorBoundsObj)
          && (!usageStart || usageStart.getTime() <= priorBoundsObj.start.getTime());
        comparison.available = comparison.available && priorFullyObservable;
        if (comparison.available && priorBoundsObj) comparison.priorMonthKey = priorBoundsObj.periodKey;
        firstMonth = currentFullyObservable && !priorFullyObservable;
        reportLargest = largestExpenses(expenses, { language, limit: 5 });
        changes = comparison.available
          ? categoryChanges({
            current: allCategories,
            prior: priorAllCategories,
            language,
            currency,
            relativeMin: MONTHLY_CHANGE_RELATIVE_MIN,
            absoluteFloor: MONTHLY_CHANGE_ABSOLUTE_TOTAL_SHARE * Math.max(metrics.totalSpent, priorTotal)
          })
          : [];
        const unpaidForAttention = plannedPayments.filter((payment) => !payment.paid);
        needsAttention = unpaidForAttention.length > 0 ? needsAttentionFromUnpaid(unpaidForAttention) : null;
        if (firstMonth) {
          takeaway = null;
        } else {
          takeaway = monthlyTakeaway({
            comparable: comparison.available,
            comparisonDirection: comparison.direction,
            currentTotal: metrics.totalSpent,
            priorTotal,
            budget: {
              available: budgetAvailable,
              usedPercent: budgetUsedPercent,
              overAmount: budgetOverAmount
            },
            topTwoShare: topCategoryResult.topTwoShare,
            largestExpense: reportLargest[0] ?? null,
            changes,
            language,
            formatMoney: (value) => formatReportMoney(value, currency, language)
          });
        }
      }

      const budgetDisplayRemaining = displayFromBase(remaining, user);
      return {
        reportType,
        currency,
        period,
        metrics,
        budget: {
          baseBudget: budget.baseBudget,
          topupsTotal: budget.topupsTotal,
          amount: budget.amount,
          remaining,
          available: budgetAvailable,
          usedPercent: budgetUsedPercent,
          overAmount: budgetOverAmount,
          display: {
            ...budget.display,
            remaining: budgetDisplayRemaining,
            overAmount: displayFromBase(budgetOverAmount, user)
          }
        },
        plannedPayments,
        largeExpenses: notableExpenses.items,
        largeExpensesTotal: notableExpenses.total,
        largeExpensesCount: notableExpenses.count,
        budgetTopups: budgetTopups.map((topup) => ({
          date: topup.local_date,
          amount: Number(topup.amount_base ?? 0)
        })),
        topCategories: topCategoryResult.items,
        topTwoCategoryShare: topCategoryResult.topTwoShare,
        comparison,
        changes,
        largestExpenses: reportLargest,
        needsAttention,
        takeaway,
        firstWeek,
        firstMonth,
        insight: "",
        generatedAt: now
      };
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

    async consumeTelegramInputSession(telegramUserId, { sessionId, now = new Date(), apply } = {}) {
      const currentNow = normalizeNow(now);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const userResult = await client.query(
          "SELECT id FROM users WHERE telegram_user_id = $1 FOR UPDATE",
          [telegramUserId]
        );
        const user = userResult.rows[0] ?? null;
        if (!user) {
          await client.query("COMMIT");
          return { outcome: "none" };
        }

        const sessionResult = await client.query(
          `SELECT *
           FROM telegram_input_sessions
           WHERE id = $1 AND user_id = $2
           FOR UPDATE`,
          [sessionId, user.id]
        );
        const session = sessionResult.rows[0] ?? null;
        if (!session) {
          await client.query("COMMIT");
          return { outcome: "already_consumed" };
        }
        if (session.status === "completed" || session.status === "cancelled" || session.status === "expired_consumed") {
          await client.query("COMMIT");
          return { outcome: "already_consumed", session };
        }
        if (session.status === "processing") {
          await client.query("COMMIT");
          return { outcome: "session_not_claimable", session };
        }
        if (session.status === "expired_unconsumed") {
          const consumed = await client.query(
            `UPDATE telegram_input_sessions
             SET status = 'expired_consumed', late_input_consumed_at = $2, updated_at = $2
             WHERE id = $1
             RETURNING *`,
            [session.id, currentNow]
          );
          await client.query("COMMIT");
          return { outcome: "expired", session: consumed.rows[0] ?? { ...session, status: "expired_consumed" } };
        }
        if (new Date(session.expires_at) <= currentNow) {
          const expired = await client.query(
            `UPDATE telegram_input_sessions
             SET status = 'expired_consumed', late_input_consumed_at = $2, updated_at = $2
             WHERE id = $1
             RETURNING *`,
            [session.id, currentNow]
          );
          await client.query("COMMIT");
          return { outcome: "expired", session: expired.rows[0] ?? { ...session, status: "expired_consumed" } };
        }
        if (session.status !== "active") {
          await client.query("COMMIT");
          return { outcome: "session_not_claimable", session };
        }

        const processing = await client.query(
          `UPDATE telegram_input_sessions
           SET status = 'processing', updated_at = $2
           WHERE id = $1 AND status = 'active'
           RETURNING *`,
          [session.id, currentNow]
        );
        const claimed = processing.rows[0] ?? null;
        if (!claimed) {
          await client.query("COMMIT");
          return { outcome: "already_consumed" };
        }

        await apply({ session: claimed, user, client, now: currentNow });
        await client.query(
          `UPDATE telegram_input_sessions
           SET status = 'completed', updated_at = $2
           WHERE id = $1 AND status = 'processing'`,
          [claimed.id, currentNow]
        );
        await client.query("COMMIT");
        return { outcome: "completed", session: { ...claimed, status: "completed" } };
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* preserve original transaction error */ }
        throw error;
      } finally {
        client.release();
      }
    },

    async startTelegramInputSession(telegramUserId, input, now = new Date()) {
      const currentNow = normalizeNow(now);
      const expiresAt = new Date(currentNow.getTime() + 15 * 60_000);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const userResult = await client.query(
          "SELECT id FROM users WHERE telegram_user_id = $1 FOR UPDATE",
          [telegramUserId]
        );
        const user = userResult.rows[0] ?? null;
        if (!user) {
          await client.query("COMMIT");
          return { outcome: "none" };
        }
        const busyResult = await client.query(
          `SELECT *
           FROM telegram_input_sessions
           WHERE user_id = $1 AND status IN ('active', 'processing')
           ORDER BY updated_at DESC, id DESC
           LIMIT 1
           FOR UPDATE`,
          [user.id]
        );
        const busy = busyResult.rows[0] ?? null;
        if (busy?.status === "processing") {
          await client.query("COMMIT");
          return { outcome: "input_in_progress" };
        }
        let replacedSession = null;
        if (busy?.status === "active") {
          const cancelled = await client.query(
            `UPDATE telegram_input_sessions
             SET status = 'cancelled', updated_at = $2
             WHERE id = $1 AND status = 'active'
             RETURNING *`,
            [busy.id, currentNow]
          );
          replacedSession = cancelled.rows[0] ?? { ...busy, status: "cancelled" };
        }
        const inserted = await client.query(
          `INSERT INTO telegram_input_sessions (
             user_id, target_type, target_id, item_index, field,
             chat_id, message_id, language, status, expires_at, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10, $10)
           RETURNING *`,
          [
            user.id,
            input.targetType,
            input.targetId,
            input.itemIndex ?? null,
            input.field,
            input.chatId,
            input.messageId,
            input.language,
            expiresAt,
            currentNow
          ]
        );
        await client.query("COMMIT");
        return { outcome: "started", session: inserted.rows[0] ?? null, replacedSession };
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* preserve original transaction error */ }
        throw error;
      } finally {
        client.release();
      }
    },

    async setTelegramInputSessionPrompt(telegramUserId, sessionId, expectedTarget, now = new Date()) {
      const currentNow = normalizeNow(now);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const userResult = await client.query(
          "SELECT id FROM users WHERE telegram_user_id = $1 FOR UPDATE",
          [telegramUserId]
        );
        const user = userResult.rows[0] ?? null;
        if (!user) {
          await client.query("COMMIT");
          return { outcome: "none" };
        }
        const sessionResult = await client.query(
          `SELECT *
           FROM telegram_input_sessions
           WHERE id = $1 AND user_id = $2
           FOR UPDATE`,
          [sessionId, user.id]
        );
        const session = sessionResult.rows[0] ?? null;
        if (!session || session.status !== "active" || !sameTelegramEditorTarget(session, expectedTarget)) {
          await client.query("COMMIT");
          return { outcome: "none" };
        }
        const updated = await client.query(
          `UPDATE telegram_input_sessions
           SET prompt_message_id = $2, updated_at = $3
           WHERE id = $1 AND status = 'active'
           RETURNING *`,
          [session.id, expectedTarget.promptMessageId, currentNow]
        );
        await client.query("COMMIT");
        return { outcome: "stored", session: updated.rows[0] ?? { ...session, prompt_message_id: expectedTarget.promptMessageId } };
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* preserve original transaction error */ }
        throw error;
      } finally {
        client.release();
      }
    },

    async getRoutableTelegramInputSession(telegramUserId) {
      const result = await pool.query(
        `SELECT sessions.*
         FROM telegram_input_sessions sessions
         JOIN users ON users.id = sessions.user_id
         WHERE users.telegram_user_id = $1
           AND sessions.status IN ('active', 'expired_unconsumed')
         ORDER BY sessions.updated_at DESC, sessions.id DESC
         LIMIT 1`,
        [telegramUserId]
      );
      return result.rows[0] ?? null;
    },

    async cancelTelegramInputSession(telegramUserId, now = new Date(), expectedTarget = null) {
      const currentNow = normalizeNow(now);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const userResult = await client.query(
          "SELECT id FROM users WHERE telegram_user_id = $1 FOR UPDATE",
          [telegramUserId]
        );
        const user = userResult.rows[0] ?? null;
        if (!user) {
          await client.query("COMMIT");
          return { outcome: "none" };
        }
        const sessionResult = await client.query(
          `SELECT *
           FROM telegram_input_sessions
           WHERE user_id = $1 AND status IN ('active', 'processing')
           ORDER BY updated_at DESC, id DESC
           LIMIT 1
           FOR UPDATE`,
          [user.id]
        );
        const session = sessionResult.rows[0] ?? null;
        if (!session) {
          await client.query("COMMIT");
          return { outcome: "none" };
        }
        if (expectedTarget && (
          session.target_type !== expectedTarget.targetType
          || Number(session.target_id) !== Number(expectedTarget.targetId)
          || Number(session.item_index ?? -1) !== Number(expectedTarget.itemIndex ?? -1)
        )) {
          await client.query("COMMIT");
          return { outcome: "none" };
        }
        if (session.status === "processing") {
          await client.query("COMMIT");
          return { outcome: "input_in_progress" };
        }
        const updated = await client.query(
          `UPDATE telegram_input_sessions
           SET status = 'cancelled', updated_at = $2
           WHERE id = $1 AND status = 'active'
           RETURNING *`,
          [session.id, currentNow]
        );
        await client.query("COMMIT");
        return { outcome: "cancelled", session: updated.rows[0] ?? { ...session, status: "cancelled" } };
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* preserve original transaction error */ }
        throw error;
      } finally {
        client.release();
      }
    },

    async closeTelegramInputSessionForTarget(telegramUserId, expectedTarget, now = new Date()) {
      const currentNow = normalizeNow(now);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const userResult = await client.query(
          "SELECT id FROM users WHERE telegram_user_id = $1 FOR UPDATE",
          [telegramUserId]
        );
        const user = userResult.rows[0] ?? null;
        if (!user) {
          await client.query("COMMIT");
          return { outcome: "none" };
        }
        const sessionResult = await client.query(
          `SELECT *
           FROM telegram_input_sessions
           WHERE user_id = $1 AND status IN ('active', 'processing')
           ORDER BY updated_at DESC, id DESC
           LIMIT 1
           FOR UPDATE`,
          [user.id]
        );
        const session = sessionResult.rows[0] ?? null;
        if (!session || !sameTelegramEditorTarget(session, expectedTarget)) {
          await client.query("COMMIT");
          return { outcome: "none" };
        }
        if (session.status === "processing") {
          await client.query("COMMIT");
          return { outcome: "input_in_progress", session };
        }
        const updated = await client.query(
          `UPDATE telegram_input_sessions
           SET status = 'cancelled', updated_at = $2
           WHERE id = $1 AND status = 'active'
           RETURNING *`,
          [session.id, currentNow]
        );
        await client.query("COMMIT");
        return { outcome: "cancelled", session: updated.rows[0] ?? { ...session, status: "cancelled" } };
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* preserve original transaction error */ }
        throw error;
      } finally {
        client.release();
      }
    },

    async deleteOldTelegramInputSessions(now = new Date()) {
      const retentionCutoff = new Date(normalizeNow(now).getTime() - 24 * 60 * 60_000);
      const result = await pool.query(
        `DELETE FROM telegram_input_sessions
         WHERE status IN ('completed', 'cancelled', 'expired_consumed')
           AND updated_at < $1`,
        [retentionCutoff]
      );
      return result.rowCount;
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

    async createBudgetTopupDraft(userId, sourceText, item, now = new Date()) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `SELECT id
           FROM users
           WHERE id = $1
           FOR UPDATE`,
          [userId]
        );
        await client.query(
          `UPDATE budget_topup_drafts
           SET status = 'expired', expired_at = $2
           WHERE user_id = $1 AND status = 'pending'`,
          [userId, now]
        );
        const result = await client.query(
          `INSERT INTO budget_topup_drafts (user_id, status, source_text, item, created_at)
           VALUES ($1, 'pending', $2, $3::jsonb, $4)
           RETURNING *`,
          [userId, sourceText, JSON.stringify(item), now]
        );
        await client.query("COMMIT");
        return normalizeBudgetTopupDraft(result.rows[0]);
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* ignore rollback failures */ }
        throw error;
      } finally {
        client.release();
      }
    },

    async previewBudgetTopup(userId, item, now = new Date()) {
      const userResult = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
      const user = userResult.rows[0] ?? null;
      if (!user) throw new Error("User not found");
      const timeZone = userTimezone(user);
      const occurredAt = new Date(item?.occurred_at ?? now);
      const targetDate = Number.isFinite(occurredAt.getTime()) ? occurredAt : now;
      const moneyAmounts = await buildMoneyAmounts(exchangeRates, item.amount, item.currency, targetDate, user);
      const targetBudget = await currentMonthBudget(pool, user, targetDate, timeZone);
      return {
        amountBase: moneyAmounts.amountBase,
        baseBudget: targetBudget.baseBudget,
        monthKey: targetBudget.monthKey,
        large: targetBudget.baseBudget > 0
          ? moneyAmounts.amountBase > targetBudget.baseBudget * 3
          : moneyAmounts.amountBase >= 100000
      };
    },

    async confirmBudgetTopupDraft(draftId, telegramUserId, now = new Date()) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const draftResult = await client.query(
          `SELECT budget_topup_drafts.*,
                  users.telegram_user_id,
                  users.monthly_budget_amount,
                  users.base_currency,
                  users.display_currency,
                  users.display_currency_follows_base,
                  users.usd_thb_rate,
                  users.timezone
           FROM budget_topup_drafts
           JOIN users ON users.id = budget_topup_drafts.user_id
           WHERE budget_topup_drafts.id = $1
             AND users.telegram_user_id = $2
           FOR UPDATE`,
          [draftId, telegramUserId]
        );
        const draft = normalizeBudgetTopupDraft(draftResult.rows[0] ?? null);
        if (!draft) {
          await client.query("ROLLBACK");
          throw new BudgetTopupDraftNotFoundError();
        }
        if (draft.status === "cancelled") {
          await client.query("ROLLBACK");
          return { outcome: "cancelled" };
        }
        if (draft.status === "expired") {
          await client.query("ROLLBACK");
          const newer = await pool.query(
            `SELECT id FROM budget_topup_drafts
             WHERE user_id = $1 AND created_at > $2
             ORDER BY created_at DESC
             LIMIT 1`,
            [draft.user_id, draft.created_at]
          );
          return { outcome: newer.rows[0] ? "replaced_by_newer" : "expired" };
        }
        if (new Date(draft.created_at).getTime() < now.getTime() - 24 * 60 * 60_000) {
          await client.query(
            `UPDATE budget_topup_drafts
             SET status = 'expired', expired_at = $2
             WHERE id = $1`,
            [draft.id, now]
          );
          await client.query("COMMIT");
          return { outcome: "expired" };
        }
        if (draft.status === "confirmed") {
          const existing = await client.query(
            `SELECT * FROM budget_topups
             WHERE user_id = $1 AND draft_id = $2
             LIMIT 1`,
            [draft.user_id, draft.id]
          );
          await client.query("COMMIT");
          const currentBudget = await currentMonthBudget(pool, draft, now, userTimezone(draft));
          const dashboardSnapshot = (await this.dashboard(telegramUserId, now)).snapshot;
          return { topup: withDisplay(existing.rows[0], draft), currentMonthBudget: currentBudget, dashboardSnapshot, alreadySaved: true, outcome: "confirmed" };
        }

        const item = draft.item;
        const occurredAt = new Date(item.occurred_at ?? now);
        const targetMonthKey = item.month_key ?? monthKey(occurredAt, userTimezone(draft));
        const currentMonthKey = monthKey(now, userTimezone(draft));
        if (targetMonthKey !== currentMonthKey) {
          await client.query("ROLLBACK");
          return { outcome: "wrong_month", targetMonthKey, currentMonthKey };
        }
        const moneyAmounts = await buildMoneyAmounts(exchangeRates, item.amount, item.currency, occurredAt, draft);
        const inserted = await client.query(
          `INSERT INTO budget_topups (
             user_id, draft_id, month_key, local_date,
             amount_original, currency_original, amount_base, base_currency,
             converted_amounts, exchange_rate_date, exchange_rate_source,
             kind, note, source_text, occurred_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15)
           ON CONFLICT (user_id, draft_id) WHERE draft_id IS NOT NULL DO NOTHING
           RETURNING *`,
          [
            draft.user_id,
            draft.id,
            item.month_key,
            item.local_date,
            item.amount,
            item.currency,
            moneyAmounts.amountBase,
            draft.base_currency,
            JSON.stringify(moneyAmounts.convertedAmounts),
            occurredAt.toISOString().slice(0, 10),
            moneyAmounts.source,
            item.kind ?? "other",
            item.note ?? null,
            draft.source_text,
            occurredAt
          ]
        );
        let topup = inserted.rows[0] ?? null;
        if (!topup) {
          const existing = await client.query(
            `SELECT * FROM budget_topups
             WHERE user_id = $1 AND draft_id = $2
             LIMIT 1`,
            [draft.user_id, draft.id]
          );
          topup = existing.rows[0] ?? null;
        }
        await client.query(
          `UPDATE budget_topup_drafts SET status = 'confirmed', confirmed_at = $2 WHERE id = $1`,
          [draft.id, now]
        );
        const currentBudget = await currentMonthBudget(client, draft, now, userTimezone(draft));
        await updateOpenReserveBudget(client, draft.user_id, currentBudget.amount);
        await invalidateDailyBudgetSnapshot(client, draft.user_id, now, userTimezone(draft));
        await client.query("COMMIT");
        const dashboardSnapshot = (await this.dashboard(telegramUserId, now)).snapshot;
        return { topup: withDisplay(topup, draft), currentMonthBudget: currentBudget, dashboardSnapshot, alreadySaved: inserted.rows.length === 0, outcome: "confirmed" };
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* ignore rollback failures */ }
        throw error;
      } finally {
        client.release();
      }
    },

    async cancelBudgetTopupDraft(draftId, telegramUserId, now = new Date()) {
      const result = await pool.query(
        `UPDATE budget_topup_drafts
         SET status = 'cancelled', cancelled_at = $3
         WHERE id = $1
           AND user_id = (SELECT id FROM users WHERE telegram_user_id = $2)
           AND status = 'pending'
         RETURNING *`,
        [draftId, telegramUserId, now]
      );
      if (result.rows[0]) return { cancelled: true };
      const current = await pool.query(
        `SELECT status FROM budget_topup_drafts
         WHERE id = $1 AND user_id = (SELECT id FROM users WHERE telegram_user_id = $2)`,
        [draftId, telegramUserId]
      );
      const status = current.rows[0]?.status;
      if (status === "cancelled") return { cancelled: false, reason: "already_cancelled" };
      if (status === "confirmed") return { cancelled: false, reason: "already_confirmed" };
      if (status === "expired") return { cancelled: false, reason: "expired" };
      return { cancelled: false, reason: "not_found" };
    },

    async undoBudgetTopup(topupId, telegramUserId, now = new Date()) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const found = await client.query(
          `SELECT budget_topups.*,
                  users.telegram_user_id,
                  users.monthly_budget_amount,
                  users.base_currency,
                  users.display_currency,
                  users.display_currency_follows_base,
                  users.usd_thb_rate,
                  users.timezone
           FROM budget_topups
           JOIN users ON users.id = budget_topups.user_id
           WHERE budget_topups.id = $1
             AND users.telegram_user_id = $2
             AND budget_topups.deleted_at IS NULL
           FOR UPDATE`,
          [topupId, telegramUserId]
        );
        const topup = found.rows[0] ?? null;
        if (!topup) {
          await client.query("ROLLBACK");
          return { undone: false, reason: "not_found" };
        }
        if (new Date(topup.created_at).getTime() < now.getTime() - 10 * 60_000) {
          await client.query("ROLLBACK");
          return { undone: false, reason: "expired" };
        }
        await client.query(
          `UPDATE budget_topups SET deleted_at = $2
           WHERE id = $1 AND deleted_at IS NULL`,
          [topupId, now]
        );
        const currentBudget = await currentMonthBudget(client, topup, now, userTimezone(topup));
        await updateOpenReserveBudget(client, topup.user_id, currentBudget.amount);
        await invalidateDailyBudgetSnapshot(client, topup.user_id, now, userTimezone(topup));
        await client.query("COMMIT");
        const dashboardSnapshot = (await this.dashboard(telegramUserId, now)).snapshot;
        return { undone: true, topup: withDisplay(topup, topup), currentMonthBudget: currentBudget, dashboardSnapshot };
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* ignore rollback failures */ }
        throw error;
      } finally {
        client.release();
      }
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

    async updateDraftItemForTelegramUser(draftId, itemIndex, telegramUserId, patch, options = {}) {
      const expectedVersion = options.expectedVersion;
      const client = options.client ?? await pool.connect();
      const ownsTransaction = !options.client;
      try {
        if (ownsTransaction) await client.query("BEGIN");
        const draftResult = await client.query(
          `SELECT drafts.*
           FROM drafts
           JOIN users ON users.id = drafts.user_id
           WHERE drafts.id = $1
             AND users.telegram_user_id = $2
             AND drafts.status IN ('pending', 'inbox')
           FOR UPDATE`,
          [draftId, telegramUserId]
        );
        const draft = normalizeDraft(draftResult.rows[0] ?? null);
        if (!draft) throw codedError("Draft not found", "expense_not_found");
        if (expectedVersion != null && Number(draft.version) !== Number(expectedVersion)) {
          throw codedError("Draft version conflict", "expense_edit_conflict");
        }
        const index = Number(itemIndex);
        if (!Number.isInteger(index) || index < 0 || !draft.items[index]) {
          throw codedError("Draft item not found", "expense_not_found");
        }

        const items = draft.items.map((item, currentIndex) => currentIndex === index
          ? normalizeDraftItem({ ...item, ...patch })
          : normalizeDraftItem(item));
        const updatedResult = await client.query(
          `UPDATE drafts
           SET items = $1, version = version + 1
           WHERE id = $2
             AND status IN ('pending', 'inbox')
             AND version = $3
           RETURNING *`,
          [JSON.stringify(items), draft.id, draft.version]
        );
        const updated = normalizeDraft(updatedResult.rows[0] ?? null);
        if (!updated) throw codedError("Draft version conflict", "expense_edit_conflict");
        if (ownsTransaction) await client.query("COMMIT");
        return updated;
      } catch (error) {
        if (ownsTransaction) {
          try { await client.query("ROLLBACK"); } catch { /* preserve original transaction error */ }
        }
        throw error;
      } finally {
        if (ownsTransaction) client.release();
      }
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

    async listUnresolvedDraftsForTelegramUser(telegramUserId) {
      const result = await pool.query(
        `SELECT drafts.*
         FROM drafts
         JOIN users ON users.id = drafts.user_id
         WHERE users.telegram_user_id = $1
           AND drafts.status IN ('pending', 'inbox')
         ORDER BY drafts.created_at DESC, drafts.id DESC`,
        [telegramUserId]
      );
      return result.rows.map(normalizeDraft);
    },

    async listClosedReserveMonthsForTelegramUser(telegramUserId) {
      const result = await pool.query(
        `SELECT monthly_reserve_instances.period
         FROM monthly_reserve_instances
         JOIN users ON users.id = monthly_reserve_instances.user_id
         WHERE users.telegram_user_id = $1
           AND monthly_reserve_instances.status = 'closed'
         ORDER BY monthly_reserve_instances.period`,
        [telegramUserId]
      );
      return result.rows.map((row) => String(row.period));
    },

    async confirmDraft(draftId, telegramUserId) {
      const result = await this.saveDraftAsExpense(draftId, telegramUserId);
      return result.expenses;
    },

    async prepareDraftPreview(items, user = {}) {
      const baseCurrency = normalizeCurrency(user.base_currency, "THB");
      try {
        let total = 0;
        for (const item of items) {
          const moneyAmounts = await buildMoneyAmounts(
            exchangeRates,
            item.amount,
            item.currency,
            new Date(item.spent_at),
            { ...user, base_currency: baseCurrency }
          );
          total += moneyAmounts.amountBase;
        }
        return { kind: "converted", baseCurrency, total: roundMoney(total) };
      } catch (error) {
        if (error?.code === "exchange_rate_unavailable") {
          return { kind: "unavailable", baseCurrency };
        }
        throw error;
      }
    },

    async confirmDraftWithExplicitAcceptance(draftId, telegramUserId, options = {}) {
      return this.saveDraftAsExpense(draftId, telegramUserId, {
        ...options,
        explicitCategoryAcceptance: true
      });
    },

    async saveDraftAsExpense(draftId, telegramUserId, options = {}) {
      const client = options.client ?? await pool.connect();
      const ownsTransaction = !options.client;
      const readDashboardSnapshot = async () => {
        try {
          return (await this.dashboard(telegramUserId)).snapshot;
        } catch (error) {
          console.warn("[repository] dashboard snapshot unavailable after draft confirmation", { draftId, error: error?.message });
          return null;
        }
      };
      try {
        if (ownsTransaction) await client.query("BEGIN");
        const draftResult = await client.query(
          `SELECT drafts.*, users.base_currency, users.usd_thb_rate, users.timezone
           FROM drafts
           JOIN users ON users.id = drafts.user_id
           WHERE drafts.id = $1 AND users.telegram_user_id = $2
           FOR UPDATE`,
          [draftId, telegramUserId]
        );
        const draft = draftResult.rows[0];
        if (!draft) {
          if (ownsTransaction) await client.query("ROLLBACK");
          throw new DraftNotFoundError();
        }
        const status = draft.status;
        if (status !== "pending" && status !== "inbox") {
          if (ownsTransaction) await client.query("ROLLBACK");
          if (status === "cancelled") throw new DraftCanceledError();
          // already confirmed -> loser path: return the already-created expenses
          const existing = await pool.query(
            `SELECT * FROM expenses WHERE draft_id = $1 ORDER BY id`,
            [draftId]
          );
          const snapshot = ownsTransaction ? await readDashboardSnapshot() : null;
          return { expenses: existing.rows, dashboardSnapshot: snapshot, alreadySaved: true };
        }

        let items = Array.isArray(draft.items) ? draft.items : JSON.parse(draft.items);
        if (hasUnresolvedCurrencyAmbiguity(items)) {
          throw codedError("Draft requires an explicit currency selection", "currency_selection_required");
        }
        if (!options.explicitCategoryAcceptance && !draftHasValidCategories(items)) {
          console.warn("[repository] confirm blocked: missing valid category", { draftId });
          throw new CategoryRequiredError();
        }
        const explicitAcceptance = options.explicitCategoryAcceptance
          ? classifyExplicitAcceptanceDraft({ items }, { now: options.now, timeZone: userTimezone(draft) })
          : null;
        if (explicitAcceptance && !explicitAcceptance.eligible) throw explicitAcceptanceError(explicitAcceptance.reason);

        const timeZone = userTimezone(draft);
        const monthKeys = items.map((item) => timeZoneMonthKey(new Date(item.spent_at), timeZone));
        await lockFinancialMonths(client, draft.user_id, monthKeys);
        if ((await closedReserveMonths(client, draft.user_id, monthKeys)).size > 0) {
          throw codedError("Source month closed", "expense_source_month_closed");
        }
        await options.beforeSave?.(draft);
        if (options.explicitCategoryAcceptance) {
          items = items.map((item) => ({ ...item, category_source: "user", needs_review: false }));
          await client.query(
            `UPDATE drafts SET items = $1, version = version + 1 WHERE id = $2`,
            [JSON.stringify(items), draft.id]
          );
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
        if (ownsTransaction) await client.query("COMMIT");
        const snapshot = ownsTransaction ? await readDashboardSnapshot() : null;
        return { expenses: inserted, dashboardSnapshot: snapshot, alreadySaved: false };
      } catch (error) {
        if (ownsTransaction) {
          try { await client.query("ROLLBACK"); } catch { /* already rolled back or connection gone */ }
        }
        throw error;
      } finally {
        if (ownsTransaction) client.release();
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

    async getLatestEditableExpenseForTelegramUser(telegramUserId) {
      const result = await pool.query(
        `SELECT expenses.*
         FROM expenses
         JOIN users ON users.id = expenses.user_id
         WHERE users.telegram_user_id = $1
           AND expenses.budget_impact <> 'planned'
         ORDER BY expenses.created_at DESC, expenses.id DESC
         LIMIT 1`,
        [telegramUserId]
      );
      return result.rows[0] ?? null;
    },

    async getExpenseForTelegramUser(expenseId, telegramUserId) {
      const result = await pool.query(
        `SELECT expenses.*
         FROM expenses
         JOIN users ON users.id = expenses.user_id
         WHERE expenses.id = $1 AND users.telegram_user_id = $2`,
        [expenseId, telegramUserId]
      );
      return result.rows[0] ?? null;
    },

    async prepareExpenseUpdateForTelegramUser(expenseId, telegramUserId, patch, now = new Date()) {
      const currentNow = normalizeNow(now);
      const financialPatch = Object.keys(patch ?? {}).some((key) => ["amount", "currency", "spent_at", "budget_impact"].includes(key));
      if (!financialPatch) return null;
      const user = await this.getUserByTelegramId(telegramUserId);
      const expense = await this.getExpenseForTelegramUser(expenseId, telegramUserId);
      if (!user || !expense) throw codedError("Expense not found", "expense_not_found");
      const item = normalizeExpensePatch(expense, patch);
      const spentAt = new Date(item.spent_at);
      if (Number.isNaN(spentAt.getTime()) || spentAt > currentNow) {
        throw codedError("Future expense date", "expense_future_date");
      }
      return {
        item,
        moneyAmounts: await buildMoneyAmounts(exchangeRates, item.amount, item.currency, spentAt, user)
      };
    },

    async updateExpenseForTelegramUser(expenseId, telegramUserId, patch, now = new Date(), options = {}) {
      if (typeof pool.connect !== "function") {
        return updateExpenseWithoutTransaction(pool, exchangeRates, expenseId, telegramUserId, patch);
      }
      const currentNow = normalizeNow(now);
      const financialPatch = Object.keys(patch ?? {}).some((key) => ["amount", "currency", "spent_at", "budget_impact"].includes(key));
      const prepared = financialPatch
        ? (options.prepared ?? await this.prepareExpenseUpdateForTelegramUser(expenseId, telegramUserId, patch, currentNow))
        : null;
      const preflightItem = prepared?.item ?? null;
      const preflightMoneyAmounts = prepared?.moneyAmounts ?? null;
      const client = options.client ?? await pool.connect();
      const ownsTransaction = !options.client;
      try {
        if (ownsTransaction) await client.query("BEGIN");
        const userResult = await client.query(
          "SELECT * FROM users WHERE telegram_user_id = $1 FOR UPDATE",
          [telegramUserId]
        );
        const user = userResult.rows[0] ?? null;
        if (!user) throw codedError("Expense not found", "expense_not_found");
        const expenseResult = await client.query(
          "SELECT * FROM expenses WHERE id = $1 AND user_id = $2 FOR UPDATE",
          [expenseId, user.id]
        );
        const before = expenseResult.rows[0] ?? null;
        if (!before) throw codedError("Expense not found", "expense_not_found");
        const item = normalizeExpensePatch(before, patch);
        const spentAt = new Date(item.spent_at);
        if (Number.isNaN(spentAt.getTime()) || spentAt > currentNow) {
          throw codedError("Future expense date", "expense_future_date");
        }
        if (financialPatch && !sameExpenseFinancialInputs(preflightItem, item)) {
          throw codedError("Expense changed", "expense_edit_conflict");
        }
        const timeZone = userTimezone(user);
        const sourceMonth = timeZoneMonthKey(new Date(before.spent_at), timeZone);
        const targetMonth = timeZoneMonthKey(spentAt, timeZone);
        await lockFinancialMonths(client, user.id, [sourceMonth, targetMonth]);
        const closedMonths = await closedReserveMonths(client, user.id, [sourceMonth, targetMonth]);
        const changedKeys = Object.keys(patch ?? {});
        const metadataOnly = changedKeys.every((key) => ["description", "category_slug", "tags"].includes(key));
        if (closedMonths.has(sourceMonth) && !metadataOnly) {
          throw codedError("Source month closed", "expense_source_month_closed");
        }
        if (targetMonth !== sourceMonth && closedMonths.has(targetMonth)) {
          throw codedError("Target month closed", "expense_target_month_closed");
        }

        const moneyAmounts = financialPatch ? preflightMoneyAmounts : {
          amountBase: Number(before.amount_base),
          convertedAmounts: before.converted_amounts,
          source: before.exchange_rate_source
        };
        const updatedResult = await client.query(
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
               budget_impact = $11,
               updated_at = $12
           WHERE id = $13 AND user_id = $14
           RETURNING *`,
          [
            item.amount, item.currency, moneyAmounts.amountBase, JSON.stringify(moneyAmounts.convertedAmounts),
            spentAt.toISOString().slice(0, 10), moneyAmounts.source, item.description, item.category_slug,
            item.tags, spentAt, item.budget_impact, currentNow, before.id, user.id
          ]
        );
        const updated = updatedResult.rows[0] ?? null;
        if (!updated) throw codedError("Expense not found", "expense_not_found");
        if (shouldInvalidateExpenseSnapshot(before, updated, { now: currentNow, timeZone })) {
          await client.query(
            `DELETE FROM daily_budget_snapshots
             WHERE user_id = $1 AND day_key = $2`,
            [user.id, timeZoneDayKey(currentNow, timeZone)]
          );
        }
        if (ownsTransaction) await client.query("COMMIT");
        return updated;
      } catch (error) {
        if (ownsTransaction) {
          try { await client.query("ROLLBACK"); } catch { /* preserve original transaction error */ }
        }
        throw error;
      } finally {
        if (ownsTransaction) client.release();
      }
    },

    async deleteExpenseForTelegramUser(expenseId, telegramUserId, now = new Date(), options = {}) {
      if (typeof pool.connect !== "function") {
        const result = await pool.query(
          `DELETE FROM expenses
           WHERE id = $1 AND user_id = (SELECT id FROM users WHERE telegram_user_id = $2)
           RETURNING *`,
          [expenseId, telegramUserId]
        );
        return result.rows[0] ?? null;
      }
      const currentNow = normalizeNow(now);
      const client = options.client ?? await pool.connect();
      const ownsTransaction = !options.client;
      try {
        if (ownsTransaction) await client.query("BEGIN");
        const userResult = await client.query("SELECT * FROM users WHERE telegram_user_id = $1 FOR UPDATE", [telegramUserId]);
        const user = userResult.rows[0] ?? null;
        if (!user) throw codedError("Expense not found", "expense_not_found");
        const expenseResult = await client.query("SELECT * FROM expenses WHERE id = $1 AND user_id = $2 FOR UPDATE", [expenseId, user.id]);
        const expense = expenseResult.rows[0] ?? null;
        if (!expense) throw codedError("Expense not found", "expense_not_found");
        const timeZone = userTimezone(user);
        const month = timeZoneMonthKey(new Date(expense.spent_at), timeZone);
        await lockFinancialMonths(client, user.id, [month]);
        if ((await closedReserveMonths(client, user.id, [month])).has(month)) {
          throw codedError("Expense delete blocked", "expense_delete_blocked");
        }
        const deletedResult = await client.query("DELETE FROM expenses WHERE id = $1 AND user_id = $2 RETURNING *", [expense.id, user.id]);
        const deleted = deletedResult.rows[0] ?? null;
        if (!deleted) throw codedError("Expense not found", "expense_not_found");
        if (shouldInvalidateExpenseSnapshot(expense, { ...expense, amount_original: 0 }, { now: currentNow, timeZone })) {
          await client.query("DELETE FROM daily_budget_snapshots WHERE user_id = $1 AND day_key = $2", [user.id, timeZoneDayKey(currentNow, timeZone)]);
        }
        if (ownsTransaction) await client.query("COMMIT");
        return deleted;
      } catch (error) {
        if (ownsTransaction) {
          try { await client.query("ROLLBACK"); } catch { /* preserve original transaction error */ }
        }
        throw error;
      } finally {
        if (ownsTransaction) client.release();
      }
    },

    async listExpensesByDraftId(draftId) {
      const result = await pool.query(
        `SELECT * FROM expenses WHERE draft_id = $1 ORDER BY id`,
        [draftId]
      );
      return result.rows;
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
      const amountSearch = parseAmountSearch(search);
      const params = [user.id, bounds.start, bounds.end];
      let searchSql = "";
      if (search && !amountSearch) {
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
      const expenses = result.rows.map((row) => withDisplay(row, user));
      return amountSearch
        ? expenses.filter((expense) => matchesExpenseSearch({ ...expense, base_currency: user.base_currency }, search))
        : expenses;
    },

    async listExpenseExportRowsForTelegramUser(telegramUserId, options = {}) {
      const user = await this.getUserByTelegramId(telegramUserId);
      if (!user) return [];
      const period = options.period === "all" ? "all" : "month";
      const limit = Math.max(1, Math.min(Number(options.limit) || 500, 1000));
      const offset = Math.max(0, Number(options.offset) || 0);
      const timezone = userTimezone(user);
      const baseSelect = `SELECT id, amount_original, currency_original, amount_base,
                converted_amounts, description, category_slug, spent_at, created_at
         FROM expenses
         WHERE user_id = $1`;
      let sql;
      let params;
      if (period === "month") {
        const bounds = localPeriodBounds(options.now ?? new Date(), "month", timezone);
        sql = `${baseSelect} AND spent_at >= $2 AND spent_at < $3
         ORDER BY spent_at ASC, id ASC
         LIMIT $4 OFFSET $5`;
        params = [user.id, bounds.start, bounds.end, limit, offset];
      } else {
        sql = `${baseSelect}
         ORDER BY spent_at ASC, id ASC
         LIMIT $2 OFFSET $3`;
        params = [user.id, limit, offset];
      }
      const result = await pool.query(sql, params);
      return result.rows.map((row) => ({ ...withDisplay(row, user), user_timezone: timezone }));
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
        [userId, bounds.start, bounds.end, effectiveDisplayCurrency(user), displayThbRate(user)]
      );
      return result.rows.map((row) => withDisplayTotal(row, user));
    },

    async listPlannedExpensesForTelegramUser(telegramUserId, now = new Date()) {
      return listPlannedExpensesForTelegramUserAt(pool, telegramUserId, now);
    },

    async listArchivedPlannedExpensesForTelegramUser(telegramUserId) {
      const result = await pool.query(
        `WITH valid_payments AS (
           SELECT DISTINCT ON (pep.planned_expense_id, pep.paid_key)
                  pep.planned_expense_id, pep.paid_key, e.amount_base
           FROM planned_expense_payments pep
           JOIN planned_expenses source ON source.id = pep.planned_expense_id
           JOIN expenses e ON e.id = pep.expense_id AND e.user_id = source.user_id
           ORDER BY pep.planned_expense_id, pep.paid_key, pep.id
         ), paid AS (
           SELECT planned_expense_id,
                  COUNT(*)::int AS paid_count,
                  COALESCE(SUM(amount_base), 0)::float AS paid_amount_base
           FROM valid_payments
           GROUP BY planned_expense_id
         )
         SELECT planned_expenses.*,
                users.timezone AS user_timezone,
                users.base_currency AS user_base_currency,
                users.display_currency AS user_display_currency,
                users.display_currency_follows_base AS user_display_currency_follows_base,
                users.usd_thb_rate AS user_usd_thb_rate,
                COALESCE(paid.paid_count, 0)::int AS paid_count,
                COALESCE(paid.paid_amount_base, 0)::float AS paid_amount_base
         FROM planned_expenses
         JOIN users ON users.id = planned_expenses.user_id
         LEFT JOIN paid ON paid.planned_expense_id = planned_expenses.id
         WHERE users.telegram_user_id = $1 AND planned_expenses.active = false
         ORDER BY planned_expenses.disabled_at DESC NULLS LAST, planned_expenses.id DESC`,
        [telegramUserId]
      );
      return result.rows.map((row) => {
        const {
          user_timezone,
          user_base_currency,
          user_display_currency,
          user_display_currency_follows_base,
          user_usd_thb_rate,
          ...planned
        } = row;
        const user = {
          timezone: user_timezone,
          base_currency: user_base_currency,
          display_currency: user_display_currency,
          display_currency_follows_base: user_display_currency_follows_base,
          usd_thb_rate: user_usd_thb_rate
        };
        const mapped = withDisplayPlanned(planned, user);
        mapped.display.paid_amount = displayFromBase(planned.paid_amount_base, user);
        return mapped;
      });
    },

    async recreatePlannedExpense(telegramUserId, archivedId, input, startsOn, now = new Date()) {
      const source = await readOwnedArchivedPlannedExpense(pool, telegramUserId, archivedId, false);
      if (!source) return null;

      const planned = normalizePlannedExpense(input);
      const startsOnKey = typeof startsOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(startsOn)
        ? normalizePlannedDateKey(startsOn)
        : null;
      if (!startsOnKey) throw codedError("Invalid planned start date", "invalid_planned_start_date");
      const todayKey = localDayKey(now, userTimezone(source));
      if (startsOnKey < todayKey) {
        throw codedError("Planned start date is in the past", "planned_start_date_in_past");
      }
      const dueDateKey = normalizePlannedDateKey(planned.due_date);
      if (planned.recurrence === "one_off" && !dueDateKey) {
        throw codedError("Invalid planned due date", "invalid_planned_due_date");
      }
      if (planned.recurrence === "one_off" && dueDateKey < startsOnKey) {
        throw codedError("Planned due date is before start", "planned_due_date_before_start");
      }
      const money = await buildMoneyAmounts(exchangeRates, planned.amount, planned.currency, now, source);

      const client = await pool.connect();
      let created = null;
      try {
        await client.query("BEGIN");
        const locked = await readOwnedArchivedPlannedExpense(client, telegramUserId, archivedId, true);
        if (!locked) {
          await client.query("ROLLBACK");
          return null;
        }
        const candidate = {
          ...planned,
          amount_base: money.amountBase,
          active: true,
          starts_on: startsOnKey
        };
        await assertPlannedMutationCapacityWithQueryable(client, locked, candidate, null);
        const result = await client.query(
          `INSERT INTO planned_expenses (
             user_id, amount, currency, amount_base, description, category_slug, tags,
             recurrence, due_day, due_days, weekday, due_date, starts_on, active
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true)
           RETURNING *`,
          [
            locked.user_id,
            planned.amount,
            planned.currency,
            money.amountBase,
            planned.description,
            planned.category_slug,
            planned.tags,
            planned.recurrence,
            planned.due_day,
            planned.due_days,
            planned.weekday,
            planned.due_date,
            startsOnKey
          ]
        );
        created = result.rows[0] ?? null;
        await client.query("COMMIT");
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* preserve original transaction error */ }
        throw error;
      } finally {
        client.release();
      }
      if (created) {
        try {
          await this.recordAppEvent(created.user_id, "planned_expense_created", { source: "miniapp", mode: "recreate" });
        } catch (error) {
          console.warn("[repository] recreate event failed after commit", { message: error?.message });
        }
      }
      return created;
    },

    async createPlannedExpense(telegramUserId, input, now = new Date()) {
      const user = await this.getUserByTelegramId(telegramUserId);
      if (!user) return null;
      const planned = normalizePlannedExpense(input);
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
      const row = result.rows[0] ?? null;
      if (row) await this.recordAppEvent(row.user_id ?? user.id, "planned_expense_created", { source: "miniapp" });
      return row;
    },

    async updatePlannedExpense(telegramUserId, plannedExpenseId, input, now = new Date()) {
      const planned = normalizePlannedExpense(input);
      const user = await this.getUserByTelegramId(telegramUserId);
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
             due_date = $11
         WHERE id = $12
           AND user_id = (SELECT id FROM users WHERE telegram_user_id = $13)
           AND active = true
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
          plannedExpenseId,
          telegramUserId
        ]
      );
      const row = result.rows[0] ?? null;
      if (row) await this.recordAppEvent(row.user_id ?? user.id, "planned_expense_updated", { source: "miniapp" });
      return row;
    },

    async deactivatePlannedExpense(telegramUserId, plannedExpenseId, now = new Date()) {
      const currentNow = normalizeNow(now);
      const client = await pool.connect();
      let response = null;
      let transitioned = false;
      try {
        await client.query("BEGIN");
        const plannedResult = await client.query(
          `SELECT planned_expenses.*, users.base_currency, users.timezone
           FROM planned_expenses
           JOIN users ON users.id = planned_expenses.user_id
           WHERE planned_expenses.id = $1
             AND users.telegram_user_id = $2
           FOR UPDATE`,
          [plannedExpenseId, telegramUserId]
        );
        const planned = plannedResult.rows[0] ?? null;
        if (!planned) {
          await client.query("ROLLBACK");
          return null;
        }

        const timeZone = userTimezone(planned);
        const impactNow = planned.active || !planned.disabled_at
          ? currentNow
          : normalizeNow(planned.disabled_at);
        const currentMonth = timeZoneMonthKey(impactNow, timeZone);
        const occurrenceDates = plannedDueDatesThisMonth(planned, impactNow, timeZone)
          .map((date) => localDayKey(date, timeZone));
        const occurrenceDateSet = new Set(occurrenceDates);
        const paidResult = await client.query(
          `SELECT pep.occurrence_date::text, e.amount_base
           FROM planned_expense_payments pep
           JOIN expenses e ON e.id = pep.expense_id
                          AND e.user_id = $2
           WHERE pep.planned_expense_id = $1
             AND pep.paid_month = $3
           ORDER BY pep.occurrence_date`,
          [planned.id, planned.user_id, currentMonth]
        );
        const validPaidByOccurrence = new Map();
        for (const payment of paidResult.rows) {
          const occurrenceDate = normalizeOccurrenceKey(payment.occurrence_date);
          if (occurrenceDate && !validPaidByOccurrence.has(occurrenceDate)) {
            validPaidByOccurrence.set(occurrenceDate, Number(payment.amount_base ?? 0));
          }
        }
        const unpaidOccurrencesRemoved = occurrenceDates.filter((date) => !validPaidByOccurrence.has(date)).length;
        const impact = {
          paidOccurrencesKept: validPaidByOccurrence.size,
          paidAmountKept: roundMoney([...validPaidByOccurrence.values()].reduce((sum, amount) => sum + amount, 0)),
          unpaidOccurrencesRemoved,
          unpaidAmountRemoved: roundMoney(unpaidOccurrencesRemoved * Number(planned.amount_base ?? 0)),
          currency: planned.base_currency
        };

        let plannedExpense;
        if (planned.active) {
          const updatedResult = await client.query(
            `UPDATE planned_expenses
             SET active = false, disabled_at = $2
             WHERE id = $1 AND active = true
             RETURNING *`,
            [planned.id, currentNow]
          );
          plannedExpense = updatedResult.rows[0] ?? null;
          transitioned = Boolean(plannedExpense);
        } else {
          const { base_currency: _baseCurrency, timezone: _timezone, ...storedPlannedExpense } = planned;
          plannedExpense = storedPlannedExpense;
        }
        response = plannedExpense ? { plannedExpense, impact } : null;
        await client.query("COMMIT");
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* preserve original transaction error */ }
        throw error;
      } finally {
        client.release();
      }
      if (transitioned && response) {
        await this.recordAppEvent(response.plannedExpense.user_id, "planned_expense_deleted", { source: "miniapp" });
      }
      return response;
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
           WHERE pep.planned_expense_id = $1
             AND pep.paid_month = $2
           ORDER BY pep.occurrence_date`,
          [planned.id, monthKey(paidAt, timeZone), planned.user_id]
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

    async undoPlannedExpensePaymentForTelegramUser(plannedExpenseId, telegramUserId, occurrenceDate, now = new Date()) {
      const normalizedOccurrenceDate = normalizePlannedDateKey(occurrenceDate);
      if (!normalizedOccurrenceDate) throw codedError("Invalid planned occurrence", "invalid_occurrence");

      const client = await pool.connect();
      let undone = false;
      let userId = null;
      try {
        await client.query("BEGIN");
        const plannedResult = await client.query(
          `SELECT planned_expenses.*, users.timezone
           FROM planned_expenses
           JOIN users ON users.id = planned_expenses.user_id
           WHERE planned_expenses.id = $1
             AND users.telegram_user_id = $2
           FOR UPDATE`,
          [plannedExpenseId, telegramUserId]
        );
        const planned = plannedResult.rows[0] ?? null;
        if (!planned) throw codedError("Planned expense not found", "planned_expense_not_found");
        userId = planned.user_id;

        const paymentResult = await client.query(
          `SELECT id, planned_expense_id, expense_id, occurrence_date::text
           FROM planned_expense_payments
           WHERE planned_expense_id = $1
             AND occurrence_date = $2::date
           FOR UPDATE`,
          [planned.id, normalizedOccurrenceDate]
        );
        const payment = paymentResult.rows[0] ?? null;
        if (!payment) {
          await client.query("COMMIT");
          return { status: "already_unpaid", occurrenceDate: normalizedOccurrenceDate };
        }

        const expenseResult = await client.query(
          `SELECT * FROM expenses WHERE id = $1 FOR UPDATE`,
          [payment.expense_id]
        );
        const expense = expenseResult.rows[0] ?? null;
        if (!expense || String(expense.user_id) !== String(planned.user_id)) {
          throw codedError("Planned payment is inconsistent", "planned_payment_inconsistent");
        }

        const expenseMonth = timeZoneMonthKey(new Date(expense.spent_at), userTimezone(planned));
        await lockFinancialMonths(client, planned.user_id, [expenseMonth]);
        if ((await closedReserveMonths(client, planned.user_id, [expenseMonth])).has(expenseMonth)) {
          throw codedError("Planned payment undo blocked", "planned_payment_undo_blocked");
        }

        const deletedPayment = await client.query(
          `DELETE FROM planned_expense_payments
           WHERE id = $1 AND planned_expense_id = $2
           RETURNING id`,
          [payment.id, planned.id]
        );
        if (!deletedPayment.rows[0]) throw codedError("Planned payment is inconsistent", "planned_payment_inconsistent");

        const deletedExpense = await client.query(
          `DELETE FROM expenses
           WHERE id = $1 AND user_id = $2
           RETURNING id`,
          [expense.id, planned.user_id]
        );
        if (!deletedExpense.rows[0]) throw codedError("Planned payment is inconsistent", "planned_payment_inconsistent");
        await client.query("COMMIT");
        undone = true;
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* preserve the original transaction error */ }
        throw error;
      } finally {
        client.release();
      }

      if (undone) {
        try {
          await this.recordAppEvent(userId, "planned_expense_payment_undone", { source: "miniapp" });
        } catch (error) {
          console.warn("[repository] planned payment undo event failed after commit", { message: error?.message });
        }
      }
      return { status: "undone", occurrenceDate: normalizedOccurrenceDate };
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

    async dashboard(telegramUserId, now = new Date(), timing = null) {
      const user = await this.getUserByTelegramId(telegramUserId);
      if (!user) return null;
      const timeZone = userTimezone(user);
      const reserveOpening = typeof pool.connect === "function"
        ? await measureStartupPhase(timing, "reserve", () => this.openReserveMonth(telegramUserId, now, timing))
        : null;
      const reserveData = await measureStartupPhase(timing, "reserve_reads", async () => {
        const reserveInstanceResult = typeof pool.connect === "function"
          ? await pool.query(
              `SELECT * FROM monthly_reserve_instances
               WHERE user_id = $1 AND period = $2`,
              [user.id, timeZoneMonthKey(now, normalizeTimeZone(user.timezone))]
            )
          : { rows: [] };
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
        return { reserveInstanceResult, reserveTemplateResult, pendingReserveEventsResult };
      });
      const reserveInstance = reserveData.reserveInstanceResult.rows[0] ?? null;
      const calculationTimeZone = reserveInstance?.status === "active"
        ? reserveInstance.timezone
        : timeZone;
      const currentBudget = await measureStartupPhase(
        timing,
        "budget",
        () => currentMonthBudget(pool, user, now, calculationTimeZone)
      );
      const totals = await measureStartupPhase(timing, "totals", () => this.totals(user.id, now, calculationTimeZone));
      const monthBaseline = await measureStartupPhase(
        timing,
        "baseline",
        () => monthBaselineTotal(pool, user.id, now, calculationTimeZone)
      );
      totals.month += monthBaseline;
      totals.monthDisplay += displayFromBase(monthBaseline, user);
      totals.regularMonth += monthBaseline;
      totals.regularMonthDisplay += displayFromBase(monthBaseline, user);
      const plannedExpenses = await measureStartupPhase(
        timing,
        "planned",
        () => listPlannedExpensesForTelegramUserAt(pool, telegramUserId, now)
      );
      const plannedRemainingTotal = calculatePlannedRemaining(plannedExpenses, now, calculationTimeZone);
      const plannedThisWeekTotal = calculatePlannedThisWeek(plannedExpenses, now, calculationTimeZone);
      const paidPlannedMonthTotal = await measureStartupPhase(
        timing,
        "paid_planned",
        () => paidPlannedTotalForMonth(pool, user.id, now, calculationTimeZone)
      );
      const rawActiveReserveAmount = reserveInstance?.status === "active" ? Number(reserveInstance.reserve_amount) : 0;
      const activeReserveAmount = roundForDisplayCurrency(rawActiveReserveAmount, user.base_currency);
      const activeReserveDisplayAmount = displayFromBase(activeReserveAmount, user);
      const plannedRemaining = roundForDisplayCurrency(plannedRemainingTotal, user.base_currency);
      const plannedRemainingDisplayTotal = displayFromBase(plannedRemaining, user);
      const plannedThisWeekDisplayTotal = displayFromBase(plannedThisWeekTotal, user);
      const paidPlannedMonthDisplayTotal = displayFromBase(paidPlannedMonthTotal, user);
      const plannedMonthPaid = roundMoney(paidPlannedMonthTotal);
      const plannedMonthRemaining = roundMoney(plannedRemaining);
      const plannedMonthDisplayPaid = roundMoney(paidPlannedMonthDisplayTotal);
      const plannedMonthDisplayRemaining = roundMoney(plannedRemainingDisplayTotal);
      const plannedMonthSummary = {
        paid: plannedMonthPaid,
        remaining: plannedMonthRemaining,
        total: roundMoney(plannedMonthPaid + plannedMonthRemaining),
        display: {
          currency: effectiveDisplayCurrency(user),
          paid: plannedMonthDisplayPaid,
          remaining: plannedMonthDisplayRemaining,
          total: roundMoney(plannedMonthDisplayPaid + plannedMonthDisplayRemaining)
        }
      };
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
      const dayBudgetSnapshot = await measureStartupPhase(timing, "snapshot", () => getOrCreateDailyBudgetSnapshot(pool, user, now, {
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
        displayCurrency: effectiveDisplayCurrency(user),
        budgetAdviceEnabled: user.budget_advice_enabled !== false,
        timeZone: calculationTimeZone
      }));
      const latest = await measureStartupPhase(timing, "latest", () => pool.query(
        `SELECT id, amount_original, currency_original, amount_base, converted_amounts, budget_impact,
                description, category_slug, tags, spent_at
         FROM expenses
         WHERE user_id = $1
         ORDER BY spent_at DESC
         LIMIT 5`,
        [user.id]
      ));
      const snapshot = calculateBudgetSnapshot({
        todayTotal: totals.today,
        weekTotal: totals.week,
        monthTotal: totals.month,
        todayDisplayTotal: totals.todayDisplay,
        weekDisplayTotal: totals.weekDisplay,
        monthDisplayTotal: totals.monthDisplay,
        displayCurrency: effectiveDisplayCurrency(user),
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
      const topCategories = await measureStartupPhase(timing, "top_categories", () => this.topCategories(user.id, now));
      const analytics = await measureStartupPhase(
        timing,
        "dashboard_analytics",
        () => dashboardAnalytics(pool, user, topCategories, snapshot, now, calculationTimeZone)
      );
      return {
        user,
        currentMonthBudget: currentBudget,
        reserveInstance,
        reserveTemplate: reserveData.reserveTemplateResult.rows[0] ?? null,
        recurringReserveBlocked: reserveOpening?.recurringReserveBlocked === true,
        closedReserveEvents: reserveData.pendingReserveEventsResult.rows,
        snapshot,
        plannedMonthSummary,
        latestExpenses: latest.rows.map((row) => withDisplay(row, user)),
        topCategories,
        analytics,
        plannedExpenses: plannedExpenses.map((row) => withDisplayPlanned(row, user))
      };
    }
  };
}

function hashPaidProviderRequestKey(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
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
        currency: effectiveDisplayCurrency(user),
        current: snapshot.display.week,
        previous: previousWeek.regularDisplayTotal,
        delta: roundMoney(snapshot.display.week - previousWeek.regularDisplayTotal)
      }
    },
    otherCategoryWarning: {
      active: otherPercent > 10,
      percent: otherPercent,
      total: roundMoney(otherTotal),
      display: otherCategory?.display ?? { currency: effectiveDisplayCurrency(user), amount: 0 }
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
    [userId, bounds.start, bounds.end, effectiveDisplayCurrency(user), displayThbRate(user)]
  );
  return result.rows.map((row) => ({
    tag: row.tag,
    total: roundMoney(Number(row.total)),
    display: {
      currency: effectiveDisplayCurrency(user),
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
  const period = monthKey(now, timeZone);
  const result = await pool.query(
    `SELECT COALESCE(SUM(paid.amount_base), 0)::float AS total
     FROM (
       SELECT planned_expense_payments.planned_expense_id,
              planned_expense_payments.paid_key,
              MAX(expenses.amount_base)::float AS amount_base
       FROM planned_expense_payments
       JOIN planned_expenses
         ON planned_expenses.id = planned_expense_payments.planned_expense_id
       JOIN expenses
         ON expenses.id = planned_expense_payments.expense_id
        AND expenses.user_id = planned_expenses.user_id
       WHERE planned_expenses.user_id = $1
         AND planned_expense_payments.paid_month = $2
       GROUP BY planned_expense_payments.planned_expense_id,
                planned_expense_payments.paid_key
     ) paid`,
    [userId, period]
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

  const snapshotInput = dailyBudgetSnapshotOpeningInput(input);
  const snapshot = calculateBudgetSnapshot({
    ...snapshotInput,
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

function dailyBudgetSnapshotOpeningInput(input) {
  const todayRegular = Number(input.todayTotal ?? 0);
  const todayRegularDisplay = Number(input.todayDisplayTotal ?? 0);
  return {
    ...input,
    monthTotal: Math.max(Number(input.monthTotal ?? 0) - todayRegular, 0),
    monthDisplayTotal: Math.max(Number(input.monthDisplayTotal ?? 0) - todayRegularDisplay, 0)
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

function hasUnresolvedCurrencyAmbiguity(items) {
  return Array.isArray(items) && items.some((item) =>
    item?.review_reason === "currency_ambiguous" && item?.currency == null
  );
}

function explicitAcceptanceError(reason) {
  if (["no_items", "category_required"].includes(reason)) return new CategoryRequiredError();
  const codes = {
    invalid_amount: "expense_invalid_amount",
    invalid_currency: "expense_invalid_currency",
    invalid_date: "expense_invalid_date",
    future_date: "expense_future_date",
    non_expense_operation: "expense_operation_not_supported",
    closed_month: "expense_source_month_closed"
  };
  return codedError("Draft cannot be accepted as an expense", codes[reason] ?? "expense_invalid_draft");
}

async function updateExpenseWithoutTransaction(pool, exchangeRates, expenseId, telegramUserId, patch) {
  const item = normalizeDraftItem(patch);
  const spentAt = new Date(item.spent_at);
  const userResult = await pool.query("SELECT * FROM users WHERE telegram_user_id = $1", [telegramUserId]);
  const user = userResult.rows[0] ?? null;
  const moneyAmounts = await buildMoneyAmounts(exchangeRates, item.amount, item.currency, spentAt, user);
  const result = await pool.query(
    `UPDATE expenses
     SET amount_original = $1, currency_original = $2, amount_base = $3,
         converted_amounts = $4, exchange_rate_date = $5, exchange_rate_source = $6,
         description = $7, category_slug = $8, tags = $9, spent_at = $10,
         budget_impact = $11, updated_at = now()
     WHERE id = $12 AND user_id = (SELECT id FROM users WHERE telegram_user_id = $13)
     RETURNING *`,
    [
      item.amount, item.currency, moneyAmounts.amountBase, JSON.stringify(moneyAmounts.convertedAmounts),
      spentAt.toISOString().slice(0, 10), moneyAmounts.source, item.description, item.category_slug,
      item.tags, spentAt, item.budget_impact, expenseId, telegramUserId
    ]
  );
  return result.rows[0] ?? null;
}

function normalizeExpensePatch(before, patch) {
  return normalizeDraftItem({
    amount: patch?.amount ?? before.amount_original,
    currency: patch?.currency ?? before.currency_original,
    description: patch?.description ?? before.description,
    category_slug: patch?.category_slug ?? before.category_slug,
    category_source: patch?.category_source ?? before.category_source,
    tags: patch?.tags ?? before.tags,
    spent_at: patch?.spent_at ?? before.spent_at,
    budget_impact: patch?.budget_impact ?? before.budget_impact,
    confidence: patch?.confidence ?? before.confidence,
    needs_review: patch?.needs_review ?? before.needs_review
  });
}

function sameExpenseFinancialInputs(left, right) {
  return Number(left.amount) === Number(right.amount)
    && String(left.currency) === String(right.currency)
    && new Date(left.spent_at).getTime() === new Date(right.spent_at).getTime()
    && String(left.budget_impact) === String(right.budget_impact);
}

async function lockFinancialMonths(client, userId, monthKeys, timing = null) {
  for (const monthKey of [...new Set(monthKeys.filter(Boolean))].sort()) {
    await measureStartupPhase(timing, "financial_month_lock", () => client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`money-flow:${userId}:${monthKey}`]
    ));
  }
}

function measureStartupPhase(timing, name, operation) {
  return timing ? timing.measure(name, operation) : operation();
}

async function closedReserveMonths(client, userId, monthKeys) {
  const keys = [...new Set(monthKeys.filter(Boolean))];
  if (!keys.length) return new Set();
  const result = await client.query(
    `SELECT period
     FROM monthly_reserve_instances
     WHERE user_id = $1 AND period = ANY($2) AND status = 'closed'
     FOR UPDATE`,
    [userId, keys]
  );
  return new Set(result.rows
    .map((row) => row.period == null ? null : String(row.period))
    .filter((period) => period && keys.includes(period)));
}

export function shouldInvalidateExpenseSnapshot(before, after, { now = new Date(), timeZone = "Asia/Bangkok" } = {}) {
  if (!before || !after || !expenseFinancialInputsChanged(before, after)) return false;
  const currentMonth = timeZoneMonthKey(now, timeZone);
  const beforeMonth = expenseMonthKey(before, timeZone);
  const afterMonth = expenseMonthKey(after, timeZone);
  if (beforeMonth !== currentMonth && afterMonth !== currentMonth) return false;

  const beforeImpact = before.budget_impact ?? "regular";
  const afterImpact = after.budget_impact ?? "regular";
  if (beforeImpact !== afterImpact) return true;
  if (beforeImpact === "large_oneoff") return true;
  if (beforeImpact !== "regular") return false;

  const today = timeZoneDayKey(now, timeZone);
  const beforeDay = expenseDayKey(before, timeZone);
  const afterDay = expenseDayKey(after, timeZone);
  return !(beforeDay === today && afterDay === today);
}

function normalizeDraft(draft) {
  if (!draft) return null;
  return {
    ...draft,
    items: Array.isArray(draft.items) ? draft.items : JSON.parse(draft.items)
  };
}

function expenseFinancialInputsChanged(before, after) {
  return Number(before.amount_original ?? before.amount) !== Number(after.amount_original ?? after.amount)
    || String(before.currency_original ?? before.currency ?? "") !== String(after.currency_original ?? after.currency ?? "")
    || String(before.spent_at ?? "") !== String(after.spent_at ?? "")
    || String(before.budget_impact ?? "regular") !== String(after.budget_impact ?? "regular");
}

function expenseMonthKey(expense, timeZone) {
  const spentAt = new Date(expense?.spent_at);
  return Number.isNaN(spentAt.getTime()) ? null : timeZoneMonthKey(spentAt, timeZone);
}

function expenseDayKey(expense, timeZone) {
  const spentAt = new Date(expense?.spent_at);
  return Number.isNaN(spentAt.getTime()) ? null : timeZoneDayKey(spentAt, timeZone);
}

function normalizePlannedDraft(draft) {
  if (!draft) return null;
  return {
    ...draft,
    item: typeof draft.item === "string" ? JSON.parse(draft.item) : draft.item
  };
}

function normalizeBudgetTopupDraft(draft) {
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

async function reportExpensesForPeriod(pool, user, bounds, timeZone) {
  const result = await pool.query(
    `SELECT id, amount_base::float AS amount_base, converted_amounts, description,
            category_slug, budget_impact, spent_at,
            (spent_at AT TIME ZONE $4)::date::text AS local_date
     FROM expenses
     WHERE user_id = $1
       AND spent_at >= $2
       AND spent_at < $3
     ORDER BY spent_at ASC, id ASC`,
    [user.id, bounds.start, bounds.end, timeZone]
  );
  return result.rows.map((row) => withDisplay(row, user));
}

async function reportPaidPlannedPaymentsForPeriod(pool, user, bounds, timeZone) {
  const result = await pool.query(
    `SELECT planned_expense_payments.expense_id,
            planned_expenses.description AS name,
            planned_expenses.amount_base::float AS planned_amount_base,
            expenses.amount_base::float AS amount_base,
            planned_expense_payments.occurrence_date::text AS occurrence_date,
            (expenses.spent_at AT TIME ZONE $4)::date::text AS local_date
     FROM planned_expense_payments
     JOIN planned_expenses ON planned_expenses.id = planned_expense_payments.planned_expense_id
     JOIN expenses ON expenses.id = planned_expense_payments.expense_id
     WHERE expenses.user_id = $1
       AND expenses.spent_at >= $2
       AND expenses.spent_at < $3
     ORDER BY planned_expense_payments.occurrence_date ASC, planned_expense_payments.id ASC`,
    [user.id, bounds.start, bounds.end, timeZone]
  );
  return result.rows.map((row) => ({
    ...row,
    display: {
      currency: effectiveDisplayCurrency(user),
      amount: displayFromBase(row.amount_base, user)
    }
  }));
}

async function reportBudgetTopupsForPeriod(pool, user, bounds, timeZone) {
  const result = await pool.query(
    `SELECT *, (occurred_at AT TIME ZONE $4)::date::text AS local_date
     FROM budget_topups
     WHERE user_id = $1
       AND occurred_at >= $2
       AND occurred_at < $3
       AND deleted_at IS NULL
     ORDER BY occurred_at ASC, id ASC`,
    [user.id, bounds.start, bounds.end, timeZone]
  );
  return result.rows.map((row) => withDisplay(row, user));
}

async function reportAllCategoriesForPeriod(pool, user, bounds) {
  const result = await pool.query(
    `SELECT category_slug,
            COALESCE(SUM(amount_base), 0)::float AS total
     FROM expenses
     WHERE user_id = $1
       AND spent_at >= $2
       AND spent_at < $3
     GROUP BY category_slug
     ORDER BY total DESC`,
    [user.id, bounds.start, bounds.end]
  );
  return result.rows;
}

function reportLargeExpenseThreshold(user, budget = {}) {
  const currency = normalizeCurrency(user?.base_currency, "THB");
  const fixedByCurrency = {
    THB: 2000,
    RUB: 5000,
    USD: 50,
    EUR: 50
  };
  const fixed = fixedByCurrency[currency] ?? 0;
  const budgetAmount = Number(budget.baseBudget ?? budget.amount ?? user?.monthly_budget_amount ?? 0);
  const budgetThreshold = budgetAmount > 0 ? budgetAmount * 0.05 : 0;
  return Math.max(fixed, budgetThreshold);
}

function reportNotableExpenses(expenses = [], paidPlannedPayments = [], threshold = 0, limit = 5, language = "ru") {
  const plannedExpenseIds = new Set(
    paidPlannedPayments
      .map((payment) => payment.expense_id ?? payment.expenseId)
      .filter((id) => id != null)
      .map(String)
  );
  const notable = expenses
    .filter((expense) => {
      if (expense.budget_impact === "large_oneoff") return true;
      if (plannedExpenseIds.has(String(expense.id))) return false;
      return Number(threshold ?? 0) > 0 && Number(expense.amount_base ?? 0) >= Number(threshold);
    })
    .sort((left, right) => Number(right.amount_base ?? 0) - Number(left.amount_base ?? 0));
  const total = roundMoney(notable.reduce((sum, expense) => sum + Number(expense.amount_base ?? 0), 0));
  const items = notable.slice(0, limit).map((expense) => ({
    date: expense.local_date,
    name: String(expense.description ?? "").trim() || categoryLabel(expense.category_slug, language),
    amount: Number(expense.amount_base ?? 0)
  }));
  items.totalAmount = total;
  items.totalCount = notable.length;
  return { items, total, count: notable.length };
}

async function currentMonthBudget(pool, user, now, timeZone = userTimezone(user)) {
  const regularAmount = roundMoney(Number(user.monthly_budget_amount ?? 0));
  const period = monthKey(now, timeZone);
  const result = await pool.query(
    `SELECT COALESCE(budget_amount_base, 0)::float AS budget_amount_base,
            is_partial_month,
            created_at,
            updated_at
     FROM monthly_budget_overrides
     WHERE user_id = $1 AND month_key = $2`,
    [user.id, period]
  );
  const override = result.rows[0];
  const baseBudget = override ? roundMoney(Number(override.budget_amount_base ?? 0)) : regularAmount;
  const topupsTotal = await budgetTopupsTotalForMonth(pool, user.id, period);
  const amount = roundMoney(baseBudget + topupsTotal);
  const topups = await listBudgetTopupsForMonth(pool, user, period);
  const isPartialMonth = Boolean(override?.is_partial_month);
  const effectiveDate = override?.updated_at ?? override?.created_at ?? null;
  const partialPeriodDays = isPartialMonth
    ? partialMonthPeriodDays(effectiveDate ?? now, now, normalizeTimeZone(user.timezone))
    : null;
  return {
    monthKey: period,
    amount,
    baseBudget,
    topupsTotal,
    regularMonthlyBudget: regularAmount,
    isPartialMonth,
    hasOverride: Boolean(override),
    effectiveDate,
    partialPeriodDays,
    topups,
    display: {
      currency: effectiveDisplayCurrency(user),
      amount: displayFromBase(amount, user),
      baseBudget: displayFromBase(baseBudget, user),
      topupsTotal: displayFromBase(topupsTotal, user)
    }
  };
}

async function budgetTopupsTotalForMonth(pool, userId, period) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(amount_base), 0)::float AS total
     FROM budget_topups
     WHERE user_id = $1
       AND month_key = $2
       AND deleted_at IS NULL`,
    [userId, period]
  );
  return roundMoney(Number(result.rows[0]?.total ?? 0));
}

async function listBudgetTopupsForMonth(pool, user, period) {
  const result = await pool.query(
    `SELECT *
     FROM budget_topups
     WHERE user_id = $1
       AND month_key = $2
       AND deleted_at IS NULL
     ORDER BY occurred_at DESC, id DESC
     LIMIT 10`,
    [user.id, period]
  );
  return result.rows.map((row) => withDisplay(row, user));
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

async function listPlannedExpensesForTelegramUserAt(pool, telegramUserId, now, paidMonths = null) {
  const userResult = await pool.query("SELECT timezone FROM users WHERE telegram_user_id = $1", [telegramUserId]);
  const timeZone = userTimezone(userResult.rows[0] ?? {});
  const months = Array.isArray(paidMonths) && paidMonths.length ? paidMonths : [monthKey(now, timeZone)];
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
       JOIN expenses e ON e.id = pep.expense_id
                       AND e.user_id = pe.user_id
      WHERE pep.paid_month = ANY($2::text[])
        GROUP BY pep.planned_expense_id
     ) paid ON paid.planned_expense_id = planned_expenses.id
     WHERE users.telegram_user_id = $1 AND planned_expenses.active = true
     ORDER BY planned_expenses.id DESC`,
    [telegramUserId, months]
  );
  return result.rows;
}

async function readOwnedArchivedPlannedExpense(queryable, telegramUserId, archivedId, lock) {
  const result = await queryable.query(
    `SELECT planned_expenses.*,
            users.base_currency,
            users.display_currency,
            users.display_currency_follows_base,
            users.usd_thb_rate,
            users.timezone
     FROM planned_expenses
     JOIN users ON users.id = planned_expenses.user_id
     WHERE planned_expenses.id = $1
       AND users.telegram_user_id = $2
       AND planned_expenses.active = false
     ${lock ? "FOR UPDATE" : ""}`,
    [archivedId, telegramUserId]
  );
  return result.rows[0] ?? null;
}

function normalizeDraftItem(item) {
  const amount = Number(item.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Expense amount must be positive");
  }
  const unresolvedCurrency = item.currency == null && item.review_reason === "currency_ambiguous";
  const candidates = unresolvedCurrency
    ? [...new Set((Array.isArray(item.currency_candidates) ? item.currency_candidates : [])
      .map((code) => String(code).toUpperCase())
      .filter(isSupportedCurrency))]
    : [];
  return {
    amount,
    currency: unresolvedCurrency ? null : (item.currency || "THB"),
    ...(unresolvedCurrency ? {
      currency_candidates: candidates,
      review_reason: "currency_ambiguous"
    } : {}),
    description: String(item.description || "расход").trim(),
    merchant: typeof item.merchant === "string" && item.merchant.trim() ? item.merchant.trim() : null,
    category_slug: item.category_slug || "other",
    category_source: item.category_source === "user" || item.category_source === "parser" ? item.category_source : null,
    tags: Array.isArray(item.tags) ? item.tags.map(String).filter(Boolean) : [],
    spent_at: item.spent_at || new Date().toISOString(),
    budget_impact: ["regular", "planned", "large_oneoff"].includes(item.budget_impact) ? item.budget_impact : "regular",
    confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : 1,
    needs_review: unresolvedCurrency || Boolean(item.needs_review)
  };
}

function evidenceCandidateFromDraft(draft) {
  const item = (Array.isArray(draft.items) ? draft.items : JSON.parse(draft.items))[0];
  if (!item) return null;
  return {
    amount: item.amount,
    currency: item.currency,
    spentOn: String(item.spent_at ?? "").slice(0, 10),
    spentAt: String(item.spent_at ?? "").slice(11, 16),
    merchant: item.merchant
  };
}

function normalizeEvidenceCandidateLink(row) {
  if (!row) return null;
  return { importId: row.import_id, candidateId: row.candidate_id, draftId: row.draft_id, status: row.candidate_status };
}

function evidenceDuplicateError(reasonCode) {
  const error = codedError("Evidence likely duplicates an existing expense", "evidence_likely_duplicate");
  error.reasonCode = reasonCode;
  return error;
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
    due_date: item.due_date || null
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
  const normalizedCurrency = normalizeCurrency(currency, "THB");
  const baseCurrency = normalizeCurrency(user?.base_currency, "THB");
  if (normalizedCurrency === baseCurrency) {
    const value = roundMoney(amount);
    return {
      amountBase: value,
      convertedAmounts: { [baseCurrency]: value },
      source: "identity"
    };
  }
  const rates = await exchangeRates.ratesFor(date);
  const amounts = convertedAmounts(amount, normalizedCurrency, baseCurrency, rates);
  return {
    amountBase: amounts[baseCurrency],
    convertedAmounts: amounts,
    source: rates.source ?? "manual-fallback"
  };
}

function amountBase(amount, currency, rates = {}) {
  const numeric = Number(amount);
  if (currency !== "THB") return roundMoney(numeric * requiredCurrencyThbRate(currency, rates));
  return roundMoney(numeric);
}

function convertedAmounts(amount, currency, baseCurrency = "THB", rates = {}) {
  const base = amountBase(amount, currency, rates);
  const converted = {};
  for (const code of SUPPORTED_CURRENCY_CODES) {
    if (code !== "THB" && !hasCurrencyThbRate(code, rates)) continue;
    converted[code] = code === "THB"
      ? roundMoney(base)
      : roundMoney(currency === code ? Number(amount) : base / requiredCurrencyThbRate(code, rates));
  }
  if (converted[baseCurrency] == null) {
    throw codedError("Exchange rate is unavailable", "exchange_rate_unavailable");
  }
  return converted;
}

function currencyThbRate(currency, rates = {}) {
  return Number(rates[currency]?.THB ?? (isLegacyManualCurrency(currency) ? fallbackThbRate(currency) : NaN));
}

function hasCurrencyThbRate(currency, rates = {}) {
  const rate = currencyThbRate(currency, rates);
  return Number.isFinite(rate) && rate > 0;
}

function requiredCurrencyThbRate(currency, rates = {}) {
  const rate = currencyThbRate(currency, rates);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw codedError("Exchange rate is unavailable", "exchange_rate_unavailable");
  }
  return rate;
}

function isLegacyManualCurrency(currency) {
  return ["THB", "USD", "RUB", "IDR", "EUR", "BYN", "GEL"].includes(currency);
}

export function effectiveDisplayCurrency(user = {}) {
  const baseCurrency = normalizeCurrency(user.base_currency, "THB");
  return user.display_currency_follows_base === true
    ? baseCurrency
    : normalizeCurrency(user.display_currency, "USD");
}

function withDisplay(row, user) {
  return {
    ...row,
    display: {
      currency: effectiveDisplayCurrency(user),
      amount: displayAmount(row, user)
    }
  };
}

function withDisplayTotal(row, user) {
  return {
    ...row,
    display: {
      currency: effectiveDisplayCurrency(user),
      amount: roundMoney(Number(row.display_total ?? displayFromBase(row.total, user)))
    }
  };
}

function withDisplayPlanned(row, user) {
  return {
    ...row,
    display: {
      currency: effectiveDisplayCurrency(user),
      amount: displayFromBase(row.amount_base, user)
    }
  };
}

function displayAmount(row, user) {
  const converted = typeof row.converted_amounts === "string"
    ? JSON.parse(row.converted_amounts)
    : row.converted_amounts;
  const currency = effectiveDisplayCurrency(user);
  if (converted && converted[currency] != null) return roundMoney(Number(converted[currency]));
  return displayFromBase(row.amount_base, user);
}

function displayFromBase(amountBaseValue, user) {
  const currency = effectiveDisplayCurrency(user);
  const baseCurrency = normalizeCurrency(user.base_currency, "THB");
  const numeric = Number(amountBaseValue);
  if (currency === baseCurrency) return roundMoney(numeric);
  const thbAmount = baseCurrency === "THB" ? numeric : numeric * currencyThbRate(baseCurrency);
  if (currency === "THB") return roundMoney(thbAmount);
  return roundMoney(thbAmount / displayThbRate(user));
}

function displayThbRate(user) {
  const currency = effectiveDisplayCurrency(user);
  if (currency === "THB") return 1;
  return currency === "USD" ? Number(user.usd_thb_rate ?? fallbackThbRate("USD")) : currencyThbRate(currency);
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function normalizeMoneyForCurrency(value, currency) {
  return roundForDisplayCurrency(value, currency);
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
      code: "reserve_conflicts_with_budget_change",
      details: {
        nextBudgetAmount: Number(budgetAmount),
        plannedAmount: Number(plannedAmount),
        reserveAmount: Number(reserve.reserve_amount),
        minimumBudgetAmount: Number(plannedAmount) + Number(reserve.reserve_amount)
      }
    });
  }
}

async function updateOpenReserveBudget(pool, userId, budgetAmount) {
  if (typeof pool.query !== "function") return;
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
  return assertPlannedMutationCapacityWithQueryable(pool, user, changedPlan, changedPlanId);
}

async function assertPlannedMutationCapacityWithQueryable(queryable, user, changedPlan, changedPlanId) {
  const userId = user.user_id ?? user.id;
  const reserveResult = await queryable.query(
    `SELECT * FROM monthly_reserve_instances
     WHERE user_id = $1 AND status = 'active'
     ORDER BY period DESC
     LIMIT 1`,
    [userId]
  );
  const reserve = reserveResult.rows[0];
  if (!reserve) return;
  const plansResult = await queryable.query(
    `SELECT * FROM planned_expenses
     WHERE user_id = $1 AND active = true`,
    [userId]
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
    throw codedError("reserve_conflicts_with_planned_change", "reserve_conflicts_with_planned_change");
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
            COUNT(expenses.id)::int AS paid_count
     FROM planned_expenses
     LEFT JOIN planned_expense_payments
       ON planned_expense_payments.planned_expense_id = planned_expenses.id
       AND planned_expense_payments.occurrence_date >= $2::date
       AND planned_expense_payments.occurrence_date < $3::date
     LEFT JOIN expenses
       ON expenses.id = planned_expense_payments.expense_id
      AND expenses.user_id = planned_expenses.user_id
     WHERE planned_expenses.user_id = $1
     GROUP BY planned_expenses.id`,
    [
      userId,
      `${period}-01`,
      `${nextPeriod}-01`
    ]
  );
  return roundMoney(plansResult.rows.reduce((sum, item) => {
    const scheduledCount = plannedOccurrenceCountForPeriod(item, period);
    const validPaidCount = Number(item.paid_count ?? 0);
    const includedCount = item.active === false ? validPaidCount : scheduledCount;
    return sum + Number(item.amount_base) * includedCount;
  }, 0));
}

function plannedOccurrenceCountForPeriod(item, period) {
  logInvalidOneOffDueDate(item);
  return plannedOccurrenceDateKeysForPeriod(item, period).length;
}

function calculatePlannedThisWeek(plannedExpenses, now, timeZone = "Asia/Bangkok") {
  const bounds = localFullWeekBounds(now, timeZone);
  return plannedExpenses.reduce((sum, item) => {
    const dueDates = unpaidPlannedDueDatesThisMonth(item, now, timeZone)
      .filter((date) => date >= bounds.start && date < bounds.end);
    return sum + Number(item.amount_base) * dueDates.length;
  }, 0);
}

function reportUnpaidPlannedPayments(plannedExpenses, user, now, timeZone, period, lookbackDays = 0) {
  const periodStart = period.localStartDate ?? localDayKey(period.periodStartUtc, timeZone);
  const periodEnd = period.localEndDate ?? localDayKey(new Date(period.periodEndUtc.getTime() - 1), timeZone);
  const windowStart = lookbackDays > 0 && period.periodStartUtc
    ? localDayKey(new Date(period.periodStartUtc.getTime() - lookbackDays * 24 * 60 * 60_000), timeZone)
    : periodStart;
  const monthDates = reportPeriodMonthReferenceDates({ localStartDate: windowStart, localEndDate: periodEnd }, timeZone);
  return plannedExpenses.flatMap((planned) => {
    const dueDateKeys = monthDates.flatMap((monthDate) => unpaidPlannedDueDatesThisMonth(planned, monthDate, timeZone))
      .map((date) => localDayKey(date, timeZone))
      .filter((dateKey, index, all) => all.indexOf(dateKey) === index);
    return dueDateKeys
      .filter((dateKey) => dateKey >= windowStart && dateKey <= periodEnd)
      .map((dateKey) => ({
        name: planned.description,
        amount: Number(planned.amount_base ?? 0),
        paid: false,
        dueDate: dateKey,
        overdue: lookbackDays > 0 && dateKey < periodStart,
        display: {
          currency: effectiveDisplayCurrency(user),
          amount: displayFromBase(planned.amount_base, user)
        }
      }));
  });
}

function reportPeriodMonthKeys(period, timeZone) {
  return reportPeriodMonthReferenceDates(period, timeZone).map((date) => monthKey(date, timeZone));
}

function reportPeriodMonthReferenceDates(period, timeZone) {
  const startKey = period.localStartDate ?? localDayKey(period.periodStartUtc, timeZone);
  const endKey = period.localEndDate ?? localDayKey(new Date(period.periodEndUtc.getTime() - 1), timeZone);
  const [startYear, startMonth] = startKey.slice(0, 7).split("-").map(Number);
  const [endYear, endMonth] = endKey.slice(0, 7).split("-").map(Number);
  const dates = [];
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    dates.push(plannedLocalDateForMonthDay(new Date(Date.UTC(year, month - 1, 15, 12)), 15, timeZone));
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return dates;
}

function localFullWeekBounds(now, timeZone = "Asia/Bangkok") {
  const current = localPeriodBounds(now, "week", timeZone);
  return {
    start: current.start,
    end: new Date(current.start.getTime() + 7 * 24 * 60 * 60_000)
  };
}

function plannedDueDatesThisMonth(item, now, timeZone = userTimezone(item)) {
  logInvalidOneOffDueDate(item);
  return plannedOccurrenceDateKeysForPeriod(item, monthKey(now, timeZone))
    .map((key) => plannedLocalDate(key, timeZone))
    .filter(Boolean);
}

function unpaidPlannedDueDatesThisMonth(item, now, timeZone = userTimezone(item)) {
  const dueDates = plannedDueDatesThisMonth(item, now, timeZone);
  const paidDates = new Set((Array.isArray(item.paid_occurrence_dates) ? item.paid_occurrence_dates : [])
    .map(normalizeOccurrenceKey)
    .filter(Boolean));
  if (paidDates.size) return dueDates.filter((date) => !paidDates.has(localDayKey(date, timeZone)));
  const legacyPaid = item.paid_month === monthKey(now, timeZone) ? 1 : 0;
  const paidCount = Math.min(Number(item.paid_count ?? legacyPaid), dueDates.length);
  return dueDates.slice(paidCount);
}

function logInvalidOneOffDueDate(item) {
  if ((item.recurrence === "one_off" || item.recurrence === "one_time")
      && item.due_date
      && !normalizePlannedDateKey(item.due_date)) {
    logInvalidPlannedDueDate(item);
  }
}

function plannedLocalDate(value, timeZone = "Asia/Bangkok") {
  const parts = plannedDateParts(value);
  if (!parts) return null;
  return localPeriodBounds(new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12)), "today", timeZone).start;
}

function plannedExpenseSpentAt(occurrenceDate, paidAt = new Date(), timeZone = "Asia/Bangkok") {
  const occurrenceParts = plannedDateParts(occurrenceDate);
  if (!occurrenceParts) {
    throw Object.assign(new Error("Invalid occurrence date"), { code: "invalid_occurrence" });
  }
  const occurrenceKey = plannedDateKey(occurrenceParts);
  if (occurrenceKey === localDayKey(paidAt, timeZone)) return paidAt;
  const start = localPeriodBounds(
    new Date(Date.UTC(occurrenceParts.year, occurrenceParts.month - 1, occurrenceParts.day, 12)),
    "today",
    timeZone
  ).start;
  return new Date(start.getTime() + 12 * 60 * 60_000);
}

function plannedLocalDateForMonthDay(now, day, timeZone = "Asia/Bangkok") {
  const [year, month] = monthKey(now, timeZone).split("-").map(Number);
  return localPeriodBounds(new Date(Date.UTC(year, month - 1, day, 12)), "today", timeZone).start;
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
  const paid = new Set(paidOccurrenceDates.map(normalizeOccurrenceKey).filter(Boolean));
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
  const paidDates = new Set(paidRows.map((row) => normalizeOccurrenceKey(row.occurrence_date)).filter(Boolean));
  if (paidDates.has(normalized)) return { error: "Planned expense is already paid for this month", code: "already_paid" };
  return { value: normalized };
}

function normalizeOccurrenceKey(value) {
  const parts = plannedDateParts(value);
  if (!parts) return null;
  return plannedDateKey(parts);
}

function plannedDateParts(value) {
  if (value == null || value === "") return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return {
      year: value.getUTCFullYear(),
      month: value.getUTCMonth() + 1,
      day: value.getUTCDate()
    };
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;

  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

function plannedDateKey(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function plannedPaymentKey(planned, occurrenceDate) {
  const occurrenceKey = normalizeOccurrenceKey(occurrenceDate);
  if (!occurrenceKey) {
    throw Object.assign(new Error("Invalid occurrence date"), { code: "invalid_occurrence" });
  }
  if (planned.recurrence === "weekly" || planned.recurrence === "twice_monthly") {
    return `${occurrenceKey.slice(0, 7)}:${occurrenceKey}`;
  }
  return occurrenceKey.slice(0, 7);
}

function assertAccountDeletionSource(source) {
  if (!ACCOUNT_DELETION_SOURCES.has(source)) {
    throw codedError("Invalid account deletion source", "invalid_account_deletion_source");
  }
}

function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

function normalizeNow(now) {
  const value = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(value.getTime())) return new Date();
  return value;
}

function sameTelegramEditorTarget(session, target) {
  return Boolean(target)
    && session.target_type === target.targetType
    && Number(session.target_id) === Number(target.targetId)
    && (target.itemIndex === undefined || Number(session.item_index ?? -1) === Number(target.itemIndex ?? -1))
    && (target.sessionId == null || Number(session.id) === Number(target.sessionId));
}

function mapAccountDeletionRequest(row) {
  if (!row) return null;
  return {
    status: row.status,
    stage: row.stage,
    source: row.source,
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at)
  };
}

function evidenceSessionResult(row, state) {
  return {
    state,
    id: row.id,
    status: row.status,
    expiresAt: row.expires_at
  };
}

async function expireAccountDeletionRequests(pool, userId, now) {
  await pool.query(
    `UPDATE account_deletion_requests
     SET status = 'expired',
         updated_at = $2
     WHERE user_id = $1
       AND status = 'pending'
       AND expires_at <= $2`,
    [userId, now]
  );
}

function logInvalidPlannedDueDate(item) {
  if (item[INVALID_PLANNED_DUE_DATE_LOGGED]) return;
  Object.defineProperty(item, INVALID_PLANNED_DUE_DATE_LOGGED, {
    value: true,
    enumerable: false
  });
  console.warn("Invalid planned expense due_date", {
    plannedExpenseId: item.id,
    userId: item.user_id,
    recurrence: item.recurrence,
    dueDateType: item.due_date instanceof Date ? "Date" : typeof item.due_date,
    dueDateValue: safeDueDateLogValue(item.due_date)
  });
}

function safeDueDateLogValue(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (value == null) return value;
  return String(value);
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
    [userId, bounds.start, bounds.end, effectiveDisplayCurrency(user), displayThbRate(user)]
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
