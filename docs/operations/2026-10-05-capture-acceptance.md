# Остаток приёмки #210, #235 и #237

Проверка от `origin/master` `c73d99f` (PR #241). Этот документ не разрешает
production-доступ, изменения rollout, merge/deploy или работу с постоянной БД.

## #210 — реальные голосовые

Автотесты с подставным transcriber проверяют путь Telegram → parser → draft,
но не доказывают качество реального Deepgram и приёмку на телефоне.

Отправить по одному сообщению и проверить сумму, GEL и замену loader:

| Ввод | Ожидаемая сумма |
| --- | --- |
| Голос: «чурчхела семь лари» | 7 GEL |
| Голос: «такси семь лари» | 7 GEL |
| Голос: «такси три пятьдесят лари» | 3.50 GEL |
| Голос: «такси три точка пятьдесят лари» | 3.50 GEL |
| Голос: «такси триста пятьдесят лари» | 350 GEL |
| Текст: «Такси 3,50 лари» | 3.50 GEL |

Уточнение неизвестной категории допустимо. Неясная речь и неоднозначная валюта
должны дать понятное уточнение без выдуманной суммы/валюты. При обычной доступности
Telegram API каждый loader сменяется одним terminal result. Не повторять ввод
уже сохранённого расхода ради проверки доставки.

Закрывать #210 только после подтверждения этих сценариев владельцем; записать
результаты без скриншотов финансовой истории, идентификаторов и сырых transcripts.

## #235 — исторические aliases

Персональная память и category-only review уже реализованы в #241. Исторические
aliases ещё не подтверждены: на этой машине dedicated audit URL не настроен,
безопасный aggregate report не предоставлен.

После получения разрешённой локальной копии либо verified read replica выполнить
существующий read-only audit по [контракту](../expense-parser-audit-benchmark.md).
Для локальной копии, с `PARSER_AUDIT_DATABASE_URL`, заданным владельцем вне чата:

```powershell
npm.cmd run parser:audit -- --source=local-copy --min-count=3 --min-distinct-users=2 --dominance-threshold=0.8 --statement-timeout-ms=30000
```

Для verified read replica заменить только `--source=read-replica`. Не использовать
application `DATABASE_URL` или production primary. Проверить generic RU/EN
кандидатов, отклонить personal/merchant/geographic/ambiguous phrases и добавить
только подтверждённые aliases с synthetic positive и false-positive tests.
Если подходящих кандидатов нет, зафиксировать реальный отчёт и причины; не
добавлять слова только ради закрытия задачи.

## #237 — порядок и оставшаяся реальная задержка

Ordering исправлен в #238. Benchmark теперь проверяет актуальный контракт:
B разбирается пока A ждёт injected LLM failure, затем side effects идут строго
`terminal A → draft B → save B → terminal B`. Ожидание сохранения B является
обязательным ordering, а не повторным LLM вызовом.

```powershell
node --test apps/api/test/telegramQueueBenchmark.test.js apps/api/test/telegramParserQueue.test.js apps/api/test/telegramJobQueue.test.js
node apps/api/scripts/benchmark-telegram-queue.js --delay-ms 20000
```

Измерения используют mock DB/Telegram и synthetic inputs, не являются production
latency. Исправление benchmark не устанавливает причину медленного `Ужин 40 лари`
из исходного инцидента.

Для завершения диагностики нужен отдельно разрешённый read-only сбор:

1. Проверить текущую revision API и только effective fast-path mode, rollout
   percentage, наличие allowlist и попадание тестирующего владельца в cohort.
   Не публиковать allowlist, IDs, hash secret или полный environment.
2. Получить из `app_events` только агрегаты `message_processing_completed` за
   согласованный ограниченный интервал, сгруппированные по `inputType`,
   `parserRoute`, `localAcceptanceLevel`, `llmSkipped`, `fastPathMode` и result.
3. Сравнить count и P50/P95 для `parseWaitMs`, `parserTotalMs`, `llmHttpMs`,
   `mutationWaitMs`, `dbSaveMs`, `telegramResponseMs` и `captureEndToEndMs`.
   Не выбирать user/chat/message IDs, source text, transcripts, суммы, описания
   или полный metadata JSON. Не выгружать сырые Docker logs.
4. Если старый инцидент нельзя однозначно восстановить, честно это зафиксировать.
   При новом воспроизведении проверить простой текстовый A, затем быстрый B;
   runtime traces различают parsing, очередь, сохранение и доставку.

`llmSkipped=false` вместе с `llm_primary`/`rollout_excluded` объясняет обращение
к LLM, но не доказывает ошибку parser. `local_primary` и `llmSkipped=true`
требуют искать задержку в других стадиях. Не менять конфигурацию для проверки
без отдельного разрешения. Закрывать #237 после полученных evidence и вывода
по реальной задержке, а не только после synthetic benchmark.

## Evidence этого прохода

- Новый benchmark regression сначала упал на прежнем требовании доставить B
  за секунду до завершения A; после исправления проходит.
- Focused queue/benchmark/audit CLI tests: 21 passed, 0 failed.
- `npm.cmd test -- --test-reporter=dot`: exit 0.
- Одноразовый PostgreSQL 16 на loopback, `npm.cmd run test:integration:postgres`:
  51 passed, 0 failed. Первый прогон выявил зависимость INR smoke от внешнего
  FX provider; только этот сценарий получил injected synthetic rates.
- 20-second benchmark: B parse start после dispatch ≈193ms; B mutation wait
  ≈19809ms; порядок `terminal_a,draft_b,save_b,terminal_b`; один сохранённый B.
  Это synthetic timing, не результат с телефона или production.
- #210: 2026-10-05 владелец подтвердил «все ок» после предложенного checklist
  реальных голосовых/текстового сообщения. Manual acceptance принят, issue закрыта.
- #235: владелец подтвердил отсутствие источника/отчёта; данные готовятся
  отдельно. CLI безопасно отказывается с `missing_audit_database_url`.
- #237: 2026-10-05 выполнена явно разрешённая read-only production диагностика:
  health/revision, safe effective routing config, агрегаты за день инцидента
  и последние 24 часа. Оставшийся acceptance проверен, issue закрыта.
  Production diagnosis и metrics остаются только в чате по решению владельца.
