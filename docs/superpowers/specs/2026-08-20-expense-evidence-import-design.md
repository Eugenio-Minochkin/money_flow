# Expense evidence image import — design

## Status

Approved product and architecture design for the first implementation PR of
GitHub issue #177. This document closes the first-PR scope; later phases must
not be pulled into the implementation without separate approval.

## Purpose

Let a user send one image that proves one or more expenses and safely turn the
recognized transactions into ordinary Money Flow drafts. The first release
supports bank transaction history, receipts, completed order confirmations,
and payment confirmations through one shared pipeline. Before any financial
mutation, the user sees a preview. Only currently safe, non-duplicate drafts
may be saved in a batch, and every saved expense goes through
`saveDraftAsExpense()`.

The feature is an expense-evidence flow, not generic OCR. It does not preserve
or expose a transcription of the image, create a parallel bank ledger, or
silently save uncertain financial facts.

## First-PR scope

The first PR includes:

- one Telegram `photo` or one JPEG/PNG image sent as a document;
- optional image caption as user context;
- direct image routing without a required `/catchup` command;
- evidence-type classification before draft creation;
- bank transaction history, receipt, completed order confirmation, payment
  confirmation, and unsupported-image results;
- structured extraction, normalization, multi-source deduplication, preview,
  safe batch save, and sequential Telegram review;
- RU/EN Telegram copy;
- durable import/candidate state, callback replay safety, and PostgreSQL smoke
  coverage;
- privacy-safe image handling, logging, analytics, and admin alerts.

The first PR explicitly excludes:

- multiple images in one import or Telegram media-group aggregation;
- a follow-up text or voice message attached to an existing import;
- Mini App-specific evidence review UI;
- proactive catch-up nudges;
- HEIC, PDF, animated images, open-banking connections, credentials, income
  accounting, or bank-specific OCR training;
- item-level accounting for receipt or order lines;
- pixel/perceptual image hashing or a new image-decoding dependency;
- automatic deletion or modification of existing expenses.

## Domain invariants

- An extracted candidate is not a financial fact. Only
  `saveDraftAsExpense()` creates an expense.
- One candidate that may become an expense maps to one ordinary Money Flow
  draft. A batch never bypasses the per-draft canonical save path.
- Receipt, order, and payment-confirmation evidence creates at most one expense
  candidate based on the final paid amount. Line items may inform description
  and category transiently but never become separate expenses.
- An order is not an expense unless the image provides sufficient evidence
  that it is completed or paid. Cart contents, unpaid orders, subtotal,
  discounts, delivery lines already included in the final total, tax lines,
  change, and tips already included in the final total are not separate
  expenses.
- Balance, available balance, period totals, repeated headers or footers,
  cashback/rewards, transfers, incoming credits, refunds, and account/card
  identifiers are not ordinary expense candidates.
- Missing or uncertain amount, currency, or date blocks safe batch save.
- A missing year may be inferred only as the nearest non-future local date in
  the user's timezone when that date is no more than 45 days old. Otherwise the
  date requires review.
- Currency may come from the transaction row or an unambiguous account/evidence
  currency visible in the image. The user's base currency is not a silent
  substitute for an absent or ambiguous image currency.
- A closed source month is never bypassed by image import, batch save, review,
  retry, or explicit duplicate override.
- An explicit `Add` action on a possible duplicate is a user override of that
  possible-match warning. It does not override ownership, validation, exact
  replay, already-saved state, or closed-month rules.
- Candidate correlation fingerprints are not financial duplicate verdicts.

## Architecture

### Telegram routing

The existing Telegram message router recognizes:

- `message.photo` by choosing the largest supported Telegram photo rendition;
- `message.document` only when its declared MIME type and downloaded magic
  bytes identify an allowed JPEG or PNG image.

An image message enters the evidence flow before the ordinary text expense
parser. Caption is context for the evidence analyzer; it is not parsed as an
independent expense first. Non-image documents continue through the existing
unsupported-input behavior.

The router creates or replays a durable import claim before downloading or
analyzing the image. The expensive work runs outside a database transaction.

### `expenseEvidenceAnalyzer`

`expenseEvidenceAnalyzer.analyze()` receives:

- sanitized request-scoped image bytes and MIME type;
- optional caption;
- current timestamp, user timezone, and base currency;
- an optional performance callback that accepts only allowlisted safe metrics.

It returns a strict structured result:

- `evidence_type`: `bank_transactions`, `receipt`, `order_confirmation`,
  `payment_confirmation`, or `unsupported`;
