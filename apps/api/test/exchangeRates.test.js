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
});
