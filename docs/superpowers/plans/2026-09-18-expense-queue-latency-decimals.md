# Expense Queue, Latency, Save, and Decimal Fixes Implementation Plan

**Goal:** Исправить lifecycle queued-сообщения, мультипликацию Telegram latency, блокирующий callback ACK при Save и дробные суммы в parser/editor без изменения idempotency и последовательной обработки.

**Architecture:** Сохраняем `message_id` queued-status внутри уже существующего per-user queue lifecycle и переиспользуем его как processing loader. Для Telegram terminalization используем один общий deadline на весь fallback-каскад, а callback ACK запускаем параллельно с canonical `saveDraftAsExpense()` и ограничиваем коротким deadline. Явные decimal-суммы остаются локальным финансовым инвариантом, даже если LLM вернул сумму без разделителя; editor использует общий currency recognizer для ISO-кодов и алиасов.

**Tech Stack:** Node.js ESM, `node:test`, PostgreSQL repository boundary, Telegram Bot API.

---

### Task 1: Queue-status lifecycle

**Files:**
- Modify: `apps/api/src/telegram.js`
- Test: `apps/api/test/telegram.test.js`

- [x] **Step 1: Write a failing queued lifecycle test**

Добавить сценарий с удерживаемым первым job и вторым сообщением. Проверить последовательность второго `message_id`: `sendMessage("Принял ещё...")`, затем `editMessageText("Заношу расход...")`, затем terminal edit; отдельный loader для второго сообщения не создаётся.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern="queued status becomes" apps/api/test/telegram.test.js`

Expected: FAIL, потому что текущий worker отправляет новый loader и не редактирует queued-status.

- [x] **Step 3: Implement the minimal lifecycle handoff**

Создать deferred `queuedStatusMessage` до `enqueue`, разрешить его извлечённым `message_id` после best-effort отправки статуса и передать в `processQueuedMessage`. В `sendExpenseProcessingMessage` при наличии этого id выполнить best-effort edit в `botText(language, "expenseProcessing")` и вернуть тот же id для terminalization.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `node --test --test-name-pattern="queued status becomes" apps/api/test/telegram.test.js`

Expected: PASS.

### Task 2: Active-processing and Save latency

**Files:**
- Modify: `apps/api/src/telegram.js`
- Test: `apps/api/test/telegram.test.js`
- Test: `apps/api/test/adminStatsProcessingDiagnostics.test.js`

- [x] **Step 1: Write failing deadline and ACK-order tests**

Проверить, что terminal edit/plain/delete получают один и тот же `AbortSignal`, а `confirmDraftWithExplicitAcceptance()` начинается до завершения зависшего callback ACK. Проверить диагностические поля `activeProcessingMs`, `endToEndTotalMs`, `parserTotalMs`, `llmHttpMs`, `dbSaveMs`, `telegramResponseMs`.

- [x] **Step 2: Run focused tests and verify RED**

Run: `node --test --test-name-pattern="shared terminal deadline|does not gate saving|end-to-end" apps/api/test/telegram.test.js apps/api/test/adminStatsProcessingDiagnostics.test.js`

Expected: FAIL на отдельных per-attempt deadlines, serial ACK/save и отсутствующих total aliases.

- [x] **Step 3: Implement bounded delivery and non-blocking ACK**

Создать один `deadlineSignal(signal, 15_000)` на вызов `deliverResultMessage` и передавать его во все edit/delete/send попытки. В confirm flow запустить ACK с `requestTimeoutMs: 2_000`, немедленно начать canonical save, а ACK settlement учитывать после user-visible terminal response. Не запускать parser/LLM в confirm path.

- [x] **Step 4: Make timing semantics explicit**

Сохранить `processingTotalMs` как active time после старта worker, добавить `endToEndTotalMs = queueWaitMs + processingTotalMs`, а в admin aggregation продолжить отдельно показывать queue, parser total/local/LLM HTTP, DB и Telegram.

- [x] **Step 5: Run focused tests and verify GREEN**

Run: `node --test apps/api/test/telegram.test.js apps/api/test/adminStatsProcessingDiagnostics.test.js`

Expected: PASS.

### Task 3: Decimal preservation and edit aliases

**Files:**
- Modify: `apps/api/src/expenseParser.js`
- Modify: `apps/api/src/telegramExpenseInput.js`
- Test: `apps/api/test/expenseParser.test.js`
- Test: `apps/api/test/telegramExpenseInput.test.js`
- Test: `apps/api/test/voiceMoneyNormalization.test.js`
- Test: `packages/shared/test/parser.test.js`

- [x] **Step 1: Write failing decimal regression tests**

Проверить `6.55` и `6,55` в shared parser/voice normalization; LLM fixture намеренно возвращает `655`, но итог остаётся `6.55`. Проверить editor inputs `6.55`, `6,55`, `6.55 GEL`, `6,55 GEL`, `6.55 лари`, `6,55 лари` и mixed-case ISO.

- [x] **Step 2: Run focused tests and verify RED**

Run: `node --test packages/shared/test/parser.test.js apps/api/test/voiceMoneyNormalization.test.js apps/api/test/expenseParser.test.js apps/api/test/telegramExpenseInput.test.js`

Expected: FAIL для LLM decimal corruption и алиаса `лари`.

- [x] **Step 3: Implement the minimal decimal guard**

Если вход содержит одну явную decimal-сумму, а local parser и LLM вернули по одному расходу, переносить `amount` и `currency` из проверенного local result в LLM result. В editor отделить numeric token от currency text и разрешать только `recognizeCurrencyText(...).kind === "exact"`.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `node --test packages/shared/test/parser.test.js apps/api/test/voiceMoneyNormalization.test.js apps/api/test/expenseParser.test.js apps/api/test/telegramExpenseInput.test.js`

Expected: PASS.

### Task 4: Full verification and Draft PR

**Files:**
- Modify: `docs/superpowers/plans/2026-09-18-expense-queue-latency-decimals.md` (checkbox status only)

- [x] **Step 1: Run all affected tests**

Run: `node --test apps/api/test/telegram.test.js apps/api/test/telegramJobQueue.test.js apps/api/test/adminStatsProcessingDiagnostics.test.js apps/api/test/expenseParser.test.js apps/api/test/telegramExpenseInput.test.js apps/api/test/voiceMoneyNormalization.test.js packages/shared/test/parser.test.js`

Expected: PASS.

- [x] **Step 2: Run repository-wide verification**

Run: `npm.cmd test`

Expected: 0 failed.

- [x] **Step 3: Validate the diff**

Run: `git diff --check` and `git diff --stat`.

Expected: no whitespace errors and only scoped files.

- [x] **Step 4: Commit and publish a Draft PR**

Run: `git add <scoped files>`, `git commit -m "fix: stabilize expense queue and decimal handling"`, `git push -u origin codex/fix-expense-queue-latency-amounts`, `gh pr create --draft --base master --head codex/fix-expense-queue-latency-amounts`.

Expected: Draft PR contains Russian root-cause summary, tests, DB/prod impact, and `## User Release Notes`; no merge or deploy.
