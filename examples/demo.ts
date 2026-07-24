/**
 * Demo: resolve FX rates (direct, inverse, triangulated) and run a
 * two-level NAV waterfall on a small mock fund structure.
 *
 * Run with: npx tsx examples/demo.ts
 * No API key needed - all rates are seeded in memory.
 */
import { InMemoryRateStore, resolveExchangeRatesForPairs } from '../src/fxRateResolver.js';
import { computeWaterfallFromLoadedData } from '../src/waterfall.js';

async function main() {
  // --- 1. Seed a rate store with mock vendor rates (as of 2026-06-30) ---
  const store = new InMemoryRateStore();
  store.seed([
    { fromCurrency: 'EUR', toCurrency: 'USD', rateDate: '2026-06-30', rateType: 'spot', exchangeRate: 1.08, inverseRate: 1 / 1.08 },
    { fromCurrency: 'USD', toCurrency: 'JPY', rateDate: '2026-06-30', rateType: 'spot', exchangeRate: 158.0, inverseRate: 1 / 158.0 },
    { fromCurrency: 'USD', toCurrency: 'SGD', rateDate: '2026-06-27', rateType: 'spot', exchangeRate: 1.35, inverseRate: 1 / 1.35 },
  ]);

  // --- 2. Resolve every pair the waterfall will need ---
  // EUR->JPY has no direct quote: resolver triangulates (EUR->USD) x (USD->JPY).
  // SGD->USD is only stored as USD->SGD: resolver uses the stored inverse.
  const { rateMap, ratesUsed } = await resolveExchangeRatesForPairs(
    store,
    [
      { from: 'EUR', to: 'USD' },
      { from: 'JPY', to: 'USD' },
      { from: 'SGD', to: 'USD' },
    ],
    '2026-06-30',
    'spot',
    { allowFetch: false },
  );

  console.log('Resolved rates:');
  for (const rate of ratesUsed) {
    console.log(`  ${rate.fromCurrency}->${rate.toCurrency} = ${rate.rate.toFixed(6)} (${rate.method}, ${rate.rateDate})${rate.warning ? ' WARNING: ' + rate.warning : ''}`);
  }

  // --- 3. Mock fund structure: USD fund -> EU SPV -> two portcos ---
  const result = computeWaterfallFromLoadedData({
    asOfDate: '2026-06-30',
    fxRateType: 'spot',
    fundCurrency: 'USD',
    entities: [
      { entityId: 'fund-1', name: 'Global Fund I', entityType: 'fund_root', currency: 'USD' },
      { entityId: 'spv-eu', name: 'European Holdings SPV', entityType: 'spv', currency: 'EUR' },
      { entityId: 'pc-1', name: 'PortCo Alpha (EUR)', entityType: 'portco', currency: 'EUR' },
      { entityId: 'pc-2', name: 'PortCo Beta (JPY)', entityType: 'portco', currency: 'JPY' },
    ],
    ownership: [
      { parentEntityId: 'fund-1', childEntityId: 'spv-eu', ownershipPct: '100' },
      { parentEntityId: 'spv-eu', childEntityId: 'pc-1', ownershipPct: '80' },
      { parentEntityId: 'spv-eu', childEntityId: 'pc-2', ownershipPct: '60' },
    ],
    valuations: [
      { entityId: 'pc-1', asOfDate: '2026-06-30', enterpriseValue: '50000000', netDebt: '10000000', equityValue: '40000000', currency: 'EUR' },
      { entityId: 'pc-2', asOfDate: '2026-06-30', enterpriseValue: '9000000000', netDebt: '1000000000', equityValue: '8000000000', currency: 'JPY' },
    ],
    debtRows: [
      { entityId: 'spv-eu', outstandingAmount: '5000000', currency: 'EUR' },
    ],
    adjustmentRows: [],
    rateMap: new Map([
      ['IDENTITY', 1.0],
      ['EUR-USD', 1.08],
      ['JPY-USD', 1 / 158.0],
      ['JPY-EUR', (1 / 158.0) / 1.08],
      ['EUR-EUR', 1.0],
    ]),
    ratesUsed,
  });

  console.log('\nWaterfall result:');
  console.log(`  Fund NAV (${result.fundCurrency}): ${result.fundNav.toLocaleString()}`);
  console.log(`  Gross portfolio value: ${result.grossPortfolioValue.toLocaleString()}`);
  console.log(`  SPV-level debt: ${result.spvLevelDebt.toLocaleString()}`);
  for (const entity of result.perEntity) {
    console.log(`  ${entity.entityName}: equity=${entity.equityValue?.toLocaleString() ?? 'n/a'} ${entity.currency}, converted=${entity.convertedEquity.toLocaleString()}, attributable=${entity.attributableValue.toLocaleString()}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
