# Expense Parser Audit And Benchmark Design

## Scope

This is issue #115 PR C. It adds offline tooling and documentation only. It does not run a production audit, connect to a production primary, change parser routing, modify production environment values, switch the configured model, deploy, restart services, or add data-driven aliases before anonymized aggregates exist.

## Historical audit boundary

The audit is an explicit CLI for either a loopback-hosted local copy of production data or a database whose server reports a read-only/replica posture. It uses a dedicated audit URL, begins with `BEGIN TRANSACTION READ ONLY`, applies a validated `statement_timeout`, performs a fixed `SELECT`, and ends with `ROLLBACK` even on success. The query reads regular `drafts.source_text`, `drafts.items`, and confirmed `expenses` joined through `expenses.draft_id`; it does not inspect planned, reserve, budget-top-up, or transfer storage.

Raw database values may exist only in process memory while aggregation runs. They are never written to stdout, files, reports, CI artifacts, or PR text. Output is one JSON aggregate report containing bounded enums, counts, ratios, category distributions, and normalized RU/EN candidate tokens or short phrases. Numbers, URLs, email-like values, usernames/handles, domain-like tokens, and identifier-shaped values are removed before candidate construction.

Safe floors are three occurrences, two distinct users, and 80% category dominance. CLI overrides may make the thresholds stricter, never weaker. Candidate text is emitted only after the occurrence and cross-user floors pass. Confirmed expenses provide the final category; unconfirmed drafts are review-only evidence for potential misses and never category truth. Multi-expense source text is not mapped to a category unless item-to-expense ordinal mapping is unambiguous.

Every surfaced candidate remains a manual decision. The report can label a candidate `already_supported`, `manual_review`, or `rejected_ambiguous`, but it cannot edit `categories.js`. Merchant-specific or personal-looking phrases require manual rejection even after the privacy floors pass; no aggregate is evidence enough for automatic global alias creation.

## Benchmark boundary

The benchmark uses a committed, invented RU/EN corpus with fixed timestamps, timezone, currency defaults, and expected critical/reviewable fields. A pure scorer measures correctness separately from latency. Critical correctness covers expense count, amount, currency, timezone-aware day, and budget impact. Reviewable correctness covers category and `needs_review`. Latency reports P50 and P95 per model and language without artificial sleeps.

Ordinary `npm test` uses injected deterministic results and never calls OpenAI. A separate explicit command requires `OPENAI_API_KEY`, runs the current parser prompt through the configured model and a candidate model, and prints only aggregate scores plus synthetic case IDs. The runtime configuration is not changed. The default comparison is the configured `gpt-5-mini` against `gpt-5-nano`, which OpenAI documents as a supported Responses API model and the fastest GPT-5 variant: https://developers.openai.com/api/docs/models/gpt-5-nano

## Output and follow-up

The audit report records its safe-source kind, thresholds, language summaries, qualified candidates, ambiguous candidates, and status counts. It excludes database URLs, record IDs, user counts below the floor, raw text, descriptions, transcripts, and financial values.

Because no production copy or read replica was provided for this PR, the historical audit status is `blocked: production data not provided`. The PR still delivers complete tooling, tests, safe report format, and run instructions. After the owner runs the audit, a separate follow-up PR may review aggregates, generalize synthetic regressions, and add only evidence-backed aliases with positive and false-positive tests. Benchmark results likewise inform a separate model/prompt decision; the harness never switches a model automatically.

## Verification

Implementation follows TDD: focused failing audit tests, minimal audit implementation, focused failing benchmark tests, minimal benchmark implementation, focused cross-tool tests, full `npm.cmd test`, and `git diff --check`.
