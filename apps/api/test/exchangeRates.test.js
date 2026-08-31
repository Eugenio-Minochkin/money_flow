import test from "node:test";
import assert from "node:assert/strict";

import { createExchangeRateProvider } from "../src/exchangeRates.js";

test("uses RUB and THB rates from Open ER API when available", async () => {
  const urls = [];
  const provider = createExchangeRateProvider({
    async fetchImpl(url) {
      urls.push(url);
      return {
        ok: true,
        async json() {
          return {
            result: "success",
            time_last_update_utc: "Tue, 02 Jun 2026 00:02:32 +0000",
            rates: {
              BYN: 3.012345,
              EUR: 0.879,
              GEL: 2.7,
              IDR: 16200,
              RUB: 71.811965,
              THB: 32.602547
            }
          };
        }
      };
    }
  });

  const rates = await provider.ratesFor(new Date("2026-06-02T10:00:00+07:00"));

  assert.equal(rates.source, "open-er-api:2026-06-02");
  assert.equal(rates.USD.THB, 32.602547);
  assert.equal(Math.round(rates.EUR.THB * 10000) / 10000, 37.0905);
  assert.equal(Math.round(rates.IDR.THB * 1000000) / 1000000, 0.002013);
  assert.equal(Math.round(rates.RUB.THB * 10000) / 10000, 0.4540);
  assert.equal(urls[0], "https://open.er-api.com/v6/latest/USD");
});

test("falls back to Frankfurter when Open ER API is unavailable", async () => {
  const provider = createExchangeRateProvider({
    async fetchImpl(url) {
      if (url.includes("open.er-api.com")) {
        return { ok: false, async json() { return {}; } };
      }
      return {
        ok: true,
        async json() {
          return {
            date: "2026-06-01",
            rates: {
              EUR: 0.88,
              IDR: 16000,
              THB: 32.555
            }
          };
        }
      };
    }
  });

  const rates = await provider.ratesFor(new Date("2026-06-02T10:00:00+07:00"));

  assert.equal(rates.source, "frankfurter:2026-06-01");
  assert.equal(rates.USD.THB, 32.555);
  assert.equal(Math.round(rates.EUR.THB * 10000) / 10000, 36.9943);
  assert.equal(Math.round(rates.IDR.THB * 1000000) / 1000000, 0.002035);
});

test("rate provider failures notify admins while falling back to manual rates", async () => {
  const alerts = [];
  const provider = createExchangeRateProvider({
    async fetchImpl() {
      throw new Error("rates provider unavailable");
    },
    adminAlertService: {
      async notifyAdminError(error, context) {
        alerts.push({ error, context });
      }
    }
  });

  const rates = await provider.ratesFor(new Date("2026-06-02T10:00:00+07:00"));

  assert.match(rates.source, /^manual-fallback:/);
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].error.message, "rates provider unavailable");
  assert.deepEqual(alerts[0].context, {
    source: "rates",
    operation: "open-er-api"
  });
  assert.deepEqual(alerts[1].context, {
    source: "rates",
    operation: "frankfurter"
  });
});

test("same-currency pair returns one without DB or provider access", async () => {
  let queries = 0;
  let fetches = 0;
  const provider = createExchangeRateProvider({
    pool: { async query() { queries += 1; return { rows: [] }; } },
    async fetchImpl() { fetches += 1; throw new Error("should not fetch"); }
  });

  const rate = await provider.getExchangeRate({
    date: new Date("2026-06-02T10:00:00+07:00"),
    baseCurrency: "usd",
    quoteCurrency: "USD"
  });

  assert.equal(rate.rate, 1);
  assert.equal(rate.source, "same-currency");
  assert.equal(queries, 0);
  assert.equal(fetches, 0);
});

test("exact DB pair-date cache hit does not call external provider", async () => {
  let fetches = 0;
  const store = createRateStore([
    { rate_date: "2026-06-02", base_currency: "USD", quote_currency: "THB", rate: "32.5", provider: "open-er-api:2026-06-02" }
  ]);
  const provider = createExchangeRateProvider({
    pool: store.pool,
    async fetchImpl() { fetches += 1; throw new Error("should not fetch"); }
  });

  const rate = await provider.getExchangeRate({
    date: "2026-06-02",
    baseCurrency: "usd",
    quoteCurrency: "thb"
  });

  assert.equal(rate.rate, 32.5);
  assert.equal(rate.source, "exchange-rate-cache:open-er-api:2026-06-02");
  assert.equal(fetches, 0);
});

