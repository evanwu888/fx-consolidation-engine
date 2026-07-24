/**
 * Currency Exchange Rates API Service
 * 
 * Fetches exchange rates from CurrencyLayer API
 * https://currencylayer.com/documentation
 */

import axios from 'axios';

const CURRENCY_API_ENDPOINT = process.env.CURRENCY_API_ENDPOINT || 'https://api.currencylayer.com';

/**
 * Get the CurrencyLayer API key from the environment.
 * Set CURRENCY_API_KEY in a local .env file (never commit keys).
 */
function getCurrencyApiKey(): string {
  return process.env.CURRENCY_API_KEY || '';
}

// Default currency pairs (backward compat). Use fetchExchangeRatesForCurrencies for dynamic lists.
const DEFAULT_CURRENCIES = ['USD', 'EUR', 'CNY'];

/**
 * Result cache: historical rates never change, so successful responses are cached
 * for the process lifetime.  Failed requests are cached for a cooldown period to
 * prevent burst retries from callers (like ingestion retry loops) from hitting the API.
 */
const rateCache = new Map<string, Promise<ExchangeRate[]>>();

function buildCacheKey(currencies: string[], date: string): string {
  return `${[...currencies].sort().join(',')}:${date}`;
}

/** Cooldown before a failed cache entry is evicted (seconds). */
const FAILURE_COOLDOWN_MS = 30_000;

export interface ExchangeRate {
  from_currency: string;
  to_currency: string;
  rate_date: string; // ISO date
  exchange_rate: number;
  inverse_rate: number;
}

/**
 * Fetch exchange rates for a dynamic set of currencies using a single USD-based API call.
 * Computes all N×N cross rates via USD triangulation, minimising API calls.
 *
 * Callers are deduplicated: concurrent or sequential requests for the same currencies+date
 * share a single API call. Successful results are cached for the process lifetime.
 * Failed results are cached for a cooldown period to prevent burst retries.
 * The underlying HTTP call includes retry-with-backoff for 429 errors.
 *
 * @param currencies Array of ISO 4217 codes (must include at least one non-USD currency)
 * @param date Optional YYYY-MM-DD (default: yesterday)
 */
export async function fetchExchangeRatesForCurrencies(
  currencies: string[],
  date?: string,
): Promise<ExchangeRate[]> {
  const targetDate = date || getYesterdayDate();
  const unique = [...new Set(currencies.map((c) => c.toUpperCase()))];

  // Always ensure USD is present for triangulation
  if (!unique.includes('USD')) unique.push('USD');

  const nonUsd = unique.filter((c) => c !== 'USD');
  if (nonUsd.length === 0) {
    // Only USD — return identity
    return [{ from_currency: 'USD', to_currency: 'USD', rate_date: targetDate, exchange_rate: 1, inverse_rate: 1 }];
  }

  const cacheKey = buildCacheKey(unique, targetDate);

  // Return cached result — whether resolved, rejected, or still in-flight
  const cached = rateCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Create the request promise up-front so all callers share it
  const request = fetchExchangeRatesCore(unique, nonUsd, targetDate);
  rateCache.set(cacheKey, request);

  // On failure, keep the rejected promise cached for a cooldown period so that
  // callers with their own retry loops (e.g. ingestion) don't hammer the API.
  request.catch(() => {
    setTimeout(() => rateCache.delete(cacheKey), FAILURE_COOLDOWN_MS);
  });

  return request;
}

