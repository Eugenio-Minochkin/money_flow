import { classifyExpenseEvidenceDuplicate } from "./expenseEvidenceDedupe.js";

export function createExpenseEvidenceImportService({ repository, analyzer, imageDownloader, hmac } = {}) {
  if (typeof hmac !== "function") throw new Error("Expense evidence HMAC must be injected");
  return {
    async importImage({ user, chatId, messageId, fileId, fileUniqueId, declaredMimeType, caption = "" }) {
      const claim = await repository.claimExpenseEvidenceImport(user.id, chatId, messageId);
      if (claim?.state === "ready" || claim?.state === "completed") return claim;
      if (!claim || claim.state !== "claimed") return { state: "processing" };
      let image;
      try {
        image = await imageDownloader.download({ fileId, declaredMimeType });
        const analysis = await analyzer.analyze({ bytes: image.bytes, mimeType: image.mimeType, caption });
        const existing = await repository.listExpenseEvidenceDuplicateCandidates(user.id);
        const dedupeCandidates = [...existing];
        const candidates = analysis.candidates.map((candidate, ordinal) => {
          const dedupe = classifyExpenseEvidenceDuplicate(candidate, dedupeCandidates);
          dedupeCandidates.push(candidate);
          return {
            ordinal,
            evidenceType: analysis.evidenceType,
            items: [draftItem(candidate)],
            dedupeClassification: dedupe.classification,
            dedupeReasonCode: dedupe.reasonCode
          };
        });
        const completed = await repository.completeExpenseEvidenceImport({
          userId: user.id,
          chatId,
          messageId,
          claimVersion: claim.claimVersion,
          imageBytesHmac: hmac(image.bytes),
          telegramFileHmac: fileUniqueId ? hmac(Buffer.from(String(fileUniqueId))) : null,
          candidateSetHmac: analysis.candidateSetHmac,
          candidates
        });
        return { state: "ready", importId: completed?.id ?? null, evidenceType: analysis.evidenceType, candidates };
      } catch (error) {
        await repository.releaseExpenseEvidenceImport(user.id, chatId, messageId, claim.claimVersion);
        throw error;
      } finally {
        image = null;
      }
    },

    async resolveImportCandidates({ userId, importId, actions }) {
      const outcomes = [];
      for (const { candidateId, action } of actions ?? []) {
        try {
          outcomes.push({ candidateId, ...await repository.resolveExpenseEvidenceCandidate({ userId, importId, candidateId, action }) });
        } catch {
          outcomes.push({ candidateId, state: "failed", reasonCode: "resolution_failed" });
        }
      }
      return { outcomes };
    },

    async getActiveCandidateForDraft({ userId, draftId }) {
      return repository.getActiveExpenseEvidenceCandidateForDraft(userId, draftId);
    },

    async markCandidateSavedAfterDraftConfirmation({ userId, draftId }) {
      return repository.markExpenseEvidenceCandidateSavedForDraft(userId, draftId);
    }
  };
}
function draftItem(candidate) {
  const spentAt = candidate.spentOn ? `${candidate.spentOn}T${candidate.spentAt ?? "12:00"}:00.000Z` : null;
  return {
    amount: candidate.amount,
    currency: candidate.currency,
    description: candidate.description,
    merchant: candidate.merchant ?? null,
    category_slug: candidate.categorySlug,
    category_source: "parser",
    tags: [],
    spent_at: spentAt,
    budget_impact: "regular",
    confidence: candidate.confidence,
    needs_review: Boolean(candidate.needsReview) || !spentAt
  };
}
