/**
 * FX Rate Resolution Service
 *
 * Resolves exchange rates for multi-currency waterfall computation.
 * Supports direct rate lookup and USD triangulation for exotic pairs.
 *
 * Storage is abstracted behind the RateStore interface so the resolver can run
 * against any backend (in production, a Postgres table of vendor rates with
 * soft-update history; here, an in-memory store for demonstration).
 */

import { fetchExchangeRatesForCurrencies, type ExchangeRate } from './currencyAPI.js';

export type FxRateType = 'spot';

const FX_STALE_DAYS_THRESHOLD = Number.parseInt(process.env.FX_STALE_DAYS_THRESHOLD ?? '7', 10);
const FX_TRIANGULATION_MAX_DATE_DIFF_DAYS = Number.parseInt(process.env.FX_TRIANGULATION_MAX_DATE_DIFF_DAYS ?? '0', 10);
const FX_STRICT_TRIANGULATION_DATE_MATCH = (process.env.FX_STRICT_TRIANGULATION_DATE_MATCH ?? 'false').toLowerCase() === 'true';

export type ResolvedRate = {
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  rateDate: string;
  rateType: FxRateType;
  method: 'identity' | 'direct' | 'triangulated';
  isStale?: boolean;
  staleDays?: number;
  warning?: string;
};

export type StoredRate = {
  fromCurrency: string;
  toCurrency: string;
  rateDate: string; // ISO date
  rateType: FxRateType;
  exchangeRate: number;
  inverseRate: number;
};

/**
 * Persistence abstraction for FX rates.
 * `getLatestRate` must return the most recent rate for the pair with
 * rateDate <= asOfDate, or null if none exists.
 */
export interface RateStore {
  getLatestRate(from: string, to: string, asOfDate: string, rateType: FxRateType): Promise<StoredRate | null>;
  saveRates(rates: StoredRate[]): Promise<void>;
}

/**
 * Simple in-memory RateStore used by the demo and tests.
 * Production uses a database-backed implementation with soft-update history
 * (is_current flags + effective date ranges) for a full audit trail.
 */
export class InMemoryRateStore implements RateStore {
  private rates: StoredRate[] = [];

  async getLatestRate(from: string, to: string, asOfDate: string, rateType: FxRateType): Promise<StoredRate | null> {
    const candidates = this.rates
      .filter((r) =>
        r.fromCurrency === from
        && r.toCurrency === to
        && r.rateType === rateType
        && r.rateDate <= asOfDate)
      .sort((a, b) => (a.rateDate < b.rateDate ? 1 : -1));
    return candidates[0] ?? null;
  }

  async saveRates(rates: StoredRate[]): Promise<void> {
    // Last write wins for the same (pair, date, type)
    for (const rate of rates) {
      this.rates = this.rates.filter((r) =>
        !(r.fromCurrency === rate.fromCurrency
          && r.toCurrency === rate.toCurrency
          && r.rateDate === rate.rateDate
          && r.rateType === rate.rateType));
      this.rates.push(rate);
    }
  }

  seed(rates: StoredRate[]): void {
    this.rates.push(...rates);
  }
}

function parseIsoDateOrNull(value: string): Date | null {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function daysBetween(asOfDate: string, rateDate: string): number {
  const asOf = parseIsoDateOrNull(asOfDate);
  const rate = parseIsoDateOrNull(rateDate);
  if (!asOf || !rate) return 0;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.floor((asOf.getTime() - rate.getTime()) / msPerDay));
}

function absoluteDayDiff(leftDate: string, rightDate: string): number {
  const left = parseIsoDateOrNull(leftDate);
  const right = parseIsoDateOrNull(rightDate);
  if (!left || !right) return 0;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor(Math.abs(left.getTime() - right.getTime()) / msPerDay);
}

function buildResolvedRate(input: {
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  rateDate: string;
  rateType: FxRateType;
  method: 'identity' | 'direct' | 'triangulated';
  asOfDate: string;
  warning?: string;
}): ResolvedRate {
  const staleDays = daysBetween(input.asOfDate, input.rateDate);
  return {
    fromCurrency: input.fromCurrency,
    toCurrency: input.toCurrency,
    rate: input.rate,
    rateDate: input.rateDate,
    rateType: input.rateType,
    method: input.method,
    isStale: staleDays > FX_STALE_DAYS_THRESHOLD,
    staleDays,
    warning: input.warning,
  };
}

