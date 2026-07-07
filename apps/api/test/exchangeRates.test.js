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
