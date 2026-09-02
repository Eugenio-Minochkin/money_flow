# Expense-evidence image import implementation plan

> **For Codex:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Let a Telegram user import one JPEG/PNG screenshot of a bank history, receipt, order confirmation, or payment confirmation into safe expense drafts, with privacy-safe OpenAI analysis, multi-signal deduplication, batch save, and sequential review.

**Architecture:** Add a request-scoped image safety boundary and `expenseEvidenceAnalyzer` for strict structured extraction. Persist only import/candidate workflow state and ordinary expense drafts. `expenseEvidenceImportService` owns claims, atomic draft creation, dedupe and completion. Telegram remains the entry point and reuses `saveDraftAsExpense()` and the existing draft editor.

**Tech Stack:** Node.js ESM, PostgreSQL migrations, Telegram Bot API, OpenAI Responses API, node:test, existing repository/draft/smart-save services.

## Boundaries and invariants

- First PR accepts one Telegram `photo` or JPEG/PNG image `document`, plus optional caption. No albums, follow-up sessions, Mini App review, PDFs/HEIC, image persistence, or perceptual hashing.
- Evidence types are `bank_transactions`, `receipt`, `order_confirmation`, `payment_confirmation`, and `unsupported`.
- A receipt/order/payment confirmation creates one candidate for its final paid total. Line items only improve description/category.
- Image bytes are in request-scoped memory only; never disk, database, cache, logs, traces, analytics, or alerts. Release Buffer references in `finally`.
- `store: false` is mandatory for Responses requests, but no code/docs claim zero retention.
- Fingerprints are HMAC correlation signals only. They never independently mark a financial candidate as duplicate.
- Dedupe includes confirmed expenses, pending/inbox drafts, current candidates, and candidates of unfinished earlier imports. A second check happens immediately before batch save.
- `saveDraftAsExpense()` remains the sole canonical save boundary.

## File responsibility map

| Path | Responsibility |
| --- | --- |
| `apps/api/src/config.js`, `.env.example`, `compose.prod.yml` | Feature switch, model, timeout, size and HMAC secret configuration. |
| `apps/api/migrations/018_expense_evidence_imports.sql` | Import/candidate persistence, indexes and FK constraints. |
| `apps/api/src/expenseEvidenceImage.js` | Bounded Telegram download, JPEG/PNG validation and fail-closed metadata stripping. |
| `apps/api/src/expenseEvidenceAnalyzer.js` | Responses API call, strict schema, normalisation and candidate-set HMAC. |
| `apps/api/src/expenseEvidenceDedupe.js` | Candidate comparison and stable `new`/`possible_duplicate`/`likely_duplicate` classification. |
| `apps/api/src/repository.js` | Lease-safe import claims, candidate/draft persistence and dedupe queries. |
| `apps/api/src/expenseEvidenceImportService.js` | Import orchestration, idempotency, canonical draft creation and batch/review transitions. |
| `apps/api/src/telegram.js`, `apps/api/src/telegramKeyboards.js`, `apps/api/src/server.js` | Photo/document routing, Telegram summary/review UX and dependency wiring. |
| `apps/api/test/*.test.js`, `apps/api/integration/postgres-smoke.js` | Unit, privacy, routing, service and PostgreSQL regression coverage. |
| `docs/DOMAIN_RULES.md`, `docs/PRODUCT_CONTEXT.md`, `docs/deployment-runbook.md` | Product/domain/privacy contract and release note guidance. |

## Task 1: Configuration and persistence

**Files:**
- Modify: `apps/api/src/config.js`
- Modify: `.env.example`
- Modify: `compose.prod.yml`
- Create: `apps/api/migrations/018_expense_evidence_imports.sql`
- Modify: `apps/api/test/config.test.js`
- Modify: `apps/api/integration/postgres-smoke.js`

1. Add disabled-by-default `EXPENSE_EVIDENCE_IMPORT_ENABLED`, a bounded `EXPENSE_EVIDENCE_MAX_BYTES` defaulting to `10485760`, `EXPENSE_EVIDENCE_TIMEOUT_MS` defaulting to `30000`, optional model override, and dedicated `EXPENSE_EVIDENCE_HMAC_SECRET`.
2. Require the HMAC secret in production only when the feature is enabled; validate positive bounded integers at config parsing time.
3. Create import rows with `telegram_user_id`, source chat/message identifiers, image byte/file fingerprints, candidate-set fingerprint, state, lease owner/until, safe failure code and timestamps. Do not add columns for bytes, data URLs, OCR, captions, merchants, amounts, dates, cards or balances.
4. Create candidate rows with import FK, stable ordinal, evidence type, ordinary draft FK, status, dedupe classification, and resolution timestamp. Index unresolved imports by user and candidate state; enforce one `(import_id, ordinal)`.
5. Register migration 018 in the smoke migration list and assert the new tables/constraints.

Example migration shape:

