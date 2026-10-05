# Исторический audit и aliases — #235

## Источник и безопасность

2026-10-05 владелец разрешил свежий backup перед локальным audit. Существующий
backup script создал и проверил custom-format archive; retention и внешняя
выгрузка были отключены только для этого запуска. SHA256 локального файла совпал
с серверным. Production health и revision проверены после backup.

Archive восстановлен в отдельный временный локальный PostgreSQL 16 без
production volumes и подключения к боту. Audit выполнен существующим CLI через
loopback, под отдельной SELECT-only ролью с `default_transaction_read_only=on`.
Отсутствие INSERT/UPDATE/DELETE privileges проверено. Постоянные финансовые данные
не изменялись; production restore, migrations, merge/deploy не выполнялись.

Пороги сохранены: минимум 3 использования, минимум 2 разных пользователя,
dominance категории минимум 80%; источник категории — confirmed regular
expenses. RU/EN проверяются отдельно. Report и backup остаются в закрытой
gitignored папке; raw data, source totals, identifiers и личные фразы в PR не
публикуются. Следующие таблицы содержат только reviewed generic candidates.

## Добавляемые exact RU aliases

Все четыре прошли audit thresholds; каждый generic и не является названием
магазина, человека или места. Новых stems и изменений matching/precedence нет.

| Alias | Категория | Synthetic false-positive / conflict check |
| --- | --- | --- |
| `дуриан` | `groceries` | `дуриановый` остаётся `other`; контекст кафе сохраняет `food_cafe` |
| `носки` | `gear` | `носкин` остаётся `other`; явная йога сохраняет `sport_activities` |
| `спортзал` | `sport_activities` | `спортзальный` остаётся `other`; явный массаж сохраняет `health` |
| `товары для дома` | `home` | `товары для домашнего` остаётся `other`; явные продукты сохраняют `groceries` |

Тесты используют выдуманные входы и проверяют exact boundaries, case/whitespace,
existing category conflict precedence, сумму, валюту, дату и обычный expense
budget impact. Из RU evidence не создаются EN переводы или неподтверждённые формы.

## Остальные кандидаты

| Решение | Кандидаты | Причина |
| --- | --- | --- |
| Оставить существующее поведение | `завтрак в кафе`, `обед в кафе`, `продукты в магазине`, `продукты домой` | Уже распознаются keyword/stem rules; duplicate exact aliases не нужны |
| Не добавлять глобально | `еда`, `зал`, `салат`, `чай` | Общие слова допускают разные категории вне текущей выборки |
| Отклонить | `бейгл`, `вода`, `кола`, `сок`, `тортик` | Category dominance ниже обязательного порога; неоднозначные confirmed outcomes |
| Отклонить | `расход` | Нет confirmed category evidence, только review-only |
| EN не расширять | `milk` | Нет confirmed EN category evidence; существующий generic alias уже поддерживается |

Остальные already-supported exact candidates изменений не требуют. Отчёт не
означает автоматического обучения словаря и не изменяет rollout.

## Проверки

- Два новых synthetic tests сначала упали на прежнем `other` для нового alias.
- Focused category/parser/routing/audit tests: 133 passed, 0 failed.
- `npm.cmd test -- --test-reporter=dot` и `npm.cmd run build:miniapp`: exit 0.
- `node --check packages/shared/src/categories.js` и `git diff --check`: passed.
- Повторный read-only audit после изменения словаря подтвердил обязательные
  пороги для всех четырёх aliases и состояние `already_supported`.
- Backup validation, checksum, isolated restore и read-only role проверены
  независимо от synthetic parser tests; audit не выполнялся на production primary.

После merge этого узкого PR доступны все части #235: historical review, personal
category memory и immediate category-only review из уже merged #241. До merge
issue остаётся открытой. Merge/deploy требуют отдельной команды владельца.
