const FRANKFURTER_URL = "https://api.frankfurter.dev/v1";
const OPEN_ER_API_URL = "https://open.er-api.com/v6/latest/USD";
const FALLBACK_USD_THB = 32.65;
const FALLBACK_USD_RUB = 71.8;
const FALLBACK_RUB_THB = FALLBACK_USD_THB / FALLBACK_USD_RUB;

export function createExchangeRateProvider(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    async ratesFor(date) {
      const rateDate = toDateString(date);
      if (typeof fetchImpl === "function") {
        try {
          const openResponse = await fetchImpl(OPEN_ER_API_URL);
          if (openResponse.ok) {
            const data = await openResponse.json();
            const usdThb = Number(data.rates?.THB);
            const usdRub = Number(data.rates?.RUB);
            if (Number.isFinite(usdThb) && usdThb > 0 && Number.isFinite(usdRub) && usdRub > 0) {
              return buildRates(`open-er-api:${toDateString(data.time_last_update_utc ?? date)}`, usdThb, usdRub);
            }
          }
        } catch {
          // Try Frankfurter below before falling back to manual values.
        }

        try {
          const response = await fetchImpl(`${FRANKFURTER_URL}/${rateDate}?base=USD&symbols=THB,RUB`);
          if (response.ok) {
            const data = await response.json();
            const usdThb = Number(data.rates?.THB);
            const usdRub = Number(data.rates?.RUB);
            if (Number.isFinite(usdThb) && usdThb > 0) {
              return buildRates(`frankfurter:${data.date ?? rateDate}`, usdThb, usdRub);
            }
          }
        } catch {
          // Fallback below keeps expense entry available when the rate API is down.
        }
      }
      return fallbackRates(rateDate);
    }
  };
}

export function fallbackRates(date = new Date()) {
  return buildRates(`manual-fallback:${toDateString(date)}`, FALLBACK_USD_THB, FALLBACK_USD_RUB);
}

function buildRates(source, usdThb, usdRub) {
  return {
    source,
    USD: { THB: usdThb },
    RUB: { THB: Number.isFinite(usdRub) && usdRub > 0 ? usdThb / usdRub : FALLBACK_RUB_THB },
    THB: { THB: 1 }
  };
}

function toDateString(date) {
  return new Date(date).toISOString().slice(0, 10);
}