test("provider success saves derived pair rates and next request uses DB cache", async () => {
  let fetches = 0;
  const store = createRateStore();
  const provider = createExchangeRateProvider({
    pool: store.pool,
    async fetchImpl(url) {
      fetches += 1;
      assert.match(String(url), /open\.er-api\.com/);
      return {
        ok: true,
        async json() {
          return {
            time_last_update_utc: "Tue, 02 Jun 2026 00:02:32 +0000",
            rates: {
              BYN: 3.25,
              EUR: 0.88,
              GEL: 2.7,
              IDR: 16200,
              RUB: 71.8,
              THB: 32.65
            }
          };
        }
      };
    }
  });

  const first = await provider.getExchangeRate({ date: "2026-06-02", baseCurrency: "USD", quoteCurrency: "THB" });
  const second = await provider.getExchangeRate({ date: "2026-06-02", baseCurrency: "USD", quoteCurrency: "THB" });

  assert.equal(first.rate, 32.65);
  assert.equal(second.rate, 32.65);
  assert.equal(fetches, 1);
  assert.equal(store.rowsFor("2026-06-02", "USD", "THB").length, 1);
});

test("provider success returns provider rate when DB cache save fails", async () => {
  const logs = [];
  const provider = createExchangeRateProvider({
    pool: createRateStore([], { failWrites: true }).pool,
    logger: { warn: (...args) => logs.push(args) },
    async fetchImpl() {
      return {
        ok: true,
        async json() {
          return {
            time_last_update_utc: "Tue, 02 Jun 2026 00:02:32 +0000",
            rates: {
              BYN: 3.25,
              EUR: 0.88,
              GEL: 2.7,
              IDR: 16200,
              RUB: 71.8,
              THB: 32.65
            }
          };
        }
      };
    }
  });

  const rate = await provider.getExchangeRate({ date: "2026-06-02", baseCurrency: "USD", quoteCurrency: "THB" });

  assert.equal(rate.rate, 32.65);
  assert.equal(rate.source, "open-er-api:2026-06-02");
  assert.ok(logs.some(([message, context]) => (
    message === "[rates] provider succeeded; cache persist failed"
      && context.baseCurrency === "USD"
      && context.quoteCurrency === "THB"
  )));
});

test("exact DB cache read failure logs and continues through provider", async () => {
  const logs = [];
  let fetches = 0;
  const provider = createExchangeRateProvider({
    pool: createRateStore([], { failExactReads: true }).pool,
    logger: { warn: (...args) => logs.push(args) },
    async fetchImpl() {
      fetches += 1;
      return {
        ok: true,
        async json() {
          return {
            time_last_update_utc: "Tue, 02 Jun 2026 00:02:32 +0000",
            rates: {
              BYN: 3.25,
              EUR: 0.88,
              GEL: 2.7,
              IDR: 16200,
              RUB: 71.8,
              THB: 32.65
            }
          };
        }
      };
    }
  });

  const rate = await provider.getExchangeRate({ date: "2026-06-02", baseCurrency: "USD", quoteCurrency: "THB" });

  assert.equal(rate.rate, 32.65);
  assert.equal(fetches, 1);
  assert.ok(logs.some(([message, context]) => (
    message === "[rates] exact cache read failed"
      && context.requestedDate === "2026-06-02"
      && context.baseCurrency === "USD"
      && context.quoteCurrency === "THB"
  )));
});

