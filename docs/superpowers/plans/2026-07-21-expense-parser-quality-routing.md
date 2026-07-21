# Expense Parser Quality And Routing Implementation Plan

> **Scope:** Issue #115 PR B only. Start from the merge of PR #118 and do not include audit/benchmark tooling from PR C.

**Goal:** Improve deterministic RU/EN expense parsing and route `local_safe` and `local_reviewable` results inside the existing rollout while keeping every financially ambiguous or protected intent on LLM fallback or a controlled reject.

**Safety contract:** Amount, currency, expense count, date, and budget impact are critical. Category is reviewable. A parser-provided `other` category must remain unconfirmable until the user explicitly selects a category, including an explicit user choice of `other`.

**Baseline:** `npm.cmd test` on `23ff7f8` passes `1051/1051` tests.

## Task 1: Synthetic regression corpus and diagnostic rejects

Status: complete.

- Add a privacy-safe synthetic RU/EN fixture corpus covering `local_safe`, `local_reviewable`, and `local_rejected`.
- Add focused failing shared-parser and expense-parser tests for:
  - `no_amount_token`;
  - `multiple_amounts_ambiguous`;
  - `small_bare_integer`;
  - `unsupported_amount_shape`;
  - `amount_over_limit`;
  - `unsafe_split_or_mapping`;
  - `unsupported_number_words`;
  - `local_exception`.
- Verify the new tests fail for the intended missing behavior before implementation.
- Implement the smallest privacy-safe diagnostic contract and rerun the focused tests.

## Task 2: Safe RU/EN amount, currency, and ASR parsing

Status: complete.

- Add failing synthetic tests for approved compact/spaced thousands, conservative Russian number words, narrow currency ASR aliases, amount-before/after-description, and punctuation variants.
- Keep one unambiguous amount per segment and the configured maximum amount.
- Add no broad substring matching and no evidence-based category aliases without real anonymized aggregates.
- Implement only the grammar and exact-token aliases required by the tests.
- Run `node --test packages/shared/test/parser.test.js`.

## Task 3: Safe multi-expense parsing and protected intents

Status: complete.

- Add failing corpus tests for unambiguous RU/EN multi-expense separators.
- Add negative routing tests for ambiguous multiple numbers and transfer/top-up/reserve/planned/split/debt/refund/installment/spread/out-of-budget/explicit-date intents.
- Ensure high-risk input calls the LLM when available and produces the existing controlled parser error if LLM fails; it must never become local primary.
- Run focused shared-parser and expense-parser tests.

## Task 4: Enum-based local routing

Status: complete.

- Add failing routing tests proving both `local_safe` and `local_reviewable` can be local primary only when `fastPathMode=enabled` and the user is inside the existing rollout.
- Prove `local_rejected` always falls back to LLM and that shadow/off/rollout-excluded behavior is unchanged.
- Replace compatibility-boolean routing decisions with explicit acceptance-level checks while preserving telemetry fields.
- Keep LLM error fallback restricted to `local_safe`.

## Task 5: Mandatory category review

Status: complete.

- Add repository regression coverage that parser-provided `other` is blocked even if `needs_review` is accidentally false.
- Add Telegram regression coverage that a category-required confirm attempt keeps the draft card/session available and emits no saved event.
- Preserve explicit user-selected `other` as valid.
- Run focused repository, Telegram, and keyboard tests.

## Task 6: Documentation and verification

Status: complete.

- Update `docs/DECISIONS.md` with PR B routing and diagnostic reason semantics.
- Update parser/domain/testing docs only where behavior changed; do not change env, compose, rollout values, or PR C tooling.
- Run focused tests, then `npm.cmd test`, then `git diff --check`.
- Review `origin/master...HEAD` for scope and privacy.
- Commit, push `codex/issue-115b-parser-quality-routing`, and open a draft PR into `master` with tests, privacy/DB/prod impact, rollback reference, and `## User Release Notes`.
- Do not merge, deploy, restart services, change production env, or start PR C.
