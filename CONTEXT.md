# Money Flow

Money Flow помогает пользователю управлять доступной частью месячного бюджета и понимать влияние расходов на текущий период.

## Language

**Historical Parser Audit**:
A read-only, privacy-safe aggregate analysis of regular expense drafts and their confirmed expenses, run only on an approved local production-data copy or read replica. It is evidence collection, not a production operation or automatic parser change.
_Avoid_: Production audit job, raw-message export, alias generator

**Alias Candidate**:
A threshold-qualified, cross-user generic RU or EN phrase surfaced for manual review against confirmed expense categories. It is never an approved alias by itself.
_Avoid_: New alias, merchant label, user phrase

**Parser Benchmark**:
An explicit comparison of parser correctness and LLM latency on a fixed invented RU/EN corpus. Its results inform a separate decision and never change the configured model automatically.
_Avoid_: Production experiment, automatic model selection, live traffic test

**Local Safe Parse**:
A deterministic regular-expense parse whose expense count, amount, currency, local calendar day, and budget impact are unambiguous and whose category is confidently resolved.
_Avoid_: Any local parse, locally parsed draft, high-confidence text

**Local Reviewable Parse**:
A deterministic regular-expense parse whose critical financial fields are unambiguous but whose category still requires an explicit user review before confirmation.
_Avoid_: Partially safe parse, accepted category, silent category fallback

**Local Rejected Parse**:
A deterministic regular-expense parse that must not become the financial result because at least one critical financial field or protected intent is ambiguous or unsupported.
_Avoid_: Parse error, invalid expense, LLM failure

Local acceptance exists only after deterministic evaluation completes. An LLM-only parse has no local acceptance level and is not a local candidate, accepted parse, or rejected parse.

**Expense CSV Export**:
A user-triggered CSV file containing only the user's confirmed expense records from `expenses`. It is not a full accounting export and must not include drafts, pending confirmations, failed parses, budget top-ups, reserve events, planned-payment definitions, feedback, internal user identifiers, Telegram identifiers, raw Telegram init data, debug payloads, tokens, or environment values.
_Avoid_: Full account export, cashflow export, backup dump, accounting ledger

**Feedback**:
A short user-authored message sent to Money Flow to report a problem, complaint, idea, or missing MVP capability. Feedback is not an expense, draft, support ticket, or accounting record.
_Avoid_: Expense, ticket, task, admin note

**Acquisition Source**:
The normalized source attached to a user's first valid entry into Money Flow; it identifies how the user originally arrived without retaining a full link or promotional text.
_Avoid_: Current navigation source, report link, arbitrary query parameter

**First-touch Attribution**:
The rule that a user's first Acquisition Source is permanent and later launches cannot replace it.
_Avoid_: Last-touch attribution, multi-touch attribution, latest link

**Product Activation**:
The first successfully saved expense after a user's first valid start.
_Avoid_: Draft creation, draft confirmation without a saved expense, onboarding completion

**Meaningful Activity**:
A deliberate user action that advances or uses Money Flow, excluding automatic reports, reminders, health checks, and background work.
_Avoid_: Any emitted event, automatic delivery, bot start without a product action

**Reachable User**:
A current user who has not been marked as having blocked the bot and whom Money Flow may therefore attempt to contact.
_Avoid_: Active user, all-time joined user, guaranteed-deliverable user

**D1 / D7 Retention**:
The share of a mature new-user cohort that performs Meaningful Activity in the defined day-one or day-seven return window after its first start.
_Avoid_: Calendar-day retention, automatic report delivery, all users as denominator

**Habit Started**:
A mature new user saving expenses on at least two distinct local dates during the first seven elapsed days after first start.
_Avoid_: Two expenses on one day, any two active events

**Account Deletion / Удаление данных пользователя**:
An irreversible user action that, after double confirmation, deletes user-owned Money Flow data: expenses, drafts, budgets, planned payments, reserves, settings, feedback, and user-owned analytics/events. After deletion, only one non-identifying `account_deleted` audit event remains with `user_id = NULL` and safe metadata without Telegram ID, internal user ID, financial data, feedback text, Telegram initData, or request body.
_Avoid_: Account deactivation, logout, soft delete, anonymized profile, support cleanup, admin deletion

