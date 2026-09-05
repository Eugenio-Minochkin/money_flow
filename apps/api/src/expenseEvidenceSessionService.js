const SESSION_TTL_MS = 15 * 60 * 1000;
const RESOLVABLE_STATUSES = new Set(["ready", "likely_duplicate"]);

export function createExpenseEvidenceSessionService({ repository, importService } = {}) {
  return {
    async startOrResume({ userId, chatId }) {
      return repository.startOrResumeExpenseEvidenceSession({ userId, chatId, ttlMs: SESSION_TTL_MS });
    },

    async linkCompletedImport({ userId, chatId, sessionId, imported }) {
      if (imported?.state !== "ready" || imported.importId == null) return { state: "not_ready" };
      return repository.linkExpenseEvidenceImportToSession({ userId, chatId, sessionId, importId: imported.importId });
    },

    async finish({ userId, chatId, sessionId }) {
      const finished = await repository.finishExpenseEvidenceSession({ userId, chatId, sessionId });
      if (finished.state !== "ready") return finished;
      const candidates = await repository.getExpenseEvidenceSessionCandidates({ userId, sessionId });
      return { ...finished, preview: aggregatePreview(candidates) };
    },

    async cancel({ userId, chatId, sessionId }) {
      const candidates = await repository.getExpenseEvidenceSessionCandidates({ userId, sessionId });
      const outcomes = await resolveCandidates({
        userId,
        candidates: candidates.filter((candidate) => RESOLVABLE_STATUSES.has(candidate.status)),
        actions: candidates.filter((candidate) => RESOLVABLE_STATUSES.has(candidate.status)).map((candidate) => ({ candidateId: candidate.candidateId, action: "cancel" })),
        importService
      });
      const cancelled = await repository.cancelExpenseEvidenceSession({ userId, chatId, sessionId });
      return { ...cancelled, outcomes };
    },

    async resolve({ userId, sessionId, actions }) {
      const candidates = await repository.getExpenseEvidenceSessionCandidates({ userId, sessionId });
      return { outcomes: await resolveCandidates({ userId, candidates, actions, importService }) };
    }
  };
}

async function resolveCandidates({ userId, candidates, actions, importService }) {
  const byCandidateId = new Map(
    candidates.filter((candidate) => RESOLVABLE_STATUSES.has(candidate.status)).map((candidate) => [candidate.candidateId, candidate])
  );
  const actionsByImport = new Map();
  for (const { candidateId, action } of actions ?? []) {
    const candidate = byCandidateId.get(candidateId);
    if (!candidate) continue;
    const importedActions = actionsByImport.get(candidate.importId) ?? [];
    importedActions.push({ candidateId, action });
    actionsByImport.set(candidate.importId, importedActions);
  }
  const outcomes = [];
  for (const [importId, importActions] of actionsByImport) {
    const resolved = await importService.resolveImportCandidates({ userId, importId, actions: importActions });
    outcomes.push(...(resolved.outcomes ?? []));
  }
  return outcomes;
}

function aggregatePreview(candidates) {
  return {
    importCount: new Set(candidates.map((candidate) => candidate.importId)).size,
    candidateCount: candidates.length,
    unresolvedCount: candidates.filter((candidate) => RESOLVABLE_STATUSES.has(candidate.status)).length,
    duplicateCount: candidates.filter((candidate) => candidate.dedupeClassification === "likely_duplicate").length
  };
}
