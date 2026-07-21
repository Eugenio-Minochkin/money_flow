export const EXPENSE_PARSER_BENCHMARK_CORPUS = Object.freeze([
  Object.freeze({
    id: "ru_simple_default_currency",
    language: "ru",
    input: "Кофе 450",
    now: "2026-07-21T09:00:00.000Z",
    timeZone: "Europe/Moscow",
    defaultCurrency: "RUB",
    expected: Object.freeze({
      expenses: Object.freeze([
        Object.freeze({
          amount: 450,
          currency: "RUB",
          spent_at: "2026-07-21T09:00:00.000Z",
          budget_impact: "regular",
          category_slug: "food_cafe",
          needs_review: false
        })
      ])
    })
  }),
  Object.freeze({
    id: "en_explicit_currency",
    language: "en",
    input: "Taxi 18 USD",
    now: "2026-07-21T12:00:00.000Z",
    timeZone: "America/New_York",
    defaultCurrency: "THB",
    expected: Object.freeze({
      expenses: Object.freeze([
        Object.freeze({
          amount: 18,
          currency: "USD",
          spent_at: "2026-07-21T12:00:00.000Z",
          budget_impact: "regular",
          category_slug: "transport",
          needs_review: false
        })
      ])
    })
  }),
  Object.freeze({
    id: "ru_multiple_expenses",
    language: "ru",
    input: "Продукты 1200 рублей и метро 90 рублей",
    now: "2026-07-21T08:00:00.000Z",
    timeZone: "Europe/Moscow",
    defaultCurrency: "RUB",
    expected: Object.freeze({
      expenses: Object.freeze([
        Object.freeze({
          amount: 1200,
          currency: "RUB",
          spent_at: "2026-07-21T08:00:00.000Z",
          budget_impact: "regular",
          category_slug: "groceries",
          needs_review: false
        }),
        Object.freeze({
          amount: 90,
          currency: "RUB",
          spent_at: "2026-07-21T08:00:00.000Z",
          budget_impact: "regular",
          category_slug: "transport",
          needs_review: false
        })
      ])
    })
  }),
  Object.freeze({
    id: "en_timezone_yesterday",
    language: "en",
    input: "Dinner yesterday 30 USD",
    now: "2026-07-21T00:30:00.000Z",
    timeZone: "America/New_York",
    defaultCurrency: "USD",
    expected: Object.freeze({
      expenses: Object.freeze([
        Object.freeze({
          amount: 30,
          currency: "USD",
          spent_at: "2026-07-19T23:00:00.000-04:00",
          budget_impact: "regular",
          category_slug: "food_cafe",
          needs_review: false
        })
      ])
    })
  }),
  Object.freeze({
    id: "ru_large_oneoff",
    language: "ru",
    input: "Крупная разовая покупка ноутбука 85000 рублей",
    now: "2026-07-21T10:00:00.000Z",
    timeZone: "Europe/Moscow",
    defaultCurrency: "RUB",
    expected: Object.freeze({
      expenses: Object.freeze([
        Object.freeze({
          amount: 85000,
          currency: "RUB",
          spent_at: "2026-07-21T10:00:00.000Z",
          budget_impact: "large_oneoff",
          category_slug: "gear",
          needs_review: false
        })
      ])
    })
  }),
  Object.freeze({
    id: "en_planned_reviewable",
    language: "en",
    input: "Planned payment for a service 500 THB, category unclear",
    now: "2026-07-21T06:00:00.000Z",
    timeZone: "Asia/Bangkok",
    defaultCurrency: "THB",
    expected: Object.freeze({
      expenses: Object.freeze([
        Object.freeze({
          amount: 500,
          currency: "THB",
          spent_at: "2026-07-21T06:00:00.000Z",
          budget_impact: "planned",
          category_slug: "other",
          needs_review: true
        })
      ])
    })
  })
]);
