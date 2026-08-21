import crypto from "node:crypto";

export function createExpenseEvidenceImportService({ repository, analyzer, imageDownloader, hmac = hmacBytes } = {}) {
  return {
    async importImage({ user, chatId, messageId, fileId, fileUniqueId, declaredMimeType, caption = "" }) {
      const claim = await repository.claimExpenseEvidenceImport(user.id, chatId, messageId);
      if (claim?.state === "ready" || claim?.state === "completed") return claim;
      if (!claim || claim.state !== "claimed") return { state: "processing" };
      let image;
      try {
        image = await imageDownloader.download({ fileId, declaredMimeType });
        const analysis = await analyzer.analyze({ bytes: image.bytes, mimeType: image.mimeType, caption });
        const candidates = analysis.candidates.map((candidate, ordinal) => ({
          ordinal,
          evidenceType: analysis.evidenceType,
          items: [draftItem(candidate)],
          dedupeClassification: "new",
          dedupeReasonCode: null
        }));
        await repository.completeExpenseEvidenceImport({
          userId: user.id,
          chatId,
          messageId,
          claimVersion: claim.claimVersion,
          imageBytesHmac: hmac(image.bytes),
          telegramFileHmac: fileUniqueId ? hmac(Buffer.from(String(fileUniqueId))) : null,
          candidateSetHmac: analysis.candidateSetHmac,
          candidates
        });
        return { state: "ready", evidenceType: analysis.evidenceType, candidates };
      } catch (error) {
        await repository.releaseExpenseEvidenceImport(user.id, chatId, messageId, claim.claimVersion);
        throw error;
      } finally {
        image = null;
      }
    }
  };
}

function draftItem(candidate) {
  const spentAt = candidate.spentOn ? `${candidate.spentOn}T${candidate.spentAt ?? "12:00"}:00.000Z` : null;
  return {
    amount: candidate.amount,
    currency: candidate.currency,
    description: candidate.description,
    category_slug: candidate.categorySlug,
    category_source: "parser",
    tags: [],
    spent_at: spentAt,
    budget_impact: "regular",
    confidence: candidate.confidence,
    needs_review: Boolean(candidate.needsReview) || !spentAt
  };
}

function hmacBytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