function assertPositiveRate(rate: number, context: string): number {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`Invalid FX rate (${context}): ${rate}`);
  }
  return rate;
}

function getFxFetchDate(asOfDate: string): string {
  const requested = new Date(`${asOfDate}T00:00:00Z`);
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  yesterday.setUTCHours(0, 0, 0, 0);

  if (Number.isNaN(requested.getTime())) {
    return yesterday.toISOString().slice(0, 10);
  }

  return (requested <= yesterday ? requested : yesterday).toISOString().slice(0, 10);
}

async function ensureSpotRatesAvailable(store: RateStore, currencies: string[], asOfDate: string): Promise<void> {
  const targetDate = getFxFetchDate(asOfDate);
  const unique = [...new Set(currencies.map((currency) => currency.toUpperCase()).filter(Boolean))];
  if (unique.length === 0) return;

  const fetched: ExchangeRate[] = await fetchExchangeRatesForCurrencies(unique, targetDate);
  if (fetched.length === 0) return;

  await store.saveRates(fetched.map((rate) => ({
    fromCurrency: rate.from_currency.toUpperCase(),
    toCurrency: rate.to_currency.toUpperCase(),
    rateDate: rate.rate_date,
    rateType: 'spot' as const,
    exchangeRate: rate.exchange_rate,
    inverseRate: rate.inverse_rate,
  })));
}

/**
 * Resolve a single exchange rate for a currency pair.
 *
 * Strategy:
 *   1. Same currency -> 1.0
 *   2. Direct lookup from the rate store (closest date <= asOfDate)
 *   3. Inverse lookup (stored to->from), using the stored inverse rate rather
 *      than recomputing 1/rate, to avoid compounding precision loss
 *   4. Optionally backfill from the rates API, then retry the store
 *   5. Triangulate through USD: (from->USD) x (USD->to), with configurable
 *      strictness on leg value-date mismatches
 *   6. Throw if no rate can be resolved
 */
export async function resolveExchangeRate(
  store: RateStore,
  fromCurrency: string,
  toCurrency: string,
  asOfDate: string,
  rateType: FxRateType,
  options?: { allowFetch?: boolean },
): Promise<ResolvedRate> {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();

  if (rateType !== 'spot') {
    throw new Error(`Unsupported FX rate type '${rateType}'. Only 'spot' is supported end-to-end.`);
  }

  if (from === to) {
    return buildResolvedRate({
      fromCurrency: from,
      toCurrency: to,
      rate: 1.0,
      rateDate: asOfDate,
      rateType,
      method: 'identity',
      asOfDate,
    });
  }

  const resolveFromStoredRates = async (): Promise<ResolvedRate | null> => {
    const direct = await store.getLatestRate(from, to, asOfDate, rateType);
    if (direct) {
      return buildResolvedRate({
        fromCurrency: from,
        toCurrency: to,
        rate: assertPositiveRate(direct.exchangeRate, `${from}->${to}`),
        rateDate: direct.rateDate,
        rateType,
        method: 'direct',
        asOfDate,
      });
    }

    // Inverse pair: use the vendor-stored inverse rate rather than computing
    // 1/rate locally. Repeated inversion of an already-rounded rate loses
    // precision; the stored inverse is computed once from the raw quote.
    const inverse = await store.getLatestRate(to, from, asOfDate, rateType);
    if (inverse) {
      return buildResolvedRate({
        fromCurrency: from,
        toCurrency: to,
        rate: assertPositiveRate(inverse.inverseRate, `${from}->${to} inverse`),
        rateDate: inverse.rateDate,
        rateType,
        method: 'direct',
        asOfDate,
      });
    }

    return null;
  };

  const storedRate = await resolveFromStoredRates();
  if (storedRate) {
    return storedRate;
  }

  const allowFetch = options?.allowFetch ?? true;

  if (rateType === 'spot' && allowFetch) {
    try {
      await ensureSpotRatesAvailable(store, [from, to], asOfDate);
      const refreshedRate = await resolveFromStoredRates();
      if (refreshedRate) {
        return refreshedRate;
      }
    } catch (error: any) {
      console.warn(`[FxRateResolver] Spot FX backfill failed for ${from}->${to} (${asOfDate}): ${error.message}`);
    }
  }

  // Triangulate through USD
  if (from !== 'USD' && to !== 'USD') {
    const [fromToUsd, usdToTarget] = await Promise.all([
      resolveExchangeRate(store, from, 'USD', asOfDate, rateType, options).catch(() => null),
      resolveExchangeRate(store, 'USD', to, asOfDate, rateType, options).catch(() => null),
    ]);

    if (fromToUsd && usdToTarget) {
      // The two legs may have been quoted on different dates (e.g. one pair
      // last updated Friday, the other Monday). Multiplying legs from
      // different value dates produces a rate that never existed in the
      // market, so mismatches are surfaced as warnings and can be made fatal
      // via FX_STRICT_TRIANGULATION_DATE_MATCH.
      const legDateDiffDays = absoluteDayDiff(fromToUsd.rateDate, usdToTarget.rateDate);
      const legDateWarning = fromToUsd.rateDate !== usdToTarget.rateDate
        ? `Triangulated FX leg dates differ (${fromToUsd.rateDate} vs ${usdToTarget.rateDate})`
        : undefined;

      if (
        fromToUsd.rateDate !== usdToTarget.rateDate
        && legDateDiffDays > FX_TRIANGULATION_MAX_DATE_DIFF_DAYS
        && FX_STRICT_TRIANGULATION_DATE_MATCH
      ) {
        throw new Error(
          `Triangulation date mismatch for ${from}->${to}: ${fromToUsd.rateDate} vs ${usdToTarget.rateDate}`,
        );
      }

      return buildResolvedRate({
        fromCurrency: from,
        toCurrency: to,
        rate: fromToUsd.rate * usdToTarget.rate,
        rateDate: fromToUsd.rateDate < usdToTarget.rateDate ? fromToUsd.rateDate : usdToTarget.rateDate,
        rateType,
        method: 'triangulated',
        asOfDate,
        warning: legDateWarning,
      });
    }
  }

  throw new Error(
    `No exchange rate found for ${from}->${to} (rate_type: ${rateType}, as_of: ${asOfDate}). ` +
    `Ensure the rate store has rates for this pair or USD triangulation is possible.`,
  );
}

