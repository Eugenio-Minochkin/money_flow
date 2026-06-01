# Money Flow

Telegram bot + Mini App for the first vertical slice of personal expense tracking.

Implemented MVP slice:

- `/start` creates or updates a Telegram user.
- Text like `кофе 70 бат` creates a draft.
- Telegram inline `Confirm all` saves draft items as expenses.
- Confirmed expenses are stored in Postgres.
- `/today`, `/month`, and `/budget` return basic totals.
- Mini App dashboard shows today, month, budget, remaining budget, and safe-to-spend.

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
- `POSTGRES_PASSWORD` - strong database password
- `OPENAI_API_KEY` - optional; enables AI parsing for text messages
- `OPENAI_MODEL` - optional; defaults to `gpt-4.1-mini`

Start:

```bash
docker compose --env-file .env.production -f compose.prod.yml up -d --build
```

Check:

```bash
curl https://$APP_DOMAIN/health
```

Set Telegram webhook:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook?url=https://$APP_DOMAIN/telegram/webhook"
```

The Mini App URL is:

```text
https://$APP_DOMAIN
```

## Telegram webhook

Set `TELEGRAM_BOT_TOKEN` in `.env`, expose the local server with a tunnel, then point Telegram to:

```text
https://<public-url>/telegram/webhook
```

For local dry runs without a token, Telegram send calls are logged to stdout.
