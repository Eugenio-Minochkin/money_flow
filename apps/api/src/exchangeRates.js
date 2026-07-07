import { SUPPORTED_CURRENCIES, fallbackThbRate } from "../../../packages/shared/src/currencies.js";

const FRANKFURTER_URL = "https://api.frankfurter.dev/v1";
const OPEN_ER_API_URL = "https://open.er-api.com/v6/latest/USD";
const USD_THB_FALLBACK = fallbackThbRate("USD");
const NON_THB_CODES = SUPPORTED_CURRENCIES.map((currency) => currency.code).filter((code) => code !== "THB" && code !== "USD");
const RATE_CODES = ["THB", ...NON_THB_CODES];

export function createExchangeRateProvider(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const adminAlertService = options.adminAlertService ?? null;

  return {
    async ratesFor(date) {
      const rateDate = toDateString(date);
      if (typeof fetchImpl === "function") {
        try {
          const openResponse = await fetchImpl(OPEN_ER_API_URL);
          if (openResponse.ok) {
            const data = await openResponse.json();
            const rates = ratesFromUsdMap(data.rates ?? {});
            if (rates) return buildRates(`open-er-api:${toDateString(data.time_last_update_utc ?? date)}`, rates);
          }
        } catch (error) {
          await notifyRatesError(adminAlertService, error, "open-er-api");
          // Try Frankfurter below before falling back to manual values.
        }

        try {
          const response = await fetchImpl(`${FRANKFURTER_URL}/${rateDate}?base=USD&symbols=${RATE_CODES.join(",")}`);
          if (response.ok) {
            const data = await response.json();
            const rates = ratesFromUsdMap(data.rates ?? {});
            if (rates) return buildRates(`frankfurter:${data.date ?? rateDate}`, rates);
          }
        } catch (error) {
          await notifyRatesError(adminAlertService, error, "frankfurter");
          // Fallback below keeps expense entry available when the rate API is down.
        }
      }
      return fallbackRates(rateDate);
    }
  };
}

async function notifyRatesError(adminAlertService, error, operation) {
  try {
    await adminAlertService?.notifyAdminError?.(error, {
      source: "rates",
      operation
    });
  } catch {
    // Rate lookup must still fall back to manual rates if alerting itself fails.
  }
}

export function fallbackRates(date = new Date()) {
  return buildRates(`manual-fallback:${toDateString(date)}`, fallbackUsdRates());
}

function ratesFromUsdMap(map) {
  const usdThb = Number(map.THB);
  if (!Number.isFinite(usdThb) || usdThb <= 0) return null;
  const rates = { THB: usdThb, USD: 1 };
  for (const code of NON_THB_CODES) {
    const value = Number(map[code]);
    rates[code] = Number.isFinite(value) && value > 0 ? value : usdThb / fallbackThbRate(code);
  }
  return rates;
}

function fallbackUsdRates() {
  const rates = { THB: USD_THB_FALLBACK, USD: 1 };
  for (const code of NON_THB_CODES) {
    rates[code] = USD_THB_FALLBACK / fallbackThbRate(code);
  }
  return rates;
}

function buildRates(source, usdRates) {
  const usdThb = Number(usdRates.THB);
  const rates = {
    source,
    THB: { THB: 1 },
    USD: { THB: usdThb }
  };
  for (const code of NON_THB_CODES) {
    rates[code] = { THB: usdThb / Number(usdRates[code]) };
  }
  return rates;
}

function toDateString(date) {
  return new Date(date).toISOString().slice(0, 10);
}