test("partial provider responses do not persist manual-derived pair rates", async () => {
  const logs = [];
  const store = createRateStore();
  const provider = createExchangeRateProvider({
    pool: store.pool,
    logger: { warn: (...args) => logs.push(args) },
    async fetchImpl() {
      return {
        ok: true,
        async json() {
          return {
            time_last_update_utc: "Tue, 02 Jun 2026 00:02:32 +0000",
            rates: {
              THB: 32.65
            }
          };
        }
      };
    }
  });

  const rate = await provider.getExchangeRate({ date: "2026-06-02", baseCurrency: "RUB", quoteCurrency: "THB" });

  assert.match(rate.source, /^manual-fallback:/);
  assert.equal(store.rowsFor("2026-06-02", "USD", "THB").length, 1);
  assert.equal(store.rowsFor("2026-06-02", "RUB", "THB").length, 0);
  assert.ok(logs.some(([message, context]) => (
    message === "[rates] provider response missing requested pair; using manual fallback"
      && context.baseCurrency === "RUB"
      && context.quoteCurrency === "THB"
  )));
});

test("provider failure uses latest prior DB rate before manual fallback", async () => {
  const logs = [];
  const store = createRateStore([
    { rate_date: "2026-06-01", base_currency: "USD", quote_currency: "THB", rate: "32.4", provider: "open-er-api:2026-06-01" },
    { rate_date: "2026-06-05", base_currency: "USD", quote_currency: "THB", rate: "33.0", provider: "open-er-api:2026-06-05" }
  ]);
  const provider = createExchangeRateProvider({
    pool: store.pool,
    logger: { warn: (...args) => logs.push(args) },
    async fetchImpl() {
      throw new Error("rates provider unavailable");
    }
  });

  const rate = await provider.getExchangeRate({ date: "2026-06-02", baseCurrency: "USD", quoteCurrency: "THB" });

  assert.equal(rate.rate, 32.4);
  assert.equal(rate.source, "exchange-rate-fallback:open-er-api:2026-06-01");
  assert.ok(logs.some(([message, context]) => message === "[rates] provider failed; using DB fallback" && context.fallbackUsed === true));
});

test("provider failure uses latest any-date DB rate when no prior rate exists", async () => {
  const store = createRateStore([
    { rate_date: "2026-06-05", base_currency: "USD", quote_currency: "THB", rate: "33.0", provider: "open-er-api:2026-06-05" }
  ]);
  const provider = createExchangeRateProvider({
    pool: store.pool,
    logger: { warn() {} },
    async fetchImpl() {
      throw new Error("rates provider unavailable");
    }
  });

  const rate = await provider.getExchangeRate({ date: "2026-06-02", baseCurrency: "USD", quoteCurrency: "THB" });

  assert.equal(rate.rate, 33.0);
  assert.equal(rate.source, "exchange-rate-fallback:open-er-api:2026-06-05");
});

test("provider and DB fallback failure uses existing manual fallback as degraded mode", async () => {
  const logs = [];
  const provider = createExchangeRateProvider({
    pool: createRateStore().pool,
    logger: { warn: (...args) => logs.push(args) },
    async fetchImpl() {
      throw new Error("rates provider unavailable");
    }
  });

  const rate = await provider.getExchangeRate({ date: "2026-06-02", baseCurrency: "USD", quoteCurrency: "THB" });

  assert.equal(rate.rate, 32.65);
  assert.match(rate.source, /^manual-fallback:/);
  assert.ok(logs.some(([message, context]) => message === "[rates] provider failed; using manual fallback" && context.fallbackUsed === "manual"));
});

test("provider failure falls through to manual fallback when fallback DB read fails", async () => {
  const logs = [];
  const provider = createExchangeRateProvider({
    pool: createRateStore([], { failFallbackReads: true }).pool,
    logger: { warn: (...args) => logs.push(args) },
    async fetchImpl() {
      throw new Error("rates provider unavailable");
    }
  });

  const rate = await provider.getExchangeRate({ date: "2026-06-02", baseCurrency: "USD", quoteCurrency: "THB" });

  assert.equal(rate.rate, 32.65);
  assert.match(rate.source, /^manual-fallback:/);
  assert.ok(logs.some(([message, context]) => (
    message === "[rates] fallback cache read failed"
      && context.requestedDate === "2026-06-02"
      && context.baseCurrency === "USD"
      && context.quoteCurrency === "THB"
  )));
});

