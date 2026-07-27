# Expense Parser Audit And Benchmark

These tools support evidence collection for issue #115. They do not change parser routing, aliases, prompts, or the configured model. No production audit or real API benchmark was run while adding them.

## Historical audit safety contract

Run the audit only against one of these sources:

- a production database copy restored on a loopback host (`--source=local-copy`); or
- a read replica that reports either `default_transaction_read_only=on` or `pg_is_in_recovery()=true` (`--source=read-replica`).

Never point it at the production primary. The CLI accepts only the dedicated `PARSER_AUDIT_DATABASE_URL`; it does not fall back to the application's `DATABASE_URL`. The runner executes `BEGIN TRANSACTION READ ONLY`, applies a bounded `SET LOCAL statement_timeout`, performs one fixed `SELECT`, and always finishes with `ROLLBACK`. Its runtime SQL guard rejects write statements.

Local-copy example:

```powershell
$env:PARSER_AUDIT_DATABASE_URL = "postgres://audit_reader:REDACTED@127.0.0.1:5432/money_flow_audit_copy"
npm.cmd run parser:audit -- --source=local-copy --min-count=3 --min-distinct-users=2 --dominance-threshold=0.8 --statement-timeout-ms=30000
```

Read-replica example:

```powershell
$env:PARSER_AUDIT_DATABASE_URL = "postgres://audit_reader:REDACTED@replica.example.invalid:5432/money_flow"
npm.cmd run parser:audit -- --source=read-replica --min-count=3 --min-distinct-users=2 --dominance-threshold=0.8 --statement-timeout-ms=30000
```

The URL examples are placeholders. Do not paste credentials into logs, tickets, CI, PRs, or committed files. Run the command interactively in a controlled local environment. Do not publish raw database exports as CI artifacts.

The thresholds may be made stricter, but not weaker than:

- `min-count=3`;
- `min-distinct-users=2`;
- `dominance-threshold=0.8`;
- `statement-timeout-ms` from 1 through 120000.

## Data and privacy rules

The fixed query reads regular expense drafts and confirmed expenses joined through `expenses.draft_id`. Confirmed expenses are the final category truth. Pending, inbox, and cancelled draft items can contribute only review-only evidence. RU and EN evidence is aggregated separately.

`source_text` is used only for bounded language and draft-status counts. It never creates an alias candidate. Candidate phrases can come only from `drafts.items[].description`, and an entire description is suppressed before aggregation if it contains a number or quantity word, currency token or symbol, URL, domain, email-like value, username/handle, or identifier-shaped value. Unambiguous item-to-expense ordinal mapping is required for confirmed multi-expense drafts.

Neither success nor failure output includes database URLs, queries, rows, raw `source_text`, descriptions, transcripts, amounts, record IDs, user IDs, or Telegram IDs. Do not add diagnostic logging that weakens this contract.

## Aggregate report format

The CLI prints one JSON object. This example is invented and contains no production result:

```json
{
  "schemaVersion": 2,
  "sourceKind": "local-copy",
  "thresholds": {
    "minCount": 3,
    "minDistinctUsers": 2,
    "dominanceThreshold": 0.8
  },
  "sourceSummary": {
    "languageCounts": { "ru": 0, "en": 0, "unknown": 0 },
    "statusCounts": { "pending": 0, "confirmed": 0, "inbox": 0, "cancelled": 0, "unknown": 0 }
  },
  "ambiguousMappingCount": 0,
  "languages": {
    "ru": { "qualifiedCandidateCount": 0 },
    "en": { "qualifiedCandidateCount": 0 }
  },
  "candidates": { "ru": [], "en": [] },
  "statusCounts": {
    "already_supported": 0,
    "manual_review": 0,
    "rejected_ambiguous": 0
  }
}
```

Qualified candidate entries contain only a bounded normalized phrase, decision enum, dominant category, dominance ratio, threshold-qualified occurrence/distinct-user counts, review-only count, and aggregate category distribution. `manual_review` is not approval. Merchant-specific or personal phrases must not become global aliases, even when thresholds pass. The tool never edits the category dictionary.

## Alias decision rules

An alias may be proposed only in a separate follow-up PR when all of these are true:

1. The owner has run the audit on an approved local copy or read replica and shared only the safe aggregate report.
2. The candidate passes the occurrence, distinct-user, and dominance thresholds in one language.
3. Confirmed expenses, not draft predictions, support the final category.
4. Review finds the phrase generic across users rather than merchant-specific, personal, geographic, or context-dependent.
5. Invented synthetic positive and false-positive regressions demonstrate safe generalization.

No candidate is added automatically. RU evidence cannot justify an EN alias, or vice versa.

## Explicit model and prompt benchmark

The committed corpus contains only invented RU/EN examples with fixed dates, timezones, currencies, and expected fields. Ordinary `npm.cmd test` uses injected parsers and cannot call the OpenAI API.

The real API benchmark is a separate, explicit command:

```powershell
$env:OPENAI_API_KEY = "REDACTED"
npm.cmd run parser:benchmark:api -- --current-model gpt-5-mini --candidate-model gpt-5-nano --runs 3
```

