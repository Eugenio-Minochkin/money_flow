# Expense Fast Path Design

## Scope

Implement the core of GitHub issue #69: a conservative local expense parser fast-path before OpenAI, guarded by `EXPENSE_FAST_PATH_MODE=off|shadow|enabled`.

This PR deliberately does not implement semi-automatic keyword learning. It keeps `other + needs_review` intact and adds metadata/admin stats that can support a later learning-loop task.

## Product Rules

- Simple RU/EN expense text and voice transcripts should skip OpenAI when amount, currency, date, and structure are safe.
- Category uncertainty is not a parse failure. Unknown category becomes `category_slug: "other"`, `needs_review: true`, low confidence, and no OpenAI call in enabled mode.
- Amount/date/currency uncertainty is high risk and must defer to OpenAI.
- Planned expense parsing remains before regular expense parsing.
- OpenAI remains the source for complex, ambiguous, split, budget-modified, or explicit-period language.

## Rollout Modes

- `off`: current LLM-first behavior when an API key exists. If no API key exists, local fallback remains.
- `shadow`: run local parser and OpenAI; apply OpenAI result; record disagreement metadata.
- `enabled`: accept local fast-path when safe; otherwise call OpenAI.

## Implementation Shape

- Improve `packages/shared/src/parser.js` for deterministic local parsing: amount before/after description, safe amount formats, attached currency symbols, RU/EN relative dates, and clean multi-expense splits.
- Improve `packages/shared/src/categories.js` with whole-token/exact-phrase conservative RU/EN keyword matching.
- Add fast-path evaluation in `apps/api/src/expenseParser.js`, including stop-pattern rejection and shadow comparison.
- Emit parser metadata through the existing Telegram perf trace and `message_processing_completed` event.
- Extend admin stats with compact local/LLM/reject/review/shadow counters and timing split without breaking current output.

## Safety

Prefer one extra LLM call over one corrupted expense. Stop-patterns and ambiguous amount mapping always reject local fast-path.