```sql
CREATE TABLE expense_evidence_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id text NOT NULL,
  source_chat_id text NOT NULL,
  source_message_id text NOT NULL,
  image_bytes_hmac text NOT NULL,
  telegram_file_hmac text,
  candidate_set_hmac text,
  state text NOT NULL CHECK (state IN ('processing', 'ready', 'failed', 'cancelled', 'completed')),
  lease_owner text,
  lease_until timestamptz,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

Run: `npm.cmd test -- apps/api/test/config.test.js apps/api/integration/postgres-smoke.js`

## Task 2: Fail-closed image safety boundary

**Files:**
- Create: `apps/api/src/expenseEvidenceImage.js`
- Create: `apps/api/test/expenseEvidenceImage.test.js`

1. Implement `downloadAndSanitizeExpenseEvidenceImage({ telegramClient, fileId, declaredMimeType, maxBytes })` returning only `{ bytes, mimeType, sizeBucket }`.
2. Verify the MIME allow-list, magic bytes and actual parsed container agree. Bound streaming reads and reject oversized downloaded bodies even if Content-Length is missing or false.
3. Parse JPEG markers with strict segment lengths. Remove only APP1/EXIF, APP13/IPTC and COM metadata segments; reject truncated, illegal or unsupported marker structure.
4. Parse PNG signature/chunks with strict bounds, CRC and ordering. Remove only known ancillary metadata chunks (`eXIf`, `tEXt`, `zTXt`, `iTXt`, `tIME`); reject malformed CRC, illegal order, incomplete IEND or malformed lengths. Never repair a corrupt container.
5. Ensure thrown errors use safe codes (`unsupported_image`, `image_too_large`, `malformed_image`, `image_download_failed`) and no error embeds URL, file ID or image content.
6. Test JPEG/PNG accepted stripping, bad magic/MIME, oversized streams, truncated JPEG, bad PNG CRC/order, and absence of metadata in the sanitized output.

Run: `npm.cmd test -- apps/api/test/expenseEvidenceImage.test.js`

## Task 3: Structured evidence analyzer

**Files:**
- Create: `apps/api/src/expenseEvidenceAnalyzer.js`
- Create: `apps/api/test/expenseEvidenceAnalyzer.test.js`

1. Implement a factory accepting an injected Responses client, model, timeout and HMAC secret. Submit only sanitized in-memory `data:image/...;base64,...` input with `store: false` and a strict JSON Schema.
2. Require schema output with evidence type, account/evidence currency, candidate entries, amount, date/time, merchant, description, category suggestion, confidence and uncertainty flags. Never accept an unstructured prose fallback.
3. Canonicalise amounts, ISO currency, whitespace/case and merchant tokens. For missing years, infer only the nearest non-future local date within 45 days; otherwise mark review. Require visible or unambiguous currency.
4. Turn unsupported/non-expense evidence into no candidates. Collapse receipt/order/payment evidence to its final paid total before service handling.
5. Generate candidate-set HMAC from a stable sorting of canonical candidate objects. It is a correlation signal only.
6. Make timeout/invalid schema/non-JSON responses safe `analysis_failed` errors and ensure logs/callback context are aggregate-only.
7. Test every evidence type, stable sort, `store: false`, date/currency guards, receipt total collapse, invalid schema, timeout and no source caption/OCR leakage.

Run: `npm.cmd test -- apps/api/test/expenseEvidenceAnalyzer.test.js`

## Task 4: Multi-source deduplication

**Files:**
- Create: `apps/api/src/expenseEvidenceDedupe.js`
- Create: `apps/api/test/expenseEvidenceDedupe.test.js`
- Modify: `apps/api/src/repository.js`

1. Define a pure classifier receiving one normalized candidate plus nearby confirmed expenses, unresolved drafts and import candidates. Score independent amount/currency/date/time/normalized-merchant signals; category and source are secondary.
2. Return `new`, `possible_duplicate` or `likely_duplicate` with a safe reason code. Equal amount/currency/date alone cannot produce `likely_duplicate`.
3. Add repository read methods that query confirmed expenses and all unresolved `pending`/`inbox` drafts for the same user/window, and unfinished import candidates through their draft references.
4. Add the exact-byte and Telegram-file HMAC lookup only as import replay/correlation helpers; candidate-set equality does not silent-drop candidates.
5. Test each source family, same real payments on one day, voice-review then bank screen, current/older import candidates, explicit-add override and candidate-set match with ambiguous finances.

Run: `npm.cmd test -- apps/api/test/expenseEvidenceDedupe.test.js`

## Task 5: Durable import service and canonical drafts

**Files:**
- Create: `apps/api/src/expenseEvidenceImportService.js`
- Create: `apps/api/test/expenseEvidenceImportService.test.js`
- Modify: `apps/api/src/repository.js`
- Modify: `apps/api/src/expenseDraftService.js` only if a small extracted helper is necessary

1. Model import states `processing`, `ready`, `failed`, `cancelled`, `completed` with an expiring owned lease. Reclaim only expired processing work; retry is idempotent.
2. Reuse a ready/completed import only for exact own image bytes/file correlation. Failed and cancelled imports must not block a retry.
3. Download/sanitize/analyse outside a database transaction. In one transaction persist import completion, candidates and their ordinary drafts with `category_source: 'parser'`; normalise the source text to a minimal summary, never raw OCR or full caption.
4. Route low confidence, `other`, inferred/ambiguous date/currency or material uncertainty to `needs_review`; ordinary confident drafts remain eligible for smart save.
5. For `saveReadyCandidates`, claim selected candidates, rerun dedupe inside the transaction boundary just before each save, then call `saveDraftAsExpense()` for each eligible draft. Report per-candidate saved/review/duplicate outcomes; no all-or-nothing promise.
6. For `resolveCandidate`, make `already_accounted` terminal without saving, make `add` an explicit override through canonical save, make `edit` hand control to the existing draft editor, and make cancel resolve only unresolved drafts.
7. Release image Buffer references in `finally`; persist only HMACs and safe workflow metadata.
8. Unit-test lease contention/reclaim, exact replay, pre-completion failure, atomic completion, unresolved-draft dedupe, recheck-before-save, partial save, override, cancel and idempotent callback replay.

Run: `npm.cmd test -- apps/api/test/expenseEvidenceImportService.test.js`

## Task 6: Telegram routing and review UX

**Files:**
- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/src/telegramKeyboards.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/test/telegram.test.js`
- Modify: `apps/api/test/telegramKeyboards.test.js`