async function fetchExchangeRatesCore(
  unique: string[],
  nonUsd: string[],
  targetDate: string,
): Promise<ExchangeRate[]> {
  console.log(`[CurrencyAPI] Fetching rates for ${unique.length} currencies (${unique.join(',')}) on ${targetDate}`);

  // Single API call: USD → all others (includes retry-with-backoff for 429)
  const usdQuotes = await fetchRatesForBaseCurrency('USD', targetDate, nonUsd);

  // Build USD→X map
  const usdToX = new Map<string, number>();
  usdToX.set('USD', 1);
  for (const code of nonUsd) {
    const key = `USD${code}`;
    if (usdQuotes[key] !== undefined) {
      usdToX.set(code, usdQuotes[key]);
    }
  }

  // Generate all pairs including identity
  const allRates: ExchangeRate[] = [];
  for (const from of unique) {
    const fromRate = usdToX.get(from);
    // Skip if rate is undefined, zero, or non-finite (prevents division by zero → Infinity)
    if (fromRate === undefined || !Number.isFinite(fromRate) || fromRate === 0) continue;
    for (const to of unique) {
      const toRate = usdToX.get(to);
      if (toRate === undefined || !Number.isFinite(toRate)) continue;
      // Cross rate: (USD→to) / (USD→from)
      const rate = toRate / fromRate;
      const inverseRate = 1 / rate;
      // Skip pairs where cross-rate or inverse are not finite (extra safety net)
      if (!Number.isFinite(rate) || !Number.isFinite(inverseRate)) continue;
      allRates.push({
        from_currency: from,
        to_currency: to,
        rate_date: targetDate,
        exchange_rate: rate,
        inverse_rate: inverseRate,
      });
    }
  }

  console.log(`[CurrencyAPI] Computed ${allRates.length} cross-rate pairs from 1 API call`);
  return allRates;
}

/**
 * Fetch latest exchange rates from CurrencyLayer API (legacy: USD, EUR, CNY only).
 * Prefer fetchExchangeRatesForCurrencies for dynamic currency support.
 */
export async function fetchExchangeRates(date?: string): Promise<ExchangeRate[]> {
  return fetchExchangeRatesForCurrencies(DEFAULT_CURRENCIES, date);
}

/**
 * Fetch rates for a specific base currency with retry-and-backoff for 429 errors.
 * @param baseCurrency Base currency code (e.g. 'USD')
 * @param date Target date in YYYY-MM-DD format
 * @param targets Target currency codes to fetch rates for
 * @returns Object with currency pair rates (e.g., { USDEUR: 0.92, USDCNY: 7.2 })
 */
async function fetchRatesForBaseCurrency(
  baseCurrency: string,
  date: string,
  targets?: string[],
): Promise<Record<string, number>> {
  const targetCurrencies = targets
    ? targets.filter((c) => c !== baseCurrency).join(',')
    : DEFAULT_CURRENCIES.filter((c) => c !== baseCurrency).join(',');

  // Use historical endpoint for past dates
  const endpoint = `${CURRENCY_API_ENDPOINT}/historical`;
  const apiKey = getCurrencyApiKey();
  if (!apiKey) {
    throw new Error('currencyApiKey is not configured');
  }
  
  const params = {
    access_key: apiKey,
    date: date,
    source: baseCurrency,
    currencies: targetCurrencies,
  };

  const MAX_RETRIES = 3;
  const BACKOFF_BASE_MS = 2_000;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get(endpoint, { params });

      if (!response.data.success) {
        throw new Error(
          `CurrencyLayer API error: ${response.data.error?.info || 'Unknown error'}`
        );
      }

      return response.data.quotes as Record<string, number>;
    } catch (error: any) {
      lastError = error;
      const status = error?.response?.status;
      if (status === 429 && attempt < MAX_RETRIES) {
        const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
        console.warn(`[CurrencyAPI] 429 rate-limited (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw error;
    }
  }

  throw lastError!;
}

/**
 * Get yesterday's date in YYYY-MM-DD format
 * @returns Date string
 */
function getYesterdayDate(): string {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return yesterday.toISOString().split('T')[0];
}

/**
 * Convert an amount from one currency to another
 * @param amount Amount to convert
 * @param fromCurrency Source currency code
 * @param toCurrency Target currency code
 * @param rates Array of exchange rates
 * @returns Converted amount
 */
export function convertCurrency(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  rates: ExchangeRate[]
): number {
  if (fromCurrency === toCurrency) {
    return amount;
  }

  const rate = rates.find(
    (r) =>
      r.from_currency.toUpperCase() === fromCurrency.toUpperCase() &&
      r.to_currency.toUpperCase() === toCurrency.toUpperCase()
  );

  if (!rate) {
    throw new Error(`Exchange rate not found for ${fromCurrency} to ${toCurrency}`);
  }

  return amount * rate.exchange_rate;
}