**Пополнение бюджета (Budget Top-up)**:
Разовое увеличение доступного бюджета конкретного месяца за счёт полученных пользователем дополнительных денег. Пополнение прибавляется к текущему месячному бюджету поверх обычного бюджета или месячного override, не меняет регулярный месячный бюджет, не считается расходом и не превращает Money Flow в учёт доходов.
_Avoid_: Доход, зарплатный календарь, cashflow, перевод между своими счетами

**Резерв бюджета (Budget Reserve)**:
Замороженная часть бюджета конкретного месяца, недоступная для обычных расходов, но не считающаяся расходом или накопительным счётом.
_Avoid_: Копилка, цель накопления, savings goal, piggy bank

**Валюта резерва (Reserve Currency)**:
Базовая валюта бюджета пользователя на момент создания экземпляра; отдельной валюты у резерва нет, а закрытая история не конвертируется при последующей смене базовой валюты.

**Название резерва (Reserve Title)**:
Необязательный ярлык резерва текущего или будущего месяца; отсутствие названия хранится как `NULL` и не наследует ранее удалённое значение.

**Резерв месяца (Monthly Reserve)**:
Экземпляр резерва бюджета, относящийся ровно к одному пользователю и одному календарному месяцу в timezone пользователя.
_Avoid_: Баланс резерва, накопленный резерв

**Повторяемый резерв (Recurring Reserve)**:
Долгоживущее намерение пользователя создавать одинаковый резерв в каждом новом месяце, пока повторение явно не отключено. Оно сохраняется даже если резерв отдельного месяца не прошёл валидацию.
_Avoid_: Накопительный резерв

**Шаблон повторяемого резерва (Recurring Reserve Template)**:
Единственная переиспользуемая для пользователя настройка суммы, названия и валюты будущих ежемесячных резервов; её активация или изменение не меняет закрытые снимки.
_Avoid_: Резерв текущего месяца

**Экземпляр резерва месяца (Monthly Reserve Instance)**:
Резерв конкретного календарного месяца, созданный вручную или из повторяемого намерения. Пока период открыт, его бюджет синхронизируется с текущим бюджетом после валидации, а timezone остаётся фиксированной; отсутствие экземпляра не означает отключение повторения.
_Avoid_: Шаблон повторения

**Текущий период (Current Period)**:
Единственный календарный месяц, для которого пользователь может напрямую создать, изменить или отключить экземпляр резерва; будущими периодами управляет шаблон, прошлые доступны только как история.

**Повторная активация резерва (Reserve Reactivation)**:
Возврат отключённого экземпляра текущего периода в активное состояние через обновление той же записи после повторной валидации; закрытый экземпляр реактивировать нельзя.

**Заблокированный повторяемый резерв (Blocked Recurring Reserve)**:
Предложение создать повторяемый резерв текущего месяца, отклонённое потому, что сумма превышает свободный бюджет; частичный резерв автоматически не создаётся.

**Обычные расходы (Regular Spending)**:
Расходы месяца с типом влияния `regular`; именно они могут уменьшить сохранённую часть резерва. Плановые платежи, крупные внебюджетные покупки и сам резерв в эту корзину не входят.
_Avoid_: Все расходы месяца

**Крупная внебюджетная покупка (Large One-off Expense)**:
Фактический расход, намеренно вынесенный за рамки обычного бюджета; он показывается отдельно и не влияет на дневной лимит, состояние, прогноз или закрытие резерва.
_Avoid_: Обычный расход, плановое обязательство

**Плановые обязательства месяца (Monthly Planned Obligations)**:
Сумма оплаченных плановых обязательств месяца и активных неоплаченных обязательств этого месяца. Отключение исключает только неоплаченное будущее и не убирает уже совершённые плановые платежи.
_Avoid_: Только неоплаченные плановые, обычные расходы

**Статус оплаты планового обязательства (Planned Payment Paid Status)**:
Плановое обязательство конкретного occurrence считается оплаченным по факту записи о его оплате, привязанной к этому плановому платежу и occurrence, а не по локальной дате связанного расхода; дата расхода влияет только на размещение в истории и статистике и не может сделать оплаченное обязательство вновь неоплаченным или оправдать повторную оплату.
_Avoid_: Судить об оплате по дате расхода, допускать дубль оплаты при несовпадении дат