When `--current-model` is omitted, the command uses `OPENAI_MODEL`, or `gpt-5-mini` when that variable is absent. The candidate defaults to `gpt-5-nano`, a supported Responses API model documented by OpenAI as the fastest GPT-5 variant: https://developers.openai.com/api/docs/models/gpt-5-nano

The command forces `fastPathMode=off` so both variants use the current LLM prompt/schema. It reports critical correctness (expense count, amount, currency, timezone-aware local day, normalized budget impact), reviewable correctness (category and `needs_review`), and P50/P95 LLM HTTP latency separately by model and language. Failures expose only a synthetic case ID and fixed error code.

Benchmark output is evidence, not a switch. The harness never changes `OPENAI_MODEL`, code defaults, prompts, rollout configuration, or production environment values. A model or prompt change requires a separate reviewed PR after correctness and latency results are evaluated independently.

## Current status and follow-up

`blocked: production data not provided`

This status blocks only data-driven conclusions, not the tooling. No historical production audit result, evidence-based alias, or real model benchmark result is claimed in this PR.

After tooling merge, the owner can:

1. restore an approved production copy locally or provide an approved read replica;
2. run the audit outside CI and retain only the aggregate JSON;
3. review cross-user generic candidates separately for RU and EN;
4. add invented synthetic positive and false-positive cases for candidates that generalize;
5. run the explicit API benchmark, compare critical correctness before latency, and record the environment and run count;
6. open separate follow-up PRs for approved aliases and any prompt/model decision.

## Shadow-disagreement adjudication follow-up

Historical critical shadow disagreements are currently **unadjudicable**. The
completion event retains safe disagreement flags and routing enums, but it does
not retain a durable relation to the created draft, either parser's normalized
critical result, or a confirmation outcome for that same draft. Matching by
account and time would be ambiguous when a user has more than one in-flight
draft, so this audit intentionally does not attempt it.

Run the dedicated aggregate-only check only against an approved local copy or
read replica:

```powershell
$env:SHADOW_ADJUDICATION_DATABASE_URL = "postgres://127.0.0.1:5432/money_flow_audit_copy"
npm.cmd run parser:shadow-adjudication:audit -- --source=local-copy --statement-timeout-ms=30000
```

The command starts `BEGIN TRANSACTION READ ONLY`, applies the local statement
timeout, runs one fixed `SELECT`, and always rolls back. It never reads or
prints source text, descriptions, transcripts, financial values, account
identifiers, or Telegram identifiers. Its output contains only aggregate
counts by safe input type, language enum, local acceptance enum, reject-reason
enum, and result category. It separately reports the five critical field
counts plus `confirmed`, `cancelled`, `unconfirmed`, and `unlinked` lifecycle
counts. For the existing event history, all critical cases are `unlinked` and
`unadjudicable`; the three lifecycle counts remain zero rather than being
inferred.

### Minimal future correlation proposal

Implement this only in a separate, reviewed follow-up after the historical
result is accepted:

1. When a critical shadow draft is created, save a draft-owned correlation
   record containing a `fingerprintSchemaVersion`, safe enums, and keyed HMAC
   fingerprints of the normalized local and LLM critical-field tuples. Reuse
   the already required `PARSER_TEXT_HASH_SECRET`; do not add a new production
   setting.
2. Construct every fingerprint input as a domain-separated UTF-8 payload:
   `money-flow:shadow-adjudication:v1:<canonical-payload>`. Never HMAC a
   critical-field tuple without this independent domain and version prefix.
3. Define `<canonical-payload>` as RFC 8785 JSON Canonicalization Scheme
   output built from a new, explicit data structure rather than serializing a
   parser result object. The critical fields must be emitted in this fixed
   logical order: `expense_count`, then each expense's normalized `amount`,
   `currency`, local calendar day, and `budget_impact`. A multiple-expense
   payload must first sort its expense entries lexicographically by each
   entry's complete canonical representation; this makes the fingerprint
   independent of input array order and JSON property order.
4. Treat `fingerprintSchemaVersion` as part of the comparison contract.
   Fingerprints created with different schema versions must never be compared;
   report those cases as `unadjudicable` until an explicitly version-compatible
   migration strategy is approved.
5. Keep the correlation record linked by the existing internal draft relation,
   not by account/time matching and not by a value in an analytics event.
6. On confirm, build the same keyed fingerprint from the final saved regular
   expenses and persist only one result enum: `local_match`, `llm_match`,
   `neither_match`, or `unadjudicable`. On cancel, persist only `cancelled`;
   pending drafts at reporting time are `unconfirmed`.
7. Aggregate those stored enums in the audit. Fingerprints, draft references,
   and every value used to construct a fingerprint stay in the database and
   never reach analytics events, logs, stdout, fixtures, reports, or PR text.

This preserves the current parser routing, owner allowlist, zero percent
rollout, and production configuration. It makes future confirmed cases
decidable without retaining a second copy of user financial content.
