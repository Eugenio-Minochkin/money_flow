import { SUPPORTED_CURRENCIES, SUPPORTED_CURRENCY_CODES, fallbackThbRate } from "../../../packages/shared/src/currencies.js";

const FRANKFURTER_URL = "https://api.frankfurter.dev/v1";
const OPEN_ER_API_URL = "https://open.er-api.com/v6/latest/USD";
const USD_THB_FALLBACK = fallbackThbRate("USD");
const NON_THB_CODES = SUPPORTED_CURRENCIES.map((currency) => currency.code).filter((code) => code !== "THB" && code !== "USD");
const RATE_CODES = ["THB", ...NON_THB_CODES];

export function createExchangeRateProvider(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const adminAlertService = options.adminAlertService ?? null;
  const pool = options.pool ?? null;
  const logger = options.logger ?? console;
  const manualFallbackEnabled = options.manualFallbackEnabled !== false;

  return {
    async getExchangeRate(input) {
      const rateDate = toDateString(input?.date ?? new Date());
      const baseCurrency = normalizeSupportedCurrency(input?.baseCurrency, "THB", "baseCurrency", rateDate);
      const quoteCurrency = normalizeSupportedCurrency(input?.quoteCurrency, "THB", "quoteCurrency", rateDate);

      if (baseCurrency === quoteCurrency) {
        return { rate: 1, source: "same-currency", rateDate, baseCurrency, quoteCurrency };
      }

      const exact = pool
        ? await safelyReadExactRate({ pool, logger, rateDate, baseCurrency, quoteCurrency })
        : null;
      if (exact) return exact;

      try {
        const providerRates = await fetchProviderRates({ fetchImpl, adminAlertService, rateDate });
        if (pool) await safelySaveDerivedRates({ pool, logger, rateDate, rates: providerRates, baseCurrency, quoteCurrency });
        if (isProviderCoveredPair(providerRates, baseCurrency, quoteCurrency)) {
          return {
            rate: pairRate(baseCurrency, quoteCurrency, providerRates),
            source: providerRates.source,
            rateDate,
            baseCurrency,
            quoteCurrency
          };
        }

        const fallback = pool
          ? await safelyReadFallbackRate({ pool, logger, rateDate, baseCurrency, quoteCurrency })
          : null;
        if (fallback) {
          logger.warn?.("[rates] provider response missing requested pair; using DB fallback", {
            provider: providerRates.source,
            requestedDate: rateDate,
            baseCurrency,
            quoteCurrency,
            fallbackUsed: true,
            fallbackDate: fallback.rateDate
          });
          return fallback;
        }

        if (manualFallbackEnabled) {
          const manualRates = fallbackRates(rateDate);
          logger.warn?.("[rates] provider response missing requested pair; using manual fallback", {
            provider: providerRates.source,
            requestedDate: rateDate,
            baseCurrency,
            quoteCurrency,
            fallbackUsed: "manual"
          });
          return {
            rate: pairRate(baseCurrency, quoteCurrency, manualRates),
            source: manualRates.source,
            rateDate,
            baseCurrency,
            quoteCurrency
          };
        }

        throw new ExchangeRateUnavailableError({
          rateDate,
          baseCurrency,
          quoteCurrency,
          cause: new Error("provider response missing requested pair")
        });
      } catch (error) {
        const fallback = pool
          ? await safelyReadFallbackRate({ pool, logger, rateDate, baseCurrency, quoteCurrency })
          : null;
        if (fallback) {
          logger.warn?.("[rates] provider failed; using DB fallback", {
            provider: "exchange-rate-provider",
            requestedDate: rateDate,
            baseCurrency,
            quoteCurrency,
            fallbackUsed: true,
            fallbackDate: fallback.rateDate,
            message: error.message
          });
          return fallback;
        }

        if (manualFallbackEnabled) {
          const manualRates = fallbackRates(rateDate);
          logger.warn?.("[rates] provider failed; using manual fallback", {
            provider: "manual-fallback",
            requestedDate: rateDate,
            baseCurrency,
            quoteCurrency,
            fallbackUsed: "manual",
            message: error.message
          });
          return {
            rate: pairRate(baseCurrency, quoteCurrency, manualRates),
            source: manualRates.source,
            rateDate,
            baseCurrency,
            quoteCurrency
          };
        }

        logger.warn?.("[rates] provider failed; no fallback available", {
          provider: "exchange-rate-provider",
          requestedDate: rateDate,
          baseCurrency,
          quoteCurrency,
          fallbackUsed: false,
          message: error.message
        });
        throw new ExchangeRateUnavailableError({ rateDate, baseCurrency, quoteCurrency, cause: error });
      }
    },

    async ratesFor(date) {
      const rateDate = toDateString(date);
      if (!pool) {
        try {
          return await fetchProviderRates({ fetchImpl, adminAlertService, rateDate });
        } catch (error) {
          if (!manualFallbackEnabled) throw new ExchangeRateUnavailableError({ rateDate, baseCurrency: "USD", quoteCurrency: "THB", cause: error });
          return fallbackRates(rateDate);
        }
      }

      const rates = { source: null, THB: { THB: 1 } };
      for (const code of SUPPORTED_CURRENCY_CODES.filter((currency) => currency !== "THB")) {
        const resolved = await this.getExchangeRate({ date: rateDate, baseCurrency: code, quoteCurrency: "THB" });
        rates[code] = { THB: resolved.rate };
        rates.source ??= resolved.source;
      }
      rates.source ??= "same-currency";
      return rates;
    }
  };
}

