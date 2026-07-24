/**
 * Multi-Currency NAV Waterfall
 *
 * Consolidates a fund's holding structure (Fund Root -> SPV -> PortCo, modeled
 * as a DAG) into a single fund-level NAV:
 *   - converts each entity's equity value into its parent's currency using
 *     pre-resolved FX rates (see fxRateResolver.ts)
 *   - rolls equity up ownership edges, weighting by ownership percentage
 *   - allocates SPV-level debt proportionally across children
 *   - applies entity-level valuation adjustments (percent or absolute)
 *
 * This module contains the pure computation core: it operates entirely on
 * pre-loaded, in-memory inputs and performs no I/O. In production the inputs
 * are loaded from a persistence layer by a thin wrapper (omitted here).
 */

import {
  type FxRateType,
  type ResolvedRate,
  getRateFromMap,
} from './fxRateResolver.js';

export type WaterfallEntityResult = {
  entityId: string;
  entityName: string;
  entityType: string;
  currency: string;
  displayCurrency: string;
  storedCurrency: string;
  enterpriseValue: number | null;
  netDebt: number | null;
  equityValue: number | null;
  displayEnterpriseValue: number | null;
  displayNetDebt: number | null;
  displayEquityValue: number | null;
  displayConvertedEquity: number | null;
  displayFxToFund: number | null;
  displayValuationDate: string | null;
  storedEnterpriseValue: number | null;
  storedNetDebt: number | null;
  storedEquityValue: number | null;
  storedValuationDate: string | null;
  parentEntityId: string | null;
  ownershipPct: number;
  adjustments: number;
  fxRate: number;
  convertedEquity: number;
  attributableValue: number;
};

export type WaterfallResult = {
  asOfDate: string;
  fxRateType: FxRateType;
  grossPortfolioValue: number;
  portfolioNetDebt: number;
  portfolioEquity: number;
  spvLevelDebt: number;
  totalAdjustments: number;
  fundNav: number;
  fundCurrency: string;
  perEntity: WaterfallEntityResult[];
  fxRatesUsed: ResolvedRate[];
};

type EntityValue = {
  enterpriseValue: number | null;
  netDebt: number | null;
  equityValue: number;
  adjustments: number;
  valuationDate: string;
  localCurrency: string;
};

type WaterfallEntityRow = {
  entityId: string;
  name: string;
  entityType: string;
  currency: string;
  companyId?: string | null;
};

type WaterfallOwnershipRow = {
  parentEntityId: string;
  childEntityId: string;
  ownershipPct: string;
};

type WaterfallValuationRow = {
  entityId: string;
  asOfDate: string;
  enterpriseValue: string | null;
  netDebt: string | null;
  equityValue: string | null;
  currency?: string;
};

type LatestKpiValuationRow = {
  company_id: string;
  latest_valuation_date: string | null;
  current_fair_value: string | null;
  current_fair_value_base_currency: string | null;
  investment_currency: string | null;
  fund_base_currency: string | null;
};

type LatestLocalDisplayRow = {
  entity_id: string;
  valuation_date: string | null;
  investment_currency: string | null;
  reporting_currency: string | null;
  fair_value_investment_currency: string | null;
  fair_value_fund_base_currency: string | null;
  fx_rate_to_fund_base: string | null;
  total_liabilities: string | null;
  cash_and_equivalents: string | null;
};

type DisplayValueRow = {
  ev: number | null;
  netDebt: number | null;
  equity: number | null;
  currency: string;
  asOfDate: string | null;
};

type DisplayConvertedRow = {
  convertedEquity: number | null;
  fxToFund: number | null;
};

type WaterfallDebtRow = {
  entityId: string;
  outstandingAmount: string;
  currency?: string;
};

type WaterfallAdjustmentRow = {
  entityId: string;
  adjustmentValue: string;
  adjustmentUnit: string;
  effectiveDate: string | null;
  currency?: string | null;
};

