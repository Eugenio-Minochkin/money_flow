# Money Flow

Telegram bot + Mini App for the first vertical slice of personal expense tracking.

Implemented MVP slice:

- `/start` creates or updates a Telegram user and runs onboarding for language, base currency, and budget setup.
- Text like `кофе 70 бат` creates a draft; Telegram voice messages can be transcribed when Deepgram is configured.
- Telegram inline `Confirm all` saves draft items as expenses.
- Confirmed expenses are stored in Postgres with original currency, base currency, converted display amounts, category, tags, and `budget_impact`.
- `/today`, `/month`, and `/budget` return budget-aware totals.
- Mini App dashboard shows today, week, month, monthly budget, remaining budget, safe-to-spend, forecast, analytics, latest expenses, history, and settings.
- Planned expenses support `monthly`, `weekly`, `twice_monthly`, and `one_off` recurrence with occurrence-level paid tracking.
- Budget Reserve supports one active monthly reserve, one recurring reserve template, month closing snapshots, and Mini App management.

## MVP budget safety contract

Money Flow currently has enough budget machinery for the MVP. The priority is correctness and explainability, not more budget features.

Core rules:

- Daily budget and safe-to-spend are recalculated from the effective monthly budget, regular spending, unpaid planned expenses, and active reserve.
- Changing the monthly budget or current-month budget must invalidate the current daily budget snapshot so the next dashboard load does not reuse stale day limits.
- Planned expenses are not just labels: paid planned occurrences become expenses with `budget_impact = planned`, while unpaid current-month occurrences stay reserved from free budget.
- Budget Reserve protects regular spending only. Planned expenses and `large_oneoff` expenses remain separate buckets.
- Active reserve must fit after planned obligations. Budget or planned-expense changes that would make the active reserve impossible should be rejected.
- Forecast uses regular spending pace, then adds non-daily planned/large buckets separately.

Frozen for MVP:

- multiple simultaneous reserves;
- savings goals;
- free-text or voice reserve intents;
- complex reserve templates;
- reserve growth charts.

The regression coverage for the most fragile path lives in `apps/api/test/budgetReserveIntegration.test.js`: budget change -> planned obligations -> active reserve -> daily budget snapshot -> monthly forecast.

## Run locally

1. Copy env:

   ```powershell
   Copy-Item .env.example .env
   ```

2. Start Postgres:

   ```powershell
   docker compose up -d postgres
   ```

3. Install dependencies:

   ```powershell
   npm.cmd install
   ```

4. Start API + Mini App static server:

   ```powershell
   npm.cmd run start:api
   ```

The API listens on `http://localhost:3000`. The Mini App is served from the same origin.

To preview only the Mini App UI before merging changes, run:

```powershell
npm.cmd run dev:miniapp
```

Then open:

```text
http://localhost:3000/?telegramUserId=100001
```

## Local acceptance sandbox

Use this flow before marking a feature PR ready for merge or deploy. It uses only local/dev data and the demo Telegram user `100001`.

1. Copy env:

   ```powershell
   Copy-Item .env.example .env
   ```

2. Start Postgres:

   ```powershell
   docker compose up -d postgres
   ```

3. Install dependencies:

   ```powershell
   npm.cmd install
   ```

4. Reset and seed the local database:

   ```powershell
   npm.cmd run dev:reset
   ```

5. Start API + Mini App static server:

   ```powershell
   npm.cmd run dev:api
   ```

6. Open the sandbox:

   ```text
   http://localhost:3000/dev
   ```

7. Open the Mini App as the demo user:

   ```text
   http://localhost:3000/?telegramUserId=100001
   ```

8. Send fake bot messages in the sandbox, click simulated inline buttons, then check dashboard, today, month, budget, drafts, planned expenses, reserve, and history.

9. Run tests:

   ```powershell
   npm.cmd test
   ```

10. Only after the local acceptance pass should the PR be marked ready.

The root helper scripts are:

- `npm run dev:reset` - refuses production mode or production-looking database URLs, runs migrations, resets the local database, and seeds demo data.
- `npm run dev:api` - starts the local API and Mini App static server.
- `npm run dev:sandbox` - prints the sandbox URL after the API is running.
- `npm run dev` - prints the full local acceptance sequence.

### Demo data

`dev:reset` creates demo user `telegram_user_id = 100001` with a `45000 THB` monthly budget, THB base currency, USD display currency, and completed onboarding.

The seed includes realistic fake data for visual acceptance:

- expenses for today, yesterday, the current month, and the previous month;
- regular, planned, and `large_oneoff` budget impact examples;
- many history rows for scrolling and layout checks;
- categories such as cafe, groceries, transport, home, sport, rent, health, subscriptions, education, and electronics;
- pending and inbox drafts, including a multi-item draft;
- planned expenses with paid and unpaid examples.

