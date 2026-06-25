# Money Flow Domain Rules

This file records stable product and business rules. Read it before changing budget, planned payment, reserve, onboarding, dashboard, or currency behavior.

## Monthly Budget

- The monthly budget is the user's main recurring budget.
- A temporary current-month budget is only for users going through mid-month onboarding.
- A temporary current-month budget must disappear in the next month.
- Existing users must not get a temporary current-month budget unless they are in the dedicated mid-month onboarding state.

## Planned Payments

- Supported recurrence types are `monthly`, `weekly`, `twice_monthly`, and `one_off`.
- Each planned payment occurrence has its own occurrence date.
- When the user pays an overdue planned payment, the created transaction must use the occurrence date, not today's date.
- Disabled planned payments must not be included in active monthly totals.
- Weekly planned payments must not be counted more than once for the same target week.
- One-off planned payments must not repeat in the next month.

## Reserve

- Reserve is part of the MVP, but it should remain simple.
- Do not add multiple reserves, savings goals, free-text or voice reserve intents, or complex reserve charts unless explicitly requested.

## Out-Of-Budget And Large Purchases

- Out-of-budget expenses must not reduce the ordinary monthly budget.
- Large one-off purchases must not distort analytics for regular spending pace.

## Currencies And Rounding

- `THB`, `RUB`, `IDR`, and `BYN` should be displayed as whole units.
- `USD`, `EUR`, and `GEL` should preserve cents.
- A user may have both a local currency and display currencies.