**Сохранённый резерв (Saved Reserve)**:
Часть резерва месяца, которую не пришлось использовать на обычные расходы к моменту расчёта или закрытия месяца.

**Съеденный резерв (Used Reserve)**:
Часть резерва месяца, которую обычные расходы превысили сверх доступного для них бюджета.

**Закрытый снимок резерва (Closed Reserve Snapshot)**:
Неизменяемый итог резерва месяца, фиксирующий сохранённую и съеденную суммы, перерасход и исходные бюджетные значения на момент закрытия.
_Avoid_: Текущий расчёт резерва, пересчитываемый итог

**Финансово закрытый месяц (Financially Closed Month)**:
Месяц с закрытым снимком резерва: в нём можно менять только не влияющие на деньги метаданные расхода — название, категорию и теги.
_Avoid_: Полностью недоступный месяц, пересчитываемый закрытый месяц

**Событие закрытия резерва (Reserve Closed Event)**:
Одноразовое уведомление о закрытом снимке резерва с итоговым статусом и исторической валютой; доставка события не удаляет и не изменяет сам снимок.
_Avoid_: Закрытый снимок

**Свободный бюджет (Free Budget)**:
Часть месячного бюджета после вычета плановых обязательств; активный резерв не может превышать эту сумму.
_Avoid_: Остаток после обычных расходов

**Ленивое открытие месяца (Lazy Month Opening)**:
Идемпотентное открытие только текущего месяца при первом обращении пользователя к dashboard или API, без создания периодов за пропущенные месяцы.
_Avoid_: Backfill месяцев

**Догоняющее закрытие (Catch-up Closing)**:
Идемпотентное закрытие всех реально существующих открытых экземпляров прошлых месяцев по данным каждого собственного периода, без создания отсутствующих экземпляров.
_Avoid_: Backfill резервов

**Область изменения резерва (Reserve Change Scope)**:
Явный выбор между изменением только текущего экземпляра и атомарным изменением текущего экземпляра вместе с шаблоном будущих резервов.
_Avoid_: Неявное изменение истории

**Отключение текущего резерва (Disable Current Reserve)**:
Перевод экземпляра текущего месяца в терминальное состояние `disabled`; он больше не участвует в расчётах и не создаётся повторно автоматически в этом же месяце, а повторяемое намерение может сохраниться для следующего месяца.

**Отключение повторения (Disable Reserve Recurrence)**:
Атомарное отключение открытого экземпляра текущего месяца и шаблона будущих резервов без изменения закрытых снимков.

**Timezone пользователя (User Timezone)**:
Валидная IANA timezone, полученная из клиентского окружения и определяющая календарные границы пользовательских месяцев; пока она неизвестна, используется UTC.
_Avoid_: Глобальная Asia/Bangkok timezone, timezone валюты

**Timezone периода (Period Timezone)**:
Timezone, зафиксированная при создании экземпляра резерва и используемая до его закрытия для границ периода, прогноза и итоговых расчётов, даже если timezone пользователя позднее изменилась.
_Avoid_: Текущая timezone устройства

**Расчётная timezone (Calculation Timezone)**:
Timezone текущего расчёта: timezone открытого экземпляра для reserve-связанных метрик либо актуальная timezone пользователя, если экземпляра нет.

**Дневной плановый лимит (Daily Plan Limit)**:
Стабильная дневная доля действующего бюджета: полный месячный бюджет распределяется по календарному месяцу, а partial-month бюджет — по исходному периоду от effective date до конца месяца.
_Avoid_: Recovery limit, safe-to-spend limit

**Partial-month бюджет (Partial-month Budget)**:
Бюджет на включительный период от даты его создания или последнего обновления до конца текущего календарного месяца.
_Avoid_: Полный месячный бюджет

**Безопасно тратить в день (Safe to Spend per Day)**:
Адаптивная recovery-метрика, рассчитанная из свободного остатка и текущего количества дней до конца месяца.
_Avoid_: Дневной бюджет, дневной плановый лимит

**Дневной снимок бюджета (Daily Budget Snapshot)**:
Сохранённый дневной плановый лимит конкретного календарного дня, который не меняется от обычных расходов внутри этого дня.
_Avoid_: Recovery snapshot
