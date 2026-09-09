# Issue #210 Voice Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every voice-expense terminal result actionable, preserve safe monetary interpretation, and replace or safely clean up its processing loader.

**Architecture:** Keep the existing Telegram queue, durable capture claim, parser, and draft persistence boundary. Add a conservative pre-parser repair solely for a recognized Russian number word directly joined to an exact currency word; classify voice failures at their real stage; centralize loader terminalization with edit, plain-edit, and delete-then-send modes. Do not infer decimal positions from compact numerals.

**Tech Stack:** Node.js ESM, `node:test`, existing Telegram Bot API adapter, PostgreSQL-backed Telegram capture claims.

---

### Task 1: Cover real voice transcript parsing and safe boundary repair

**Files:**
- Modify: `apps/api/src/voiceMoneyNormalization.js`
- Modify: `apps/api/test/voiceMoneyNormalization.test.js`
- Modify: `apps/api/test/telegram.test.js`

- [ ] **Step 1: Write failing normalization and end-to-end voice tests.** Add cases for `семьлари` and `семилари` becoming `семь лари` / `семь лари`; run the normalizer test and confirm the current source leaves those inputs unchanged. Add queued voice-path cases where a transcriber returns `чурчхела семь лари`, `такси семь лари`, spoken and separator decimals, `такси триста пятьдесят лари`, and `чурчхела семьлари`; assert the persisted item has `GEL` and respectively `7`, `7`, `3.5`, `350`, and `7`.
- [ ] **Step 2: Implement the smallest safe repair.** Only split an exact supported currency suffix from a preceding recognized Russian unit word when the whole transcript has one exact currency and no competing number/currency amount. Leave numeric compact tokens such as `350` untouched, so a genuine `350 GEL` continues through the existing parser.
- [ ] **Step 3: Re-run focused voice tests.** Run `node --test apps/api/test/voiceMoneyNormalization.test.js apps/api/test/telegram.test.js`; all new real-path cases must pass.

### Task 2: Preserve the actual failure stage in a user-safe result

**Files:**
- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/test/telegram.test.js`

- [ ] **Step 1: Add failing transcript-stage tests.** Verify a transcription exception produces the voice-specific retry text; verify a usable transcript with no amount and a transcript with no recognized currency produce a bounded escaped `Я услышал: …` clarification, not the generic job error. Assert emitted event metadata includes bounded transcript length, normalization-change flag, currency recognition state, parser route, and stable failure stage/code without raw transcript content.
- [ ] **Step 2: Implement stage classification at the boundaries already present.** Record `telegram_file_download`, `transcription`, `currency_recognition`, `parser`, `draft_persist`, and `terminal_delivery` only at the code path that observes each failure. Use the existing text formatter for escaping/bounding transcript display. Preserve the current durable capture failure write and do not log transcript body or provider response.
- [ ] **Step 3: Run focused tests.** Run `node --test apps/api/test/telegram.test.js` and confirm each error route uses the expected localized text and metadata.

### Task 3: Make loader terminalization single-message and observable

**Files:**
- Modify: `apps/api/src/telegram.js`
- Modify: `apps/api/test/telegram.test.js`

- [ ] **Step 1: Write failing terminalization tests.** Cover: rich edit succeeds (`edit`); rich edit fails then plain edit succeeds (`plain_edit_fallback`); both edits fail then delete succeeds and exactly one final send occurs (`delete_and_send_fallback`); delete fails and no second terminal response is sent (`cleanup_failed`). Use a voice transcription failure and a parser clarification so normal error paths exercise the same helper.
- [ ] **Step 2: Implement one terminalization helper.** It must first edit the loader with the rich result, retry the same message in minimal/plain form, then delete and send only after confirmed deletion. If deletion fails, log a privacy-safe diagnostic and return a handled cleanup failure, preventing `sendQueuedJobFailure()` from adding a duplicate generic message. Route normal success, clarification, known errors, and unexpected errors through this helper.
- [ ] **Step 3: Run the focused Telegram suite.** Run `node --test apps/api/test/telegram.test.js`; all terminalization tests must pass with no orphan loader simulation.

### Task 4: Verify contracts and publish the narrow follow-up

**Files:**
- Modify: `docs/DOMAIN_RULES.md`
- Modify: `docs/TESTING_GUIDE.md`

- [ ] **Step 1: Document the durable/Telegram boundary.** Add the stable failure-stage and terminalization-mode contract, the privacy limit for diagnostics, and the required focused test command. Do not change database schema unless source evidence requires it.
- [ ] **Step 2: Run verification.** Run `node --test apps/api/test/voiceMoneyNormalization.test.js apps/api/test/voiceTranscriber.test.js apps/api/test/telegram.test.js`, `npm.cmd test`, and `git diff --check`. Run `npm.cmd run test:integration:postgres` if repository or durable claim code changes.
- [ ] **Step 3: Review and publish.** Inspect `git diff`, commit only Issue #210 files, push `codex/issue-210-voice-capture`, and open a draft PR into `master` with `Closes #210`, the exact verification evidence, DB/prod impact, diagnostics privacy note, manual Telegram checks, and `## User Release Notes`. Do not merge or deploy.