- evidence-level confidence and safe unsupported reason;
- zero or more candidates with merchant/description, amount, currency, visible
  local date parts, optional time, debit/credit/transfer/unknown
  classification, suggested category, extraction confidence, and uncertainty
  flags;
- transient evidence needed to distinguish final paid total from subtotal,
  balance, rewards, transfers, credits, and repeated page furniture.

The OpenAI adapter uses the Responses API with image input, strict JSON Schema,
and `store: false`. `store: false` is a mandatory stateless-request setting; it
must not be described as zero retention or as a guarantee that no platform
retention mechanism can ever apply. The request does not create an OpenAI File
object or pass a Telegram URL.

The analyzer output is untrusted. A separate server normalizer validates every
enum, numeric field, currency, calendar value, category, and confidence flag.
It applies the 45-day year rule and produces ordinary draft items. It never
silently repairs a malformed model result.

Normalized draft items keep `category_source: "parser"`. A suggested `other`
category, low-confidence category, or any material extraction uncertainty sets
`needs_review` and cannot enter safe batch save. Draft `source_text` is a
server-built normalized evidence summary; raw OCR, receipt line text, account
data, and the complete caption are not copied into it.

### `expenseEvidenceImportService`

The import service owns the orchestration:

1. Claim or replay the owned Telegram import identity.
2. Validate Telegram metadata and download no more than the configured limit.
3. Validate and sanitize the JPEG/PNG container in memory.
4. Calculate privacy-safe keyed correlation fingerprints.
5. Call the analyzer outside a database transaction.
6. Normalize candidates and build the complete owned dedupe comparison set.
7. In one transaction, persist the completed import, candidate classifications,
   and one ordinary draft per candidate that can be saved or reviewed.
8. Render the Telegram preview.
9. Re-read and reclassify candidates immediately before batch save or a review
   mutation.
10. Call `saveDraftAsExpense()` separately for every candidate being saved.

An unsupported image completes without drafts. A download, sanitizer, analyzer,
schema, or persistence failure produces no partial candidates or drafts.

## Persisted model

### `expense_evidence_imports`

The durable import row contains only operational and safe correlation data:

- owner `user_id`;
- `chat_id` and `message_id` for owned Telegram replay;
- HMAC values for raw bytes, Telegram `file_unique_id`, and normalized candidate
  set when available;
- evidence type, state, safe result/error code, candidate counts;
- claim version, lease expiry, created/completed/cancelled timestamps;
- result Telegram message reference needed for idempotent editing.

States are `processing`, `ready`, `completed`, `cancelled`, and `failed`.
`user_id + chat_id + message_id` is unique. Fingerprints are never returned to a
client, included in analytics, admin alerts, or logs, or used across users.

### `expense_evidence_candidates`

Each candidate row contains:

- import ID and stable source row index;
- nullable ordinary draft ID;
- classification: `new`, `likely_duplicate`, `possible_duplicate`,
  `non_expense`, or `review`;
- safe reason and extraction confidence;
- nullable matched owned expense, draft, or evidence-candidate reference;
- resolution state and timestamps.

Amount, currency, merchant/description, category, and `spent_at` live in the
ordinary draft item and are not duplicated in the candidate table. Candidates
that are filtered as non-expenses and do not need a draft retain no raw OCR,
merchant, balance, account/card number, amount, or other financial text.

The schema is additive. Deleting a user cascades through imports/candidates;
deleting or cancelling an unresolved draft cannot delete an already saved
expense.

## Image privacy and container safety

- The first PR accepts only JPEG and PNG up to 10 MB. Declared MIME type, magic
  bytes, parsed container type, and downloaded length must agree.
- Download is bounded while streaming; `Content-Length` is advisory and never
  the only size check.
- Image bytes exist only in request-scoped memory. They are never written to
  disk, DB, cache, logs, analytics, traces, or alerts. Buffer references are
  released in `finally`; the design does not promise immediate physical RAM
  erasure because runtime garbage collection controls that timing.
- The sanitizer is fail-closed. It removes only explicitly recognized JPEG
  metadata/comment segments and PNG ancillary metadata chunks. All offsets,
  lengths, ordering, terminators, and PNG CRCs are bounds-checked. A malformed,
  truncated, unsupported, or ambiguously structured container is rejected;
  the sanitizer never attempts to repair it.
- Sanitized bytes, not original bytes, are sent as an in-memory image input.
- The complete OpenAI request body, image data URL, model response, raw OCR,
  prompts containing user evidence, fingerprints, Telegram file identifiers,
  merchant, amount, currency, transaction dates, balances, and bank identifiers
  are forbidden in application logs, analytics, performance traces, and admin
  alerts.
