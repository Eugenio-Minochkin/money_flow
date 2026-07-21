# Expense Parser Observability And Safety Design

## Scope

This is PR A for GitHub issue #115. It adds parser observability and safety plumbing without expanding the production rollout or introducing a new `local_reviewable` primary route.

PR B will improve local parser quality and may route `local_safe` and `local_reviewable` inside the existing rollout. PR C will add privacy-safe historical audit and prompt/model benchmark tooling. Each later PR starts only after the previous PR is merged into an updated `master`.

## Compatibility And Routing

The parser classifies every local evaluation as one of three safe enums:

- `local_safe`: critical financial fields are unambiguous and category resolution is confident.
- `local_reviewable`: critical financial fields are unambiguous but category resolution requires explicit user review.
- `local_rejected`: a critical field or protected intent is unsafe for local use.

If local evaluation does not complete, including LLM-only `off` mode, the trace omits local acceptance, candidate, and accepted fields. This keeps all three acceptance counts limited to completed local evaluations.

PR A records this classification but preserves current routing. In particular, it does not add a new local-primary route. Existing rollout behavior remains unchanged until PR B.

On LLM timeout or error, local fallback is permitted only for `local_safe`. A `local_reviewable` or `local_rejected` result produces the existing controlled parser failure flow.

## Critical And Reviewable Shadow Fields

Critical shadow fields are:

- `expense_count`;
- `amount`;
- `currency`;
- `spent_at`, compared as a calendar day in the user's timezone;
- `budget_impact`, with missing values normalized to `regular`.

Reviewable shadow fields are:

- `category_slug`;
- `needs_review`.

Shadow metadata exposes the complete safe enum list in `shadowDisagreementFields`, a `criticalShadowDisagreement` boolean, and a `categoryOnlyShadowDisagreement` boolean. The legacy `shadowDisagreement` boolean remains for compatibility.

## Timings

`expenseParser.parse()` emits monotonic internal durations:

- `localParseMs`: deterministic parser execution;
- `localEvaluateMs`: safety classification;
- `llmHttpMs`: HTTP request plus full response-body consumption;
- `llmDecodeNormalizeMs`: response JSON decode, structured-output extraction, expense JSON decode, and result normalization;
- `parserTotalMs`: the complete parser call, including route selection and shadow comparison.

The existing Telegram `llm_parse` stage remains temporarily compatible, but `/admin_stats_tech` uses the new internal fields for local and LLM latency.

## LLM Timeout

`EXPENSE_PARSER_LLM_TIMEOUT_MS` defaults to `20000` milliseconds only when it is absent. An explicitly configured value must be a base-10 positive integer from 1 through 2147483647; invalid values fail startup with a fixed safe configuration error. The value is wired through config and server construction to the parser.

Each OpenAI request receives an `AbortController.signal`. The controller is aborted when the timeout expires and is always cleared after the response body is consumed or the request fails. This is a controlled runtime behavior change: an LLM request that exceeds the configured parser timeout is aborted even when the overall Telegram job timeout is larger. There are no automatic retries. A timeout is normalized to the safe code `expense_parser_llm_timeout` without embedding request text, response text, or credentials.

## Privacy

Parser performance logs and `message_processing_completed` metadata contain only timings, bounded counts, booleans, and allowlisted enums. They never contain source text, transcript text, expense descriptions, Telegram IDs, or financial values.

The current raw Telegram ID is removed from performance stage payloads. Local parser exception messages are not copied into trace metadata because arbitrary exception messages may contain input. A bounded error name may be retained; the public timeout code is fixed.

Existing draft storage is unchanged. This PR creates no corpus, endpoint, table, or database migration.

## Technical Stats

`/admin_stats_tech` reports, for today and the last seven days:

- local candidate, accepted, and primary counts;
- `local_safe`, `local_reviewable`, and `local_rejected` counts;
- LLM fallback count;
- average and P95 local parser latency;
- average and P95 LLM HTTP latency;
- critical disagreement rate and sample count;
- category-only disagreement rate and sample count;
- amount and currency disagreement rates;
- reject reasons and disagreement fields.

Rates based on fewer than 100 shadow comparisons are labeled `insufficient sample`. Existing historical events without new metadata remain valid and produce zero/null values rather than query failures.

## Rollout And Rollback

PR A does not change production environment values, deploy, restart services, or enable rollout.

The runbook documents the stages `shadow`, owner/admin allowlist, 10%, 25%, 50%, and 100%, with minimum sample sizes, quality/latency gates, stop conditions, and exact rollback values.

Rollback to shadow-only measurement requires changing the environment and restarting the services:

```env
EXPENSE_PARSER_FAST_PATH_MODE=shadow
EXPENSE_PARSER_LOCAL_FIRST_ROLLOUT_PERCENT=0
EXPENSE_PARSER_LOCAL_FIRST_USER_IDS=
```

Full disablement requires changing the mode to:

```env
EXPENSE_PARSER_FAST_PATH_MODE=off
```

## Verification

Implementation follows TDD: focused failing tests first, minimal implementation, focused passing tests, then `npm.cmd test` and `git diff --check`. The draft PR includes baseline and result, privacy impact, DB/production impact, exact rollback instructions, and `## User Release Notes`.