export class ExchangeRateUnavailableError extends Error {
  constructor({ rateDate, baseCurrency, quoteCurrency, cause }) {
    super("Exchange rate is unavailable", { cause });
    this.name = "ExchangeRateUnavailableError";
    this.code = "exchange_rate_unavailable";
    this.rateDate = rateDate;
    this.baseCurrency = baseCurrency;
    this.quoteCurrency = quoteCurrency;
  }
}

async function fetchProviderRates({ fetchImpl, adminAlertService, rateDate }) {
  if (typeof fetchImpl !== "function") {
    throw new Error("exchange rate provider is not configured");
  }

  try {
    const openResponse = await fetchImpl(OPEN_ER_API_URL);
    if (openResponse.ok) {
      const data = await openResponse.json();
      const rates = ratesFromUsdMap(data.rates ?? {});
      if (rates) return buildRates(`open-er-api:${toDateString(data.time_last_update_utc ?? rateDate)}`, rates);
    }
  } catch (error) {
    await notifyRatesError(adminAlertService, error, "open-er-api");
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
    throw error;
  }

  throw new Error("exchange rate provider returned no usable rates");
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
  const providerCurrencies = new Set(["THB", "USD"]);
  for (const code of NON_THB_CODES) {
    const value = Number(map[code]);
    if (Number.isFinite(value) && value > 0) {
      rates[code] = value;
      providerCurrencies.add(code);
    }
  }
  Object.defineProperty(rates, "providerCurrencies", {
    value: providerCurrencies,
    enumerable: false
  });
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
  const providerCurrencies = usdRates.providerCurrencies ?? new Set(SUPPORTED_CURRENCY_CODES);
  const rates = {
    source,
    THB: { THB: 1 },
    USD: { THB: usdThb }
  };
  for (const code of NON_THB_CODES) {
    if (Number.isFinite(Number(usdRates[code])) && Number(usdRates[code]) > 0) {
      rates[code] = { THB: usdThb / Number(usdRates[code]) };
    }
  }
  Object.defineProperty(rates, "providerCurrencies", {
    value: providerCurrencies,
    enumerable: false
  });
  return rates;
}

function pairRate(baseCurrency, quoteCurrency, rates) {
  if (baseCurrency === quoteCurrency) return 1;
  const baseThb = currencyThbRate(baseCurrency, rates);
  const quoteThb = currencyThbRate(quoteCurrency, rates);
  return baseThb / quoteThb;
}

function currencyThbRate(currency, rates = {}) {
  return Number(rates[currency]?.THB ?? fallbackThbRate(currency));
}

async function readExactRate(pool, rateDate, baseCurrency, quoteCurrency) {
  const result = await pool.query(
    `SELECT rate_date, base_currency, quote_currency, rate, provider
     FROM exchange_rates
     WHERE rate_date = $1
       AND base_currency = $2
       AND quote_currency = $3
     LIMIT 1`,
    [rateDate, baseCurrency, quoteCurrency]
  );
  return normalizeRateRow(result.rows[0], "exchange-rate-cache");
}