### Browser Telegram simulation

The sandbox page at `http://localhost:3000/dev` includes:

- an "Open Mini App as demo user" link;
- current dashboard, today, month, budget, recent expenses, drafts, and planned expenses;
- a "Send bot message" form with quick examples:
  `coffee 70 baht`, `groceries 500 baht`, `planned rent 20000 baht monthly`, `large purchase monitor 8000 baht`, `/today`, `/month`, `/budget`;
- a Bot response block that renders the text and inline keyboard returned by the real bot logic;
- clickable inline callback simulation for confirm, cancel, category, amount adjustment, planned draft confirmation, and Mini App links.

Internally, `POST /dev/telegram/update` builds a fake Telegram message or callback update and passes it through `bot.handleUpdate`. The endpoint captures what the bot would send to Telegram and returns it to the browser.

### Sandbox safety

The local sandbox is guarded intentionally:

- `/dev` and `/dev/*` return `404` when `NODE_ENV=production`;
- `dev:reset` throws when `NODE_ENV=production`;
- `dev:reset` throws when `DATABASE_URL` does not look local/dev;
- no production data is read or copied for sandbox data;
- production deploy behavior and Telegram webhook behavior are unchanged.

### Manual acceptance checklist

Before merge/deploy I should be able to:

- run local Postgres;
- reset and seed demo data;
- open `http://localhost:3000/dev`;
- open Mini App as `telegramUserId=100001`;
- see seeded budget, dashboard, and history;
- send fake text expenses from the browser;
- simulate `/today`, `/month`, and `/budget`;
- simulate inline buttons;
- confirm a draft;
- test regular, planned, and `large_oneoff` budget impact examples;
- test planned payments and reserve settings;
- see dashboard numbers update;
- check many expenses in history;
- edit CSS/JS locally and refresh to see UI changes;
- run `npm test` successfully.

### Testing with real development Telegram bot

Voice message acceptance should be tested in a future phase with a real development Telegram bot. The browser simulator is enough for text, inline buttons, Mini App, and budget logic, but voice depends on the real Telegram client and file flow.

Future phase:

1. Create a separate development bot through BotFather.
2. Put the development token in local `.env` as `TELEGRAM_BOT_TOKEN`.
3. Confirm `DATABASE_URL` points only to a local/dev database.
4. Start the local API with `npm run dev:api`.
5. Open a local tunnel to `http://localhost:3000`.
6. Set the dev bot webhook to the `/telegram/webhook` route on the tunnel URL.
7. Send a voice message from Telegram and verify it end-to-end against the local database.

## Production deploy

The production setup uses Docker Compose with:

- `api` - Node.js API, Telegram webhook, Mini App static server
- `postgres` - persistent database
- `caddy` - HTTPS reverse proxy with automatic TLS

On the server:

```bash
cp .env.production.example .env.production
```

Edit `.env.production`:

- `APP_DOMAIN` - public domain pointed to the server
- `TELEGRAM_BOT_TOKEN` - token from BotFather
- `TELEGRAM_WEBHOOK_SECRET` - strong random secret for Telegram webhook requests
- `REQUIRE_TELEGRAM_INIT_DATA=true` - require signed Telegram Mini App init data in production
- `POSTGRES_PASSWORD` - strong database password
- `OPENAI_API_KEY` - optional; enables AI parsing for text messages
- `OPENAI_MODEL` - optional; defaults to `gpt-5-mini`
- `EXPENSE_FAST_PATH_MODE` - `off`, `shadow`, or `enabled`; `off` restores LLM-first parsing after the API process restarts
- `DEEPGRAM_API_KEY` - optional; enables Telegram voice message transcription

Start:

```bash
docker compose --env-file .env.production -f compose.prod.yml up -d --build
```

Check:

```bash
curl https://$APP_DOMAIN/health
```

Set Telegram webhook to the production `/telegram/webhook` route.

The Mini App URL is:

```text
https://$APP_DOMAIN
```

## Telegram webhook

Set `TELEGRAM_BOT_TOKEN` in `.env`, expose the local server with a tunnel, then point Telegram to the public `/telegram/webhook` URL.

For local dry runs without a token, Telegram send calls are logged to stdout.

## Budget Reserve MVP

Budget Reserve protects part of the effective monthly budget from regular spending. It is not an expense or savings account. Reserve calculations use only `budget_impact = regular`; planned obligations and `large_oneoff` expenses remain separate buckets.

The MVP includes one monthly reserve instance per user/period, one reusable recurring template per user, lazy timezone-aware month opening, immutable close snapshots, Mini App management, and `/budget`/close-event Telegram output.

Deferred work:

- timezone settings UI;
- free-text and voice reserve intents;
- reconcile warnings after historical expense edits;
- multiple simultaneous reserves;
- savings-goal progress across months.
