const FRANKFURTER_URL = "https://api.frankfurter.dev/v1";
const FALLBACK_USD_THB = 32.65;
const FALLBACK_RUB_THB = 0.36;

export function createExchangeRateProvider(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    async ratesFor(date) {
      const rateDate = toDateString(date);
      if (typeof fetchImpl === "function") {
        try {
          const response = await fetchImpl(`${FRANKFURTER_URL}/${rateDate}?base=USD&symbols=THB,RUB`);
          if (response.ok) {
            const data = await response.json();
            const usdThb = Number(data.rates?.THB);
            const usdRub = Number(data.rates?.RUB);
            if (Number.isFinite(usdThb) && usdThb > 0) {
              return {
                source: `frankfurter:${data.date ?? rateDate}`,
                USD: { THB: usdThb },
                RUB: { THB: Number.isFinite(usdRub) && usdRub > 0 ? usdThb / usdRub : FALLBACK_RUB_THB },
                THB: { THB: 1 }
              };
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
  return {
    source: `manual-fallback:${toDateString(date)}`,
    USD: { THB: FALLBACK_USD_THB },
    RUB: { THB: FALLBACK_RUB_THB },
    THB: { THB: 1 }
  };
}

function toDateString(date) {
  return new Date(date).toISOString().slice(0, 10);
}