1. Inject analyzer/import service into `createTelegramBot` through `server.js`; leave the normal text/voice parser flow untouched.
2. Detect `message.photo` and JPEG/PNG `message.document` when the feature switch is enabled. Send a processing reply to the source message, then edit it to the result; unsupported media gets a safe no-draft response.
3. Replace the legacy `unsupported_photo` branch with import orchestration. Do not send Telegram file URLs to OpenAI.
4. Add compact callback grammar, for example `ei:<importId>:save|review|cancel` and `ei:<importId>:<candidateId>:accounted|add|edit`; validate user ownership before every action.
5. Render the agreed RU/EN single and group summaries, `Добавить N`, `Проверить N`, `Отменить`, then sequential review with `Уже учтено`, `Добавить`, `Исправить`. Reuse existing editor callbacks after `edit`.
6. Keep Telegram alert/log contexts limited to type/counts/latency/model/size bucket/safe code. Add no merchant, amount, date, balances, IDs, caption, fingerprint or model content.
7. Test photo and image document routing, caption forwarding only to analyzer, disabled switch, unsupported result, all buttons, ownership rejection, loader edit, single/group copy, sequential transitions and ordinary text/voice regression.

Run: `npm.cmd test -- apps/api/test/telegram.test.js apps/api/test/telegramKeyboards.test.js`

## Task 7: Privacy/domain documentation and regression audit

**Files:**
- Modify: `docs/DOMAIN_RULES.md`
- Modify: `docs/PRODUCT_CONTEXT.md`
- Modify: `docs/deployment-runbook.md`
- Modify: `apps/api/test/adminAlerts.test.js`
- Modify: `apps/api/test/security.test.js`

1. Document the canonical draft/save boundary, evidence types, conservative auto-save and explicit duplicate override.
2. Document operational configuration: disabled default, `store:false` requirement, request-scoped bytes, supported formats and no claim of zero retention.
3. Add release note text for feature rollout and admin-alert privacy expectations.
4. Test logs/admin alert sanitization against image bytes/data URL, file IDs, HMACs, caption, merchant, amount, date, balances and model output; use synthetic fixtures only.

Run: `npm.cmd test -- apps/api/test/adminAlerts.test.js apps/api/test/security.test.js`

## Task 8: Integration verification and draft PR

**Files:** all changed files above.

1. Extend PostgreSQL smoke coverage with migration 018, import claim/reclaim, atomic candidate/draft persistence, unresolved draft comparison and canonical save.
2. Run focused suites after each task, then `npm.cmd test` from the worktree root.
3. Run `git diff --check`, inspect `git diff origin/master...HEAD`, confirm no real image fixture/secret/data URL is tracked, and run `git status --short`.
4. Update the plan checkboxes/status with actual commands and outcomes; do not mark skipped integration as passed.
5. Commit only issue-177 files and open/update a draft PR into `master`. The PR body must include summary, changed areas, docs checked, tests, DB impact/forward-fix, no production actions, privacy statement, synthetic screenshots only, and `## User Release Notes`.

## Completion checklist

- [ ] Config/migration tests pass.
- [ ] Image sanitizer and analyzer tests pass.
- [ ] Dedupe/service/Telegram tests pass.
- [ ] PostgreSQL smoke and full `npm.cmd test` pass, or an exact blocker is recorded.
- [ ] `git diff --check` is clean and the diff is issue-177-only.
- [ ] Draft PR is opened; it is not merged or deployed.

## Plan self-review

- Scope matches the approved single-image first PR and explicitly excludes albums, follow-up sessions, Mini App work, PDFs/HEIC and perceptual hashing.
- Every persistence stage has an idempotency/lease rule, and every financial save goes through `saveDraftAsExpense()`.
- Dedupe covers confirmed expenses, unresolved drafts and in-progress imports; fingerprints remain correlation signals.
- Privacy requirements name exact allowed formats, fail-closed parsing, safe state fields and testable no-leak boundaries.