export function computeWaterfallFromLoadedData(input: {
  asOfDate: string;
  fxRateType: FxRateType;
  fundCurrency: string;
  entities: WaterfallEntityRow[];
  ownership: WaterfallOwnershipRow[];
  valuations: WaterfallValuationRow[];
  debtRows: WaterfallDebtRow[];
  adjustmentRows: WaterfallAdjustmentRow[];
  rateMap: Map<string, number>;
  ratesUsed: ResolvedRate[];
  datedRateMap?: Map<string, number>;
  childValuationDateByEntity?: Map<string, string>;
  exitedCompanyIds?: Set<string>;
  storedValuations?: WaterfallValuationRow[];
  localDisplayRows?: LatestLocalDisplayRow[];
  dashboardDisplayRows?: LatestKpiValuationRow[];
}): WaterfallResult {
  const {
    asOfDate,
    fxRateType,
    fundCurrency,
    rateMap,
    ratesUsed,
    datedRateMap,
    childValuationDateByEntity,
    exitedCompanyIds,
    storedValuations,
    localDisplayRows,
    dashboardDisplayRows,
  } = input;

  const emitWarning = (code: string, payload: Record<string, unknown>) => {
    console.warn('[WaterfallWarning]', JSON.stringify({ code, ...payload }));
  };

  let {
    entities,
    ownership,
    valuations,
    debtRows,
    adjustmentRows,
  } = input;

  const rootEntities = entities.filter((entity) => entity.entityType === 'fund_root');
  const rootIds = new Set(rootEntities.map((entity) => entity.entityId));

  if (rootIds.size > 0) {
    const reachable = new Set<string>();
    const queue = [...rootIds];

    while (queue.length > 0) {
      const entityId = queue.shift()!;
      if (reachable.has(entityId)) continue;
      reachable.add(entityId);

      for (const edge of ownership) {
        if (edge.parentEntityId === entityId && !reachable.has(edge.childEntityId)) {
          queue.push(edge.childEntityId);
        }
      }
    }

    entities = entities.filter((entity) => reachable.has(entity.entityId));
    ownership = ownership.filter((edge) => reachable.has(edge.parentEntityId) && reachable.has(edge.childEntityId));
    valuations = valuations.filter((row) => reachable.has(row.entityId));
    debtRows = debtRows.filter((row) => reachable.has(row.entityId));
    adjustmentRows = adjustmentRows.filter((row) => reachable.has(row.entityId));
  }

  const assertValidFxRate = (rate: number, context: Record<string, unknown>): number => {
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`Invalid FX rate in waterfall: ${JSON.stringify(context)}`);
    }
    return rate;
  };

  const resolveFxRate = (fromCurrency: string, toCurrency: string, anchorDate: string): number => {
    const from = fromCurrency.toUpperCase();
    const to = toCurrency.toUpperCase();
    if (from === to) return 1;

    const datedRate = datedRateMap?.get(`${from}-${to}@${anchorDate}`);
    if (datedRate != null) {
      return assertValidFxRate(datedRate, { from, to, anchorDate, source: 'datedRateMap' });
    }

    return assertValidFxRate(getRateFromMap(rateMap, from, to), { from, to, anchorDate, source: 'rateMap' });
  };

  const tryResolveFxRate = (fromCurrency: string, toCurrency: string, anchorDate: string): number | null => {
    try {
      return resolveFxRate(fromCurrency, toCurrency, anchorDate);
    } catch {
      return null;
    }
  };

  if (entities.length === 0) {
    return {
      asOfDate,
      fxRateType,
      grossPortfolioValue: 0,
      portfolioNetDebt: 0,
      portfolioEquity: 0,
      spvLevelDebt: 0,
      totalAdjustments: 0,
      fundNav: 0,
      fundCurrency,
      perEntity: [],
      fxRatesUsed: [],
    };
  }

  const entityById = new Map(entities.map((entity) => [entity.entityId, entity]));
  const entityByCompanyId = new Map(
    entities
      .filter((entity) => entity.entityType === 'portco' && !!entity.companyId)
      .map((entity) => [entity.companyId as string, entity]),
  );

  // Exited investments should retain valuation history but contribute 0% ownership
  // to the waterfall bridge and parent roll-up math.
  const isExitedPortco = (entityId: string): boolean => {
    if (!exitedCompanyIds || exitedCompanyIds.size === 0) return false;
    const entity = entityById.get(entityId);
    return entity?.entityType === 'portco' && !!entity.companyId && exitedCompanyIds.has(entity.companyId);
  };

  const getEffectiveOwnershipPct = (edge: WaterfallOwnershipRow): number => {
    if (isExitedPortco(edge.childEntityId)) return 0;
    const parsed = parseFloat(edge.ownershipPct);
    if (!Number.isFinite(parsed)) {
      emitWarning('INVALID_OWNERSHIP_NON_NUMERIC', {
        parentEntityId: edge.parentEntityId,
        childEntityId: edge.childEntityId,
        ownershipPct: edge.ownershipPct,
      });
      return 0;
    }
    if (parsed < 0 || parsed > 100) {
      emitWarning('INVALID_OWNERSHIP_OUT_OF_RANGE', {
        parentEntityId: edge.parentEntityId,
        childEntityId: edge.childEntityId,
        ownershipPct: parsed,
      });
      return 0;
    }
    return parsed;
  };

  const parentToChildren = new Map<string, Array<{ childId: string; ownershipPct: number }>>();
  const childToParents = new Map<string, Array<{ parentId: string; ownershipPct: number }>>();

  for (const edge of ownership) {
    const children = parentToChildren.get(edge.parentEntityId) ?? [];
    children.push({ childId: edge.childEntityId, ownershipPct: getEffectiveOwnershipPct(edge) });
    parentToChildren.set(edge.parentEntityId, children);

    const parents = childToParents.get(edge.childEntityId) ?? [];
    parents.push({ parentId: edge.parentEntityId, ownershipPct: getEffectiveOwnershipPct(edge) });
    childToParents.set(edge.childEntityId, parents);
  }

  const valuationMap = new Map<string, { ev: number | null; netDebt: number | null; equity: number | null; currency: string }>();
  for (const row of valuations) {
    if (valuationMap.has(row.entityId)) continue;
    valuationMap.set(row.entityId, {
      ev: row.enterpriseValue ? parseFloat(row.enterpriseValue) : null,
      netDebt: row.netDebt ? parseFloat(row.netDebt) : null,
      equity: row.equityValue ? parseFloat(row.equityValue) : null,
      currency: row.currency ?? (entityById.get(row.entityId)?.currency ?? fundCurrency),
    });
  }

  const storedValuationMap = new Map<string, { ev: number | null; netDebt: number | null; equity: number | null; currency: string; asOfDate: string | null }>();
  for (const row of storedValuations ?? valuations) {
    if (storedValuationMap.has(row.entityId)) continue;
    storedValuationMap.set(row.entityId, {
      ev: row.enterpriseValue ? parseFloat(row.enterpriseValue) : null,
      netDebt: row.netDebt ? parseFloat(row.netDebt) : null,
      equity: row.equityValue ? parseFloat(row.equityValue) : null,
      currency: row.currency ?? (entityById.get(row.entityId)?.currency ?? fundCurrency),
      asOfDate: row.asOfDate ?? null,
    });
  }

  const localDisplayMap = new Map<string, DisplayValueRow>();
  const localDisplayConvertedMap = new Map<string, DisplayConvertedRow>();
  for (const row of localDisplayRows ?? []) {
    if (localDisplayMap.has(row.entity_id)) continue;
    const entity = entityById.get(row.entity_id);
    const targetCurrency = entity?.entityType === 'portco'
      ? (entity.currency ?? fundCurrency)
      : (row.investment_currency ?? row.reporting_currency ?? entity?.currency ?? fundCurrency);
    const sourceCurrency = row.investment_currency ?? row.reporting_currency ?? targetCurrency;
    const anchorDate = row.valuation_date ?? asOfDate;
    const displayFx = tryResolveFxRate(sourceCurrency, targetCurrency, anchorDate);
    const fxRateToFundBase = row.fx_rate_to_fund_base ? parseFloat(row.fx_rate_to_fund_base) : null;
    const sourceEquity = row.fair_value_investment_currency
      ? parseFloat(row.fair_value_investment_currency)
      : row.fair_value_fund_base_currency && fxRateToFundBase != null && Math.abs(fxRateToFundBase) > 1e-9
      ? parseFloat(row.fair_value_fund_base_currency) / fxRateToFundBase
      : row.fair_value_fund_base_currency
      ? parseFloat(row.fair_value_fund_base_currency)
      : null;
    const equityLocal = sourceEquity != null
      ? (displayFx != null ? sourceEquity * displayFx : sourceEquity)
      : null;

    let netDebtLocal: number | null = null;
    if (row.total_liabilities != null && row.cash_and_equivalents != null) {
      const liabilities = parseFloat(row.total_liabilities);
      const cash = parseFloat(row.cash_and_equivalents);
      const reportingCurrency = row.reporting_currency?.toUpperCase();
      const _investmentCurrency = row.investment_currency?.toUpperCase();
      if (!reportingCurrency || reportingCurrency === targetCurrency.toUpperCase()) {
        netDebtLocal = liabilities - cash;
      } else {
        const netDebtSource = liabilities - cash;
        const reportFx = tryResolveFxRate(reportingCurrency, targetCurrency, anchorDate);
        netDebtLocal = reportFx != null ? netDebtSource * reportFx : null;
      }
    }

    localDisplayMap.set(row.entity_id, {
      ev: equityLocal != null ? equityLocal + (netDebtLocal ?? 0) : null,
      netDebt: netDebtLocal,
      equity: equityLocal,
      currency: targetCurrency,
      asOfDate: row.valuation_date,
    });
    localDisplayConvertedMap.set(row.entity_id, {
      convertedEquity: row.fair_value_fund_base_currency != null ? parseFloat(row.fair_value_fund_base_currency) : (equityLocal != null ? equityLocal * resolveFxRate(targetCurrency, fundCurrency, anchorDate) : null),
      fxToFund: equityLocal != null && Math.abs(equityLocal) > 1e-9 && row.fair_value_fund_base_currency != null
        ? parseFloat(row.fair_value_fund_base_currency) / equityLocal
        : (equityLocal != null ? tryResolveFxRate(targetCurrency, fundCurrency, anchorDate) : null),
    });
  }

  const dashboardDisplayMap = new Map<string, DisplayValueRow>();
  const dashboardDisplayConvertedMap = new Map<string, DisplayConvertedRow>();
  for (const row of dashboardDisplayRows ?? []) {
    const entity = row.company_id ? entityByCompanyId.get(row.company_id) : undefined;
    if (!entity || dashboardDisplayMap.has(entity.entityId)) continue;

    const anchorDate = row.latest_valuation_date ?? asOfDate;
    const targetCurrency = entity.entityType === 'portco'
      ? (entity.currency ?? fundCurrency)
      : (row.investment_currency ?? entity.currency ?? fundCurrency);
    const sourceCurrency = row.investment_currency ?? row.fund_base_currency ?? targetCurrency;
    const sourceEquity = row.current_fair_value != null ? parseFloat(row.current_fair_value) : null;
    const equityFund = row.current_fair_value_base_currency != null ? parseFloat(row.current_fair_value_base_currency) : null;
    const displayFx = tryResolveFxRate(sourceCurrency, targetCurrency, anchorDate);
    const equityLocal = sourceEquity != null
      ? (displayFx != null ? sourceEquity * displayFx : sourceEquity)
      : null;
    const fxToFund = equityLocal != null && Math.abs(equityLocal) > 1e-9 && equityFund != null
      ? equityFund / equityLocal
      : (equityLocal != null ? tryResolveFxRate(targetCurrency, fundCurrency, anchorDate) : null);

    dashboardDisplayMap.set(entity.entityId, {
      ev: equityLocal,
      netDebt: null,
      equity: equityLocal,
      currency: targetCurrency,
      asOfDate: row.latest_valuation_date,
    });
    dashboardDisplayConvertedMap.set(entity.entityId, {
      convertedEquity: equityFund,
      fxToFund,
    });
  }

  const debtMap = new Map<string, Array<{ amount: number; currency: string }>>();
  for (const row of debtRows) {
    const current = debtMap.get(row.entityId) ?? [];
    current.push({ amount: parseFloat(row.outstandingAmount), currency: row.currency ?? (entityById.get(row.entityId)?.currency ?? fundCurrency) });
    debtMap.set(row.entityId, current);
  }

  const adjustmentMap = new Map<string, Array<{ value: number; unit: 'percent' | 'absolute'; currency: string | null }>>();
  for (const row of adjustmentRows) {
    if (row.effectiveDate && row.effectiveDate > asOfDate) continue;
    const list = adjustmentMap.get(row.entityId) ?? [];
    list.push({
      value: parseFloat(row.adjustmentValue),
      unit: row.adjustmentUnit as 'percent' | 'absolute',
      currency: row.currency ?? null,
    });
    adjustmentMap.set(row.entityId, list);
  }

  const remainingChildren = new Map<string, number>();
  for (const entity of entities) {
    remainingChildren.set(entity.entityId, (parentToChildren.get(entity.entityId) ?? []).length);
  }

  const queue: string[] = entities
    .filter((entity) => (remainingChildren.get(entity.entityId) ?? 0) === 0)
    .map((entity) => entity.entityId);

  const processed = new Set<string>();
  const entityValues = new Map<string, EntityValue>();

  while (queue.length > 0) {
    const entityId = queue.shift()!;
    if (processed.has(entityId)) continue;
    processed.add(entityId);

    const valuation = valuationMap.get(entityId);
    let valuationDate = childValuationDateByEntity?.get(entityId) ?? asOfDate;
    const entityCurrency = entityById.get(entityId)?.currency ?? fundCurrency;
    const localCurrency = valuation?.currency ?? entityCurrency;
    const recordedDebt = (debtMap.get(entityId) ?? []).reduce((sum, row) => {
      const fxRate = resolveFxRate(row.currency, localCurrency, valuationDate);
      return sum + row.amount * fxRate;
    }, 0);

    let enterpriseValue = valuation?.ev ?? null;
    let netDebt = valuation?.netDebt ?? (recordedDebt > 0 ? recordedDebt : null);
    let equityValue = valuation?.equity ?? null;

    if (enterpriseValue === null && (parentToChildren.get(entityId)?.length ?? 0) > 0) {
      let grossAssets = 0;
      let derivedValuationDate = valuationDate;
      for (const child of parentToChildren.get(entityId) ?? []) {
        const childValue = entityValues.get(child.childId);
        const childEquity = childValue?.equityValue ?? 0;
        const childValuationDate = childValue?.valuationDate
          ?? childValuationDateByEntity?.get(child.childId)
          ?? asOfDate;
        if (childValuationDate > derivedValuationDate) derivedValuationDate = childValuationDate;
        const childCurrency = childValue?.localCurrency ?? entityById.get(child.childId)?.currency ?? fundCurrency;
        const fxRate = resolveFxRate(childCurrency, localCurrency, childValuationDate);
        grossAssets += childEquity * child.ownershipPct / 100 * fxRate;
      }
      valuationDate = derivedValuationDate;
      enterpriseValue = grossAssets;
      netDebt = recordedDebt > 0 ? recordedDebt : netDebt;
      equityValue = enterpriseValue - (netDebt ?? 0);
    } else if (equityValue === null && enterpriseValue !== null) {
      equityValue = enterpriseValue - (netDebt ?? 0);
    } else if (equityValue !== null && enterpriseValue === null) {
      enterpriseValue = equityValue + (netDebt ?? 0);
    }

    let adjustmentTotal = 0;
    for (const adjustment of adjustmentMap.get(entityId) ?? []) {
      if (adjustment.unit === 'percent' && equityValue !== null) {
        adjustmentTotal += equityValue * adjustment.value / 100;
      } else if (adjustment.unit === 'absolute') {
        const adjustmentCurrency = adjustment.currency ?? localCurrency;
        const fxRate = resolveFxRate(adjustmentCurrency, localCurrency, valuationDate);
        adjustmentTotal += adjustment.value * fxRate;
      }
    }

    const finalEquity = (equityValue ?? 0) + adjustmentTotal;
    entityValues.set(entityId, {
      enterpriseValue,
      netDebt,
      equityValue: finalEquity,
      adjustments: adjustmentTotal,
      valuationDate,
      localCurrency,
    });

    for (const parent of childToParents.get(entityId) ?? []) {
      const nextCount = (remainingChildren.get(parent.parentId) ?? 0) - 1;
      remainingChildren.set(parent.parentId, nextCount);
      if (nextCount === 0) {
        queue.push(parent.parentId);
      }
    }
  }

  if (processed.size !== entities.length) {
    throw new Error('Unable to compute waterfall: structure contains a cycle or unresolved dependency');
  }

  const perEntity: WaterfallEntityResult[] = [];
  const rootQueue = entities
    .filter((entity) => (childToParents.get(entity.entityId) ?? []).length === 0)
    .map((entity) => ({ entityId: entity.entityId, parentEntityId: null as string | null, cumulativeOwnershipPct: 100 }));

  while (rootQueue.length > 0) {
    const current = rootQueue.shift()!;
    const entity = entityById.get(current.entityId);
    const value = entityValues.get(current.entityId);
    if (!entity || !value) continue;

    const fxRate = resolveFxRate(value.localCurrency, fundCurrency, value.valuationDate);
    const convertedEquity = value.equityValue * fxRate;
    const storedValue = storedValuationMap.get(current.entityId);
    const portcoStoredDisplayValue: DisplayValueRow | undefined = entity.entityType === 'portco' && storedValue
      ? {
          ev: storedValue.ev,
          netDebt: storedValue.netDebt,
          equity: storedValue.equity,
          currency: storedValue.currency,
          asOfDate: storedValue.asOfDate,
        }
      : undefined;
    const portcoStoredConverted: DisplayConvertedRow | undefined = entity.entityType === 'portco' && storedValue
      ? {
          convertedEquity: storedValue.equity != null
            ? storedValue.equity * resolveFxRate(storedValue.currency, fundCurrency, storedValue.asOfDate ?? value.valuationDate)
            : null,
          fxToFund: resolveFxRate(storedValue.currency, fundCurrency, storedValue.asOfDate ?? value.valuationDate),
        }
      : undefined;
    const displayValue = portcoStoredDisplayValue
      ?? localDisplayMap.get(current.entityId)
      ?? dashboardDisplayMap.get(current.entityId)
      ?? storedValue;
    const displayConverted = portcoStoredConverted
      ?? localDisplayConvertedMap.get(current.entityId)
      ?? dashboardDisplayConvertedMap.get(current.entityId);

    perEntity.push({
      entityId: entity.entityId,
      entityName: entity.name,
      entityType: entity.entityType,
      currency: value.localCurrency,
      displayCurrency: displayValue?.currency ?? storedValue?.currency ?? value.localCurrency,
      storedCurrency: storedValue?.currency ?? value.localCurrency,
      enterpriseValue: value.enterpriseValue,
      netDebt: value.netDebt,
      equityValue: value.equityValue,
      displayEnterpriseValue: displayValue?.ev ?? storedValue?.ev ?? value.enterpriseValue,
      displayNetDebt: displayValue?.netDebt ?? storedValue?.netDebt ?? value.netDebt,
      displayEquityValue: displayValue?.equity ?? storedValue?.equity ?? value.equityValue,
      displayConvertedEquity: displayConverted?.convertedEquity ?? convertedEquity,
      displayFxToFund: displayConverted?.fxToFund ?? fxRate,
      displayValuationDate: displayValue?.asOfDate ?? storedValue?.asOfDate ?? value.valuationDate,
      storedEnterpriseValue: storedValue?.ev ?? value.enterpriseValue,
      storedNetDebt: storedValue?.netDebt ?? value.netDebt,
      storedEquityValue: storedValue?.equity ?? value.equityValue,
      storedValuationDate: storedValue?.asOfDate ?? value.valuationDate,
      parentEntityId: current.parentEntityId,
      ownershipPct: current.cumulativeOwnershipPct,
      adjustments: value.adjustments,
      fxRate,
      convertedEquity,
      attributableValue: convertedEquity * current.cumulativeOwnershipPct / 100,
    });

    for (const child of parentToChildren.get(current.entityId) ?? []) {
      rootQueue.push({
        entityId: child.childId,
        parentEntityId: current.entityId,
        cumulativeOwnershipPct: current.cumulativeOwnershipPct * child.ownershipPct / 100,
      });
    }
  }

  let grossPortfolioValue = 0;
  let portfolioNetDebt = 0;
  let portfolioEquity = 0;
  let spvLevelDebt = 0;
  let totalAdjustments = 0;
  let fundNav = 0;

  for (const row of perEntity) {
    const ownershipFactor = row.ownershipPct / 100;
    if (row.entityType === 'portco') {
      grossPortfolioValue += (row.enterpriseValue ?? 0) * row.fxRate * ownershipFactor;
      portfolioNetDebt += (row.netDebt ?? 0) * row.fxRate * ownershipFactor;
      portfolioEquity += row.attributableValue;
    }
    if (row.entityType === 'spv') {
      spvLevelDebt += (row.netDebt ?? 0) * row.fxRate * ownershipFactor;
    }
    if (row.entityType === 'fund_root') {
      fundNav = row.equityValue ?? 0;
    }
    totalAdjustments += row.adjustments * row.fxRate * ownershipFactor;
  }

  return {
    asOfDate,
    fxRateType,
    grossPortfolioValue,
    portfolioNetDebt,
    portfolioEquity,
    spvLevelDebt,
    totalAdjustments,
    fundNav,
    fundCurrency,
    perEntity,
    fxRatesUsed: ratesUsed,
  };
}

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function normalizeFundFxRateType(raw: string | null | undefined): FxRateType {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'spot' || value === '') return 'spot';
  console.warn('[WaterfallWarning]', JSON.stringify({
    code: 'UNSUPPORTED_FX_RATE_TYPE',
    configuredFxRateType: raw,
    enforcedFxRateType: 'spot',
  }));
  return 'spot';
}