async function safelyReadExactRate({ pool, logger, rateDate, baseCurrency, quoteCurrency }) {
  try {
    return await readExactRate(pool, rateDate, baseCurrency, quoteCurrency);
  } catch (error) {
    logger.warn?.("[rates] exact cache read failed", {
      requestedDate: rateDate,
      baseCurrency,
      quoteCurrency,
      message: error.message
    });
    return null;
  }
}

async function readFallbackRate(pool, rateDate, baseCurrency, quoteCurrency) {
  const prior = await pool.query(
    `SELECT rate_date, base_currency, quote_currency, rate, provider
     FROM exchange_rates
     WHERE base_currency = $1
       AND quote_currency = $2
       AND rate_date <= $3
     ORDER BY rate_date DESC
     LIMIT 1`,
    [baseCurrency, quoteCurrency, rateDate]
  );
  if (prior.rows[0]) return normalizeRateRow(prior.rows[0], "exchange-rate-fallback");

  // Last degraded DB fallback: this may use a rate after the requested date.
  const anyDate = await pool.query(
    `SELECT rate_date, base_currency, quote_currency, rate, provider
     FROM exchange_rates
     WHERE base_currency = $1
       AND quote_currency = $2
     ORDER BY rate_date DESC
     LIMIT 1`,
    [baseCurrency, quoteCurrency]
  );
  return normalizeRateRow(anyDate.rows[0], "exchange-rate-fallback");
}

async function safelyReadFallbackRate({ pool, logger, rateDate, baseCurrency, quoteCurrency }) {
  try {
    return await readFallbackRate(pool, rateDate, baseCurrency, quoteCurrency);
  } catch (error) {
    logger.warn?.("[rates] fallback cache read failed", {
      requestedDate: rateDate,
      baseCurrency,
      quoteCurrency,
      message: error.message
    });
    return null;
  }
}

async function safelySaveDerivedRates({ pool, logger, rateDate, rates, baseCurrency, quoteCurrency }) {
  try {
    await saveDerivedRates(pool, rateDate, rates);
  } catch (error) {
    logger.warn?.("[rates] provider succeeded; cache persist failed", {
      provider: rates.source,
      requestedDate: rateDate,
      baseCurrency,
      quoteCurrency,
      message: error.message
    });
  }
}

async function saveDerivedRates(pool, rateDate, rates) {
  for (const baseCurrency of SUPPORTED_CURRENCY_CODES) {
    for (const quoteCurrency of SUPPORTED_CURRENCY_CODES) {
      if (baseCurrency === quoteCurrency) continue;
      if (!isProviderCoveredPair(rates, baseCurrency, quoteCurrency)) continue;
      await pool.query(
        `INSERT INTO exchange_rates (
           rate_date, base_currency, quote_currency, rate, provider, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (rate_date, base_currency, quote_currency)
         DO UPDATE SET rate = EXCLUDED.rate,
                       provider = EXCLUDED.provider,
                       updated_at = now()
         RETURNING rate_date, base_currency, quote_currency, rate, provider`,
        [rateDate, baseCurrency, quoteCurrency, pairRate(baseCurrency, quoteCurrency, rates), rates.source]
      );
    }
  }
}

function isProviderCoveredPair(rates, baseCurrency, quoteCurrency) {
  const providerCurrencies = rates.providerCurrencies ?? new Set(SUPPORTED_CURRENCY_CODES);
  return providerCurrencies.has(baseCurrency) && providerCurrencies.has(quoteCurrency);
}

function normalizeRateRow(row, sourcePrefix) {
  if (!row) return null;
  return {
    rate: Number(row.rate),
    source: `${sourcePrefix}:${row.provider}`,
    rateDate: toDateString(row.rate_date),
    baseCurrency: row.base_currency,
    quoteCurrency: row.quote_currency
  };
}

function normalizeSupportedCurrency(value, fallback, field, rateDate) {
  const currency = String(value || fallback).trim().toUpperCase();
  if (SUPPORTED_CURRENCY_CODES.includes(currency)) return currency;
  throw new ExchangeRateUnavailableError({
    rateDate,
    baseCurrency: field === "baseCurrency" ? currency : fallback,
    quoteCurrency: field === "quoteCurrency" ? currency : fallback,
    cause: new Error(`unsupported currency: ${currency}`)
  });
}

function toDateString(date) {
  return new Date(date).toISOString().slice(0, 10);
}
