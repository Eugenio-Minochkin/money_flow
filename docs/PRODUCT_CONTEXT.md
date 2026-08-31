# Money Flow Product Context

Money Flow is a Telegram-first personal finance tracker with an optional Mini App dashboard.
The product should feel simple, fast, and light: a user records expenses in the place where they already chat, then opens the dashboard only when they need a clearer budget picture.

## Product Promise

- Help a person understand where their money is going without turning tracking into a chore.
- Make expense capture quick through text and voice.
- Use confirmation before saving parsed expenses so the user stays in control.
- Keep the Mini App dashboard focused on budget state, recent movement, and immediate next actions.
- Allow simple one-off budget top-ups when extra money arrives during the month, without turning the product into income accounting.
- Send lightweight weekly and monthly Telegram report snapshots so the user can notice money movement without opening the Mini App.
- Remind users about an exact planned payment in Telegram and let them mark it paid, snooze its notification, or confirm disabling the plan without duplicating Mini App business rules.

## What It Is Not

- Not an accounting system.
- Not a back-office admin panel.
- Not a full financial planning suite.
- Not income accounting, salary planning, transfer tracking, or cashflow analytics.
- Not a place for complex savings-goal management unless explicitly requested.

## Experience Principles

- The main emotional goal is calm clarity: the user should understand money movement without overload.
- Dashboard screens should show budget state clearly and avoid visual noise.
- Settings should stay compact even as they cover budget, currencies, planned payments, reserve, language, theme, backup, and a single Siri/Shortcut entry that opens its own setup sheet.
- New work should usually improve the current MVP flows before adding a new major surface.
- Evening empty-day reminders should feel gentle and easy to dismiss, with a clear opt-out.
- Planned-payment reminders should use explicit payment terminology, avoid competing with the empty-day reminder, and become inactive when Mini App already changed the underlying plan.
- Timezone settings should stay lightweight: show the current timezone, allow auto-detect, prioritize common choices, and keep every runtime-valid IANA timezone available.
- Reports should feel calm and readable: meaningful sections, exact sums, no shame, and no double-counting.

## Product Analytics Boundaries

- Product analytics measures acquisition, onboarding, first `expense_saved`, meaningful activity, retention, habit, report engagement, and current reachability.
- New-user cohorts are anchored to `users.created_at`; a legacy user returning after analytics launch is not treated as newly joined.
- First-touch source is write-once. There is no attribution backfill for legacy accounts; a later valid entry may fill a missing source once.
- Deleted users cannot reconstruct acquisition or funnel history because personal event ownership is removed. Only an anonymous deletion count remains.
- Admin product and technical reports are operational tools, not end-user dashboard features.