/**
 * Batch-resolve all exchange rates needed for a set of currency pairs.
 * Returns a Map keyed by "FROM-TO" (uppercase) for O(1) lookup.
 *
 * Used by the waterfall computation to pre-resolve every rate the
 * consolidation will need before any math runs.
 */
export async function resolveExchangeRatesForPairs(
  store: RateStore,
  pairs: Array<{ from: string; to: string }>,
  asOfDate: string,
  rateType: FxRateType,
  options?: { allowFetch?: boolean; strictMissing?: boolean },
): Promise<{ rateMap: Map<string, number>; ratesUsed: ResolvedRate[] }> {
  const uniquePairs = new Map<string, { from: string; to: string }>();
  for (const pair of pairs) {
    const from = pair.from.toUpperCase();
    const to = pair.to.toUpperCase();
    if (from !== to) {
      uniquePairs.set(`${from}-${to}`, { from, to });
    }
  }

  const rateMap = new Map<string, number>();
  const ratesUsed: ResolvedRate[] = [];

  rateMap.set('IDENTITY', 1.0);

  for (const [key, pair] of uniquePairs) {
    try {
      const resolved = await resolveExchangeRate(store, pair.from, pair.to, asOfDate, rateType, options);
      rateMap.set(key, resolved.rate);
      ratesUsed.push(resolved);
    } catch (error: any) {
      if (options?.strictMissing) {
        throw new Error(
          `Missing FX rate for ${pair.from}->${pair.to} @ ${asOfDate} (type=${rateType}): ${error.message}`,
        );
      }
      console.warn(`[FxRateResolver] Rate unavailable for ${pair.from}->${pair.to} @ ${asOfDate}: ${error.message}`);
    }
  }

  return { rateMap, ratesUsed };
}

/**
 * Get the exchange rate from a pre-built rate map.
 * Returns 1.0 for same-currency pairs.
 */
export function getRateFromMap(
  rateMap: Map<string, number>,
  fromCurrency: string,
  toCurrency: string,
): number {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();

  if (from === to) return 1.0;

  const key = `${from}-${to}`;
  const rate = rateMap.get(key);

  if (rate === undefined) {
    throw new Error(`Exchange rate for ${from}->${to} not found in rate map. Was it pre-resolved?`);
  }

  return rate;
}