test("provider and fallback failure can return controlled exchange-rate error", async () => {
  const provider = createExchangeRateProvider({
    pool: createRateStore().pool,
    manualFallbackEnabled: false,
    logger: { warn() {} },
    async fetchImpl() {
      throw new Error("rates provider unavailable");
    }
  });

  await assert.rejects(
    () => provider.getExchangeRate({ date: "2026-06-02", baseCurrency: "USD", quoteCurrency: "THB" }),
    (error) => error.name === "ExchangeRateUnavailableError" && error.code === "exchange_rate_unavailable"
  );
});

test("unknown currency returns a controlled exchange-rate error", async () => {
  const provider = createExchangeRateProvider({
    pool: createRateStore().pool,
    async fetchImpl() {
      throw new Error("should not fetch");
    }
  });

  await assert.rejects(
    () => provider.getExchangeRate({ date: "2026-06-02", baseCurrency: "DOGE", quoteCurrency: "THB" }),
    (error) => error.name === "ExchangeRateUnavailableError" && error.code === "exchange_rate_unavailable"
  );
});

test("a provider omission for an expanded currency never becomes a manual rate", async () => {
  const provider = createExchangeRateProvider({
    pool: createRateStore().pool,
    logger: { warn() {} },
    async fetchImpl() {
      return { ok: true, async json() { return { rates: { THB: 32.65 } }; } };
    }
  });

  await assert.rejects(
    () => provider.getExchangeRate({ date: "2026-06-02", baseCurrency: "INR", quoteCurrency: "THB" }),
    (error) => error.name === "ExchangeRateUnavailableError" && error.code === "exchange_rate_unavailable"
  );
});

function createRateStore(initialRows = [], options = {}) {
  const rows = initialRows.map(normalizeRow);
  return {
    pool: {
      async query(sql, params = []) {
        const query = String(sql);
        if (query.includes("FROM exchange_rates") && query.includes("rate_date = $1")) {
          if (options.failExactReads) throw new Error("cache read failed");
          return { rows: rows.filter((row) => row.rate_date === params[0] && row.base_currency === params[1] && row.quote_currency === params[2]) };
        }
        if (query.includes("FROM exchange_rates") && query.includes("rate_date <= $3")) {
          if (options.failFallbackReads) throw new Error("fallback cache read failed");
          const matches = rows
            .filter((row) => row.base_currency === params[0] && row.quote_currency === params[1] && row.rate_date <= params[2])
            .sort((left, right) => right.rate_date.localeCompare(left.rate_date));
          return { rows: matches.slice(0, 1) };
        }
        if (query.includes("FROM exchange_rates") && query.includes("ORDER BY rate_date DESC")) {
          const matches = rows
            .filter((row) => row.base_currency === params[0] && row.quote_currency === params[1])
            .sort((left, right) => right.rate_date.localeCompare(left.rate_date));
          return { rows: matches.slice(0, 1) };
        }
        if (query.includes("INSERT INTO exchange_rates")) {
          if (options.failWrites) throw new Error("cache write failed");
          const row = normalizeRow({
            rate_date: params[0],
            base_currency: params[1],
            quote_currency: params[2],
            rate: params[3],
            provider: params[4]
          });
          const existingIndex = rows.findIndex((existing) => (
            existing.rate_date === row.rate_date
              && existing.base_currency === row.base_currency
              && existing.quote_currency === row.quote_currency
          ));
          if (existingIndex >= 0) rows[existingIndex] = row;
          else rows.push(row);
          return { rows: [row] };
        }
        throw new Error(`unexpected query: ${query}`);
      }
    },
    rowsFor(rateDate, baseCurrency, quoteCurrency) {
      return rows.filter((row) => row.rate_date === rateDate && row.base_currency === baseCurrency && row.quote_currency === quoteCurrency);
    }
  };
}

function normalizeRow(row) {
  return {
    rate_date: row.rate_date,
    base_currency: String(row.base_currency).toUpperCase(),
    quote_currency: String(row.quote_currency).toUpperCase(),
    rate: String(row.rate),
    provider: row.provider,
    created_at: row.created_at ?? new Date("2026-06-02T00:00:00Z"),
    updated_at: row.updated_at ?? new Date("2026-06-02T00:00:00Z")
  };
}
