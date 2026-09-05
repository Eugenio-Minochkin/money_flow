import assert from "node:assert/strict";
import test from "node:test";
import { createExpenseEvidenceSessionService } from "../src/expenseEvidenceSessionService.js";

test("starts or resumes an evidence session with the fixed fifteen-minute TTL", async () => {
  let received;
  const service = createExpenseEvidenceSessionService({
    repository: {
      async startOrResumeExpenseEvidenceSession(value) {
        received = value;
        return { state: "started", id: 41 };
      }
    },
    importService: {}
  });

  assert.deepEqual(await service.startOrResume({ userId: 2, chatId: 8 }), { state: "started", id: 41 });
  assert.deepEqual(received, { userId: 2, chatId: 8, ttlMs: 15 * 60 * 1000 });
});

test("links only a successful Phase 1 import to its active session without changing standalone imports", async () => {
  const links = [];
  const service = createExpenseEvidenceSessionService({
    repository: {
      async linkExpenseEvidenceImportToSession(value) { links.push(value); return { state: "linked", ordinal: 0 }; }
    },
    importService: {}
  });
  const readyImport = { state: "ready", importId: 17, evidenceType: "receipt", candidates: [{ ordinal: 0 }] };

  assert.deepEqual(await service.linkCompletedImport({ userId: 2, chatId: 8, sessionId: 41, imported: readyImport }), { state: "linked", ordinal: 0 });
  assert.deepEqual(await service.linkCompletedImport({ userId: 2, chatId: 8, sessionId: 41, imported: { state: "processing" } }), { state: "not_ready" });
  assert.deepEqual(links, [{ userId: 2, chatId: 8, sessionId: 41, importId: 17 }]);
  assert.deepEqual(readyImport, { state: "ready", importId: 17, evidenceType: "receipt", candidates: [{ ordinal: 0 }] });
});

test("finishes a session with aggregate-only preview counts", async () => {
  const service = createExpenseEvidenceSessionService({
    repository: {
      async finishExpenseEvidenceSession() { return { state: "ready", id: 41 }; },
      async getExpenseEvidenceSessionCandidates() {
        return [
          { importId: 7, candidateId: 8, status: "ready", dedupeClassification: "new", evidenceType: "receipt", draftId: 90 },
          { importId: 7, candidateId: 9, status: "ready", dedupeClassification: "likely_duplicate", evidenceType: "bank_transactions", draftId: 91 },
          { importId: 10, candidateId: 11, status: "saved", dedupeClassification: "new", evidenceType: "receipt", draftId: 92 }
        ];
      }
    },
    importService: {}
  });

  const result = await service.finish({ userId: 2, chatId: 8, sessionId: 41 });

  assert.deepEqual(result, {
    state: "ready",
    id: 41,
    preview: { importCount: 2, candidateCount: 3, unresolvedCount: 2, duplicateCount: 1 }
  });
  assert.doesNotMatch(JSON.stringify(result), /receipt|bank_transactions|draftId|90|91/);
});

test("cancels every unresolved linked candidate through the canonical resolver before cancelling the session", async () => {
  const calls = [];
  const service = createExpenseEvidenceSessionService({
    repository: {
      async getExpenseEvidenceSessionCandidates() {
        return [
          { importId: 7, candidateId: 8, status: "ready" },
          { importId: 7, candidateId: 9, status: "saved" },
          { importId: 10, candidateId: 11, status: "ready" }
        ];
      },
      async cancelExpenseEvidenceSession(value) { calls.push({ cancel: value }); return { state: "cancelled", id: 41 }; }
    },
    importService: {
      async resolveImportCandidates(value) { calls.push(value); return { outcomes: value.actions.map(({ candidateId }) => ({ candidateId, state: "cancelled" })) }; }
    }
  });

  const result = await service.cancel({ userId: 2, chatId: 8, sessionId: 41 });

  assert.deepEqual(result, {
    state: "cancelled",
    id: 41,
    outcomes: [{ candidateId: 8, state: "cancelled" }, { candidateId: 11, state: "cancelled" }]
  });
  assert.deepEqual(calls, [
    { userId: 2, importId: 7, actions: [{ candidateId: 8, action: "cancel" }] },
    { userId: 2, importId: 10, actions: [{ candidateId: 11, action: "cancel" }] },
    { cancel: { userId: 2, chatId: 8, sessionId: 41 } }
  ]);
});

test("resolves only ready candidates that belong to the session in batches by import", async () => {
  const calls = [];
  const service = createExpenseEvidenceSessionService({
    repository: {
      async getExpenseEvidenceSessionCandidates() {
        return [{ importId: 7, candidateId: 8, status: "ready" }, { importId: 7, candidateId: 9, status: "saved" }];
      }
    },
    importService: {
      async resolveImportCandidates(value) { calls.push(value); return { outcomes: value.actions.map(({ candidateId, action }) => ({ candidateId, state: action === "save" ? "saved" : "cancelled" })) }; }
    }
  });

  const result = await service.resolve({ userId: 2, sessionId: 41, actions: [
    { candidateId: 8, action: "save" }, { candidateId: 9, action: "cancel" }, { candidateId: 77, action: "save" }
  ] });

  assert.deepEqual(result, { outcomes: [{ candidateId: 8, state: "saved" }] });
  assert.deepEqual(calls, [{ userId: 2, importId: 7, actions: [{ candidateId: 8, action: "save" }] }]);
});