- Allowed observability is limited to evidence type, candidate counts, model,
  elapsed durations, byte-size bucket, and stable safe result/error codes.

The feature has a production kill switch. When enabled in production, a
dedicated HMAC secret is required. An optional evidence model setting may fall
back to the existing OpenAI model setting; no model identifier is hardcoded in
business logic.

## Fingerprints and replay

All fingerprints are HMACs with the dedicated evidence secret and user-scoped
input. Plain SHA digests are not persisted.

- Raw-byte HMAC is an exact replay fast path.
- HMAC of Telegram `file_unique_id` is a Telegram-level same-file signal.
- Candidate-set HMAC correlates semantically equivalent evidence after Telegram
  compression or photo/document conversion.

Before candidate-set HMAC, candidates are canonicalized and stably sorted by
classification-relevant fields such as normalized amount, currency, local
date/time, normalized merchant tokens, and deterministic source index fallback.
Analyzer return order alone cannot change the HMAC.

Raw-byte or same-file replay may return the user's prior owned `ready` or
`completed` import result. A failed or cancelled import is not a successful
replay target. Candidate-set equality alone never replays, drops, or confirms a
financial candidate. It is a correlation signal for the multi-signal dedupe
engine. If financial evidence remains ambiguous, the result is at most
`possible_duplicate`.

## Financial deduplication

The comparison set is user-scoped and includes:

- confirmed expenses;
- every unresolved `pending` and `inbox` draft, including text, voice, Shortcut,
  and Mini App origins;
- earlier candidates in the current import;
- candidates in the user's previous unfinished evidence imports.

The engine compares exact amount and currency, local date, optional time within
a documented window, normalized merchant/description similarity, evidence
correlation, and category/source text only as secondary signals. It is a pure,
deterministic classifier with explicit thresholds and fixture coverage; it does
not call an LLM or embeddings service.

Classification rules:

- `likely_duplicate` requires multiple strong, independent financial signals
  and is excluded from safe save;
- `possible_duplicate` is shown in review;
- `new` has no reasonable match;
- `non_expense` includes transfer, credit, refund, balance, reward, header,
  footer, subtotal, and other filtered evidence;
- amount/currency/date equality alone is never `likely_duplicate`;
- two equal purchases on one day, including two rows in the same screenshot,
  remain distinct unless additional strong evidence identifies a duplicate;
- no fingerprint by itself produces `likely_duplicate`.

Dedupe is recalculated immediately before safe batch save. A candidate that is
no longer safely new moves to review without mutation. In sequential review,
an explicit `Add` on a possible duplicate records the override and saves through
the canonical path, subject to a final ownership, validation, already-saved,
exact-replay, and closed-month check.

## Telegram UX

The bot replies to the source image with the existing processing-loader pattern.
The loader is edited into the result whenever delivery permits.

For multiple bank rows:

```text
Нашёл 12 операций

✓ 7 готовы к добавлению
? 2 нужно уточнить
— 2, похоже, уже записаны
— 1 не расход
```

Primary action: `Добавить 7 расходов`.
Secondary actions: `Разобрать 2` and `Отмена`.

For one receipt/order/payment:

```text
Нашёл расход

Супермаркет · 1 840 THB · 18 авг
Продукты
```

Actions: `Добавить расход`, `Исправить`, and `Отмена`.

The exact copy is localized in RU and EN. A zero-count action is omitted.
Unsupported evidence says that no completed purchase or transaction list could
be recognized and does not create a draft.

Batch save rechecks every selected candidate and returns a compact partial-safe
summary. Per-candidate terminal results are `saved`, `already_saved`, `review`,
`duplicate`, `cancelled`, or `failed`.

Sequential review shows one candidate at a time:

- possible duplicate: `Уже учтено`, `Добавить`, `Исправить`;
- unknown category or invalid/uncertain field: reuse the existing Telegram
  category and draft editor rather than introduce another editor;
- after a terminal resolution, automatically render the next unresolved
  candidate;
- stale and repeated callbacks return the stored state and never repeat a save.

Cancelling an import cancels only its still-unresolved drafts. It never deletes
an expense already created from the import.

## Failure and concurrency behavior

- A processing claim has a bounded lease. A concurrent delivery waits for the
  completed result; an expired lease can be reclaimed with a higher claim
  version.
- Failures before candidate persistence store only the safe import error code.
  A retry button reuses or safely reclaims the same import.
- Analyzer work occurs outside DB transactions. Import completion, candidates,
  and drafts are committed atomically after normalization and dedupe.
- A lost Telegram response does not lose the durable result. Replay edits or
  resends the stored summary without re-analysis or additional drafts.
- Batch save is intentionally per-draft and may be partially successful. Every
  outcome is returned; one already-confirmed or newly ambiguous member does not
  roll back independently saved drafts.
- Internal exceptions and upstream response bodies are sanitized before logging
  or alerting. User messages contain a stable localized error, never stack,
  provider body, identifiers, or extracted financial content.
- Missing configuration or a disabled kill switch preserves the current safe
  unsupported-photo behavior.

## Verification contract

### Unit and service tests

- OpenAI adapter sends sanitized in-memory image input, strict JSON Schema, and
  `store: false`; it never uses `/v1/files` or a Telegram URL.
- Analyzer fixtures cover bank history, receipt, order confirmation, payment
  confirmation, unsupported images, malformed output, and low confidence.
- Receipt/order fixtures prove final-total selection and rejection of subtotal,
  discounts, change, unpaid cart, duplicate delivery/tax lines, and individual
  product rows as separate expenses.
- Bank fixtures filter balance, available balance, period total, cashback,
  repeated headers/footers, transfer, incoming credit, and refund.
- Routing covers Telegram photo, JPEG/PNG document, caption, unsupported
  document, disabled analyzer, and replay.
- The bounded downloader rejects oversized and truncated bodies even when
  metadata or `Content-Length` lies.
- JPEG/PNG sanitizer fixtures cover permitted containers, removed metadata,
  bounds and length failures, CRC failures, truncation, unsupported chunks, and
  fail-closed behavior without repair.
- Date/currency tests cover visible year, 45-day inferred year boundary,
  future/old/ambiguous dates, account-level currency, and absent currency.
- Candidate-set HMAC is stable under analyzer-order changes and different under
  relevant canonical changes. Fingerprints never appear in logs/events.
- Dedupe fixtures cover confirmed expenses, unresolved drafts, current-import
  candidates, previous unfinished imports, exact/likely/possible/new outcomes,
  same amount twice in one day, recompressed semantic evidence, and candidate
  fingerprint equality without silent exclusion.
- Batch tests cover immediate dedupe recheck, explicit possible-duplicate
  override, concurrent save, lost response, repeated callback, partial success,
  cancellation, historical `spent_at`, timezone, and closed month.
- Sequential Telegram review covers edit/category reuse, next-item progression,
  stale callback, and RU/EN copy.
- Privacy tests capture application logs, analytics metadata, performance traces,
  and admin-alert payloads and assert that raw bytes, data URLs, file IDs,
  fingerprints, OCR/model output, merchant, amounts, dates, balances, account
  numbers, and secrets are absent.

### PostgreSQL smoke

The disposable integration database covers migration order, durable import
claim/reclaim, atomic candidate/draft persistence, ownership, unresolved-draft
dedupe, previous-import dedupe, safe batch save, concurrent/repeated save,
historical dates, explicit review override, cancellation, and cascading user
deletion. No test points at persistent or production data.

### Manual acceptance

Use synthetic or explicitly redacted images only. Repository fixtures must not
contain real bank screenshots, card/account numbers, personal names, addresses,
or real financial history. A local configured-API check should exercise one
synthetic example for each supported evidence type and record only result counts
and safe screenshots of the Telegram UI. CI remains deterministic and does not
call OpenAI or Telegram.

Run focused tests first, then `npm.cmd test`, `npm.cmd run
test:integration:postgres` where the disposable local database is available,
and `git diff --check`. The draft PR must include DB impact, privacy and rollback
notes, safe example UI evidence, and the required `## User Release Notes` block.

## Database and rollout impact

The PR adds only the two evidence tables and their indexes/constraints. Existing
expense, draft, planned-payment, budget, reserve, and income semantics are not
rewritten. The forward-fix path is a later additive migration. Before production
use, rollback may drop the new tables because they contain only evidence import
workflow state and references; it must not delete expenses created through
ordinary drafts.

Production access, migration execution against persistent data, enablement,
merge, and deploy remain outside this PR and require explicit authorization.

## Later phases

After the first PR is reviewed in real Telegram usage, separate designs may add:

1. multi-image sessions, explicit `Добавить ещё` / `Готово`, and media groups;
2. follow-up text and voice context with a bounded session TTL;
3. a compact Mini App evidence-review surface;
4. a separately governed inactivity/catch-up nudge;
5. pixel/perceptual fingerprinting only if a justified, security-reviewed image
   decoding layer is introduced for another product need.

These phases are not implementation tasks in the first PR.
