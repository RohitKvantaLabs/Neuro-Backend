/**
 * Phase 6 — Cost Intelligence Service
 *
 * Calculates deterministic costs from existing telemetry:
 *   requestId -> TokenUsage -> LLM cost
 *   requestId -> ExternalApiLog -> external API cost
 *   Search Cost = LLM Cost + External API Cost
 *
 * COST DATA INTEGRITY (§ Step 8):
 * - Cache hit: no TokenUsage fabricated => cost 0 (no invented usage)
 * - Estimated usageType: cost flagged isEstimated=true, traceable
 * - Actual usageType: provider-reported input/output tokens
 * - Missing pricing: cost = null, reason = 'pricing_unavailable'
 * - Missing telemetry: cost = 0 or null, no fabrication
 * - Failed LLM (status=error): excluded (0 cost)
 * - Failed external API: only billable if known model (currently none)
 * - Multiple records per requestId: aggregated
 * - Duplicate reads: pure function, no writes, idempotent
 *
 * STORAGE: Calculated dynamically — no duplicate telemetry collection,
 * no persisted cost records, no historical rewrite.
 */

const { getLlmPricing, getExternalPricingForService } = require('../config/pricing.config');

// ── LLM cost per record ────────────────────────────────────────────────────

/**
 * Calculate cost for a single TokenUsage record.
 * @param {Object} record - TokenUsage doc/lean object
 * @returns {Object} { inputCost, outputCost, totalCost, isEstimated, pricingAvailable, costAvailable, reason }
 */
function calculateLlmCostForRecord(record) {
  if (!record) {
    return { inputCost: 0, outputCost: 0, totalCost: 0, isEstimated: false, pricingAvailable: false, costAvailable: false, reason: 'missing_record' };
  }

  // Failed LLM call: do not count nonexistent tokens
  if (record.status === 'error') {
    return { inputCost: 0, outputCost: 0, totalCost: 0, isEstimated: false, pricingAvailable: true, costAvailable: true, reason: 'failed_call_excluded' };
  }

  // Heuristic provider has no LLM cost by design
  const provider = record.provider || null;
  if (provider && String(provider).toLowerCase() === 'heuristic') {
    return { inputCost: 0, outputCost: 0, totalCost: 0, isEstimated: record.usageType === 'estimated', pricingAvailable: true, costAvailable: true, reason: 'heuristic_no_cost' };
  }

  const pricing = getLlmPricing(provider, record.model);
  if (!pricing) {
    return {
      inputCost: null,
      outputCost: null,
      totalCost: null,
      isEstimated: record.usageType === 'estimated',
      pricingAvailable: false,
      costAvailable: false,
      reason: 'pricing_unavailable',
      provider: provider || null,
      model: record.model || null,
    };
  }

  const isEstimated = record.usageType === 'estimated';
  const inputTokens = record.inputTokens;
  const outputTokens = record.outputTokens;

  // Require split input/output tokens — do NOT use totalTokens when pricing differs
  const hasInput = typeof inputTokens === 'number' && Number.isFinite(inputTokens);
  const hasOutput = typeof outputTokens === 'number' && Number.isFinite(outputTokens);

  if (hasInput && hasOutput) {
    const inputCost = (inputTokens * pricing.inputPerMillion) / 1_000_000;
    const outputCost = (outputTokens * pricing.outputPerMillion) / 1_000_000;
    const totalCost = inputCost + outputCost;
    return {
      inputCost,
      outputCost,
      totalCost,
      isEstimated,
      pricingAvailable: true,
      costAvailable: true,
      reason: isEstimated ? 'estimated_split_pricing' : 'actual_split_pricing',
      provider,
      model: record.model,
      inputTokens,
      outputTokens,
      currency: pricing.currency,
    };
  }

  // If input/output pricing is identical, totalTokens can be used (no bias)
  const totalTokens = record.totalTokens != null ? record.totalTokens : record.tokens;
  const pricingEqual = pricing.inputPerMillion === pricing.outputPerMillion;
  if (pricingEqual && typeof totalTokens === 'number' && Number.isFinite(totalTokens) && totalTokens > 0) {
    const totalCost = (totalTokens * pricing.inputPerMillion) / 1_000_000;
    return {
      inputCost: null,
      outputCost: null,
      totalCost,
      isEstimated,
      pricingAvailable: true,
      costAvailable: true,
      reason: 'total_tokens_equal_pricing',
      provider,
      model: record.model,
      currency: pricing.currency,
    };
  }

  // Missing split telemetry and cannot use totalTokens safely
  return {
    inputCost: null,
    outputCost: null,
    totalCost: null,
    isEstimated,
    pricingAvailable: true,
    costAvailable: false,
    reason: 'missing_token_split',
    provider,
    model: record.model,
    currency: pricing.currency,
  };
}

// ── External API cost per record ───────────────────────────────────────────

function calculateExternalCostForRecord(record) {
  if (!record) {
    return { totalCost: 0, costAvailable: false, reason: 'missing_record' };
  }
  // Failed external call: only billable if model is per-attempt (none currently)
  if (record.status === 'error') {
    return { totalCost: 0, costAvailable: true, reason: 'failed_call_no_charge', service: record.service };
  }
  const pricing = getExternalPricingForService(record.service);
  if (!pricing) {
    return {
      totalCost: null,
      costAvailable: false,
      reason: 'pricing_unavailable',
      service: record.service,
      note: 'Call count is not automatically a billable unit — no pricing configured for this service.',
    };
  }
  // Billable service: per-call pricing (e.g., Tavily per search)
  const totalCost = pricing.perCall;
  return {
    totalCost,
    costAvailable: true,
    reason: 'per_call_pricing',
    service: record.service,
    currency: pricing.currency,
    unit: pricing.unit,
  };
}

// ── Pure aggregation helpers (no DB — used for testing and daily/monthly) ──

function calculateCostForRecords(tokenUsages, externalLogs) {
  const usages = Array.isArray(tokenUsages) ? tokenUsages : [];
  const externals = Array.isArray(externalLogs) ? externalLogs : [];

  let llmCost = 0;
  let llmCostAvailable = true;
  let hasEstimated = false;
  let hasActual = false;
  let llmPricingMissing = false;
  let llmTelemetryMissing = false;
  const llmBreakdown = [];
  const externalBreakdown = [];

  for (const r of usages) {
    const c = calculateLlmCostForRecord(r);
    llmBreakdown.push({ recordId: r._id || null, requestId: r.requestId || null, provider: r.provider, model: r.model, usageType: r.usageType, status: r.status, ...c });
    if (c.isEstimated) hasEstimated = true;
    if (r.usageType === 'actual' && c.costAvailable) hasActual = true;
    if (c.totalCost == null) {
      if (c.reason === 'pricing_unavailable') llmPricingMissing = true;
      if (c.reason === 'missing_token_split') llmTelemetryMissing = true;
      // unavailable costs do not contribute to sum, but flag overall availability
      if (c.reason !== 'heuristic_no_cost' && c.reason !== 'failed_call_excluded') {
        llmCostAvailable = false;
      }
    } else {
      llmCost += c.totalCost;
    }
  }

  let externalCost = 0;
  let externalCostAvailable = true;
  let externalPricingMissing = false;
  for (const r of externals) {
    const c = calculateExternalCostForRecord(r);
    externalBreakdown.push({ recordId: r._id || null, requestId: r.requestId || null, service: r.service, status: r.status, ...c });
    if (c.totalCost == null) {
      if (c.reason === 'pricing_unavailable') externalPricingMissing = true;
      // unavailable external costs keep total null for that component, but do not fabricate
      externalCostAvailable = false;
    } else {
      externalCost += c.totalCost;
    }
  }

  // Total cost is LLM + external where available. If LLM unavailable and no external billable,
  // total remains LLM portion (may be 0) but flagged.
  const totalCost = llmCost + externalCost;
  const totalCostAvailable = llmCostAvailable || usages.length === 0 ? true : llmCostAvailable;
  // If no billable external services, externalCost is 0 and available (no unknown charges)

  return {
    llm: {
      totalCost: llmCost,
      costAvailable: llmCostAvailable,
      isEstimated: hasEstimated,
      hasActual,
      pricingMissing: llmPricingMissing,
      telemetryMissing: llmTelemetryMissing,
      recordCount: usages.length,
      breakdown: llmBreakdown,
    },
    external: {
      totalCost: externalCost,
      costAvailable: externals.length === 0 ? true : externalCostAvailable,
      pricingMissing: externalPricingMissing,
      recordCount: externals.length,
      breakdown: externalBreakdown,
    },
    total: {
      totalCost,
      currency: 'USD',
      // isEstimated true if any LLM record was estimated (external per-call is always actual)
      isEstimated: hasEstimated,
      costAvailable: llmCostAvailable,
    },
    meta: {
      requestId: usages[0]?.requestId || externals[0]?.requestId || null,
      llmRecordCount: usages.length,
      externalRecordCount: externals.length,
    },
  };
}

// ── DB-backed helpers ──────────────────────────────────────────────────────

async function calculateCostForRequestId(requestId) {
  if (!requestId) throw new Error('requestId is required');
  const TokenUsage = require('../modules/admin/tokenUsage.model');
  const ExternalApiLog = require('../modules/admin/externalApiLog.model');

  const [usages, externals] = await Promise.all([
    TokenUsage.find({ requestId }).lean(),
    ExternalApiLog.find({ requestId }).lean(),
  ]);
  const result = calculateCostForRecords(usages, externals);
  result.meta.requestId = requestId;
  return result;
}

async function calculateAggregateCost({ from, to, groupBy = 'day' }) {
  const TokenUsage = require('../modules/admin/tokenUsage.model');
  const ExternalApiLog = require('../modules/admin/externalApiLog.model');

  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;
  const match = {};
  if (fromDate && !isNaN(fromDate)) match.createdAt = { $gte: fromDate };
  if (toDate && !isNaN(toDate)) {
    match.createdAt = match.createdAt || {};
    match.createdAt.$lte = toDate;
  }

  const [usages, externals] = await Promise.all([
    TokenUsage.find(match).lean(),
    ExternalApiLog.find(match).lean(),
  ]);

  // Group usages by requestId for per-search totals, and by date for daily/monthly
  const byRequestId = new Map();
  for (const u of usages) {
    const key = u.requestId || '__no_request_id__';
    if (!byRequestId.has(key)) byRequestId.set(key, []);
    byRequestId.get(key).push(u);
  }
  const byExternalRequestId = new Map();
  for (const e of externals) {
    const key = e.requestId || '__no_request_id__';
    if (!byExternalRequestId.has(key)) byExternalRequestId.set(key, []);
    byExternalRequestId.get(key).push(e);
  }

  const allRequestIds = new Set([...byRequestId.keys(), ...byExternalRequestId.keys()]);
  let totalLlmCost = 0;
  let totalExternalCost = 0;
  let estimatedSearches = 0;
  let actualSearches = 0;
  const perSearch = [];

  for (const rid of allRequestIds) {
    const uList = byRequestId.get(rid) || [];
    const eList = byExternalRequestId.get(rid) || [];
    const calc = calculateCostForRecords(uList, eList);
    // Only count real searches (with requestId) toward searchCount
    const isRealSearch = rid !== '__no_request_id__';
    totalLlmCost += calc.llm.totalCost;
    totalExternalCost += calc.external.totalCost;
    if (isRealSearch) {
      if (calc.total.isEstimated) estimatedSearches++;
      else if (uList.length > 0) actualSearches++;
      perSearch.push({ requestId: rid, llmCost: calc.llm.totalCost, externalCost: calc.external.totalCost, totalCost: calc.total.totalCost, isEstimated: calc.total.isEstimated, recordCount: uList.length });
    }
  }

  // Date grouping for daily/monthly breakdown
  const dateGroups = new Map();
  function dateKey(d, granularity) {
    const dt = new Date(d);
    if (granularity === 'month') return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
    return dt.toISOString().slice(0, 10); // YYYY-MM-DD
  }

  for (const u of usages) {
    const c = calculateLlmCostForRecord(u);
    const key = dateKey(u.createdAt, groupBy);
    if (!dateGroups.has(key)) dateGroups.set(key, { date: key, searchCount: 0, llmCost: 0, externalCost: 0, totalCost: 0, byProvider: {}, byModel: {}, estimatedCount: 0, actualCount: 0, requestIds: new Set() });
    const g = dateGroups.get(key);
    if (u.requestId) g.requestIds.add(u.requestId);
    if (c.totalCost != null) g.llmCost += c.totalCost;
    if (c.isEstimated) g.estimatedCount = (g.estimatedCount || 0) + 1;
    else g.actualCount = (g.actualCount || 0) + 1;
    const prov = u.provider || 'unknown';
    g.byProvider[prov] = (g.byProvider[prov] || 0) + (c.totalCost || 0);
    const mod = u.model || 'unknown';
    g.byModel[mod] = (g.byModel[mod] || 0) + (c.totalCost || 0);
  }
  for (const e of externals) {
    const c = calculateExternalCostForRecord(e);
    const key = dateKey(e.createdAt, groupBy);
    if (!dateGroups.has(key)) dateGroups.set(key, { date: key, searchCount: 0, llmCost: 0, externalCost: 0, totalCost: 0, byProvider: {}, byModel: {}, estimatedCount: 0, actualCount: 0, requestIds: new Set() });
    const g = dateGroups.get(key);
    if (e.requestId) g.requestIds.add(e.requestId);
    if (c.totalCost != null) g.externalCost += c.totalCost;
    // track external service breakdown
    g.byService = g.byService || {};
    g.byService[e.service] = (g.byService[e.service] || 0) + (c.totalCost || 0);
  }

  const groups = [...dateGroups.values()]
    .map((g) => ({
      date: g.date,
      searchCount: g.requestIds.size,
      llmCost: Math.round(g.llmCost * 1e6) / 1e6,
      externalCost: Math.round(g.externalCost * 1e6) / 1e6,
      totalCost: Math.round((g.llmCost + g.externalCost) * 1e6) / 1e6,
      byProvider: g.byProvider,
      byModel: g.byModel,
      byService: g.byService || {},
      estimatedCount: g.estimatedCount,
      actualCount: g.actualCount,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const searchCount = [...allRequestIds].filter((id) => id !== '__no_request_id__').length;

  return {
    summary: {
      searchCount,
      llmCost: Math.round(totalLlmCost * 1e6) / 1e6,
      externalCost: Math.round(totalExternalCost * 1e6) / 1e6,
      totalCost: Math.round((totalLlmCost + totalExternalCost) * 1e6) / 1e6,
      currency: 'USD',
      estimatedSearches,
      actualSearches,
    },
    groups,
    perSearch,
  };
}

/**
 * Phase 11 — Cost Breakdown & Scaling
 * Uses existing cost primitives + QueryLog coverage.
 * No new pricing, no invented costs.
 */

async function calculateCostBreakdown({ from, to } = {}) {
  const QueryLog = require('../modules/queryLog/queryLog.model');
  const TokenUsage = require('../modules/admin/tokenUsage.model');
  const ExternalApiLog = require('../modules/admin/externalApiLog.model');

  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;
  const isValid = (d) => d instanceof Date && !isNaN(d);
  const match = {};
  const queryMatch = {};
  if (isValid(fromDate) || isValid(toDate)) {
    const range = {};
    if (isValid(fromDate)) range.$gte = fromDate;
    if (isValid(toDate)) range.$lte = toDate;
    match.createdAt = range;
    queryMatch.createdAt = range;
  }

  const [totalSearches, usages, externals] = await Promise.all([
    QueryLog.countDocuments(queryMatch),
    TokenUsage.find(match, {
      provider: 1, model: 1, agent: 1, inputTokens: 1, outputTokens: 1, totalTokens: 1, tokens: 1, usageType: 1, status: 1, requestId: 1, createdAt: 1,
    }).lean(),
    ExternalApiLog.find(match, { service: 1, status: 1, requestId: 1, createdAt: 1 }).lean(),
  ]);

  const overall = calculateCostForRecords(usages, externals);

  // Build per-request calculable map for coverage
  const byRequest = new Map();
  for (const u of usages) {
    const k = u.requestId || '__no_request_id__';
    if (!byRequest.has(k)) byRequest.set(k, { usages: [], externals: [] });
    byRequest.get(k).usages.push(u);
  }
  for (const e of externals) {
    const k = e.requestId || '__no_request_id__';
    if (!byRequest.has(k)) byRequest.set(k, { usages: [], externals: [] });
    byRequest.get(k).externals.push(e);
  }
  // Filter out __no_request_id__ for search-level counts
  const requestIds = [...byRequest.keys()].filter((k) => k !== '__no_request_id__');
  let calculableSearches = 0;
  let estimatedSearches = 0;
  let unavailableSearches = 0;
  let calculableTotalCost = 0;
  let calculableLlmCost = 0;
  let calculableExternalCost = 0;
  for (const rid of requestIds) {
    const grp = byRequest.get(rid);
    const calc = calculateCostForRecords(grp.usages, grp.externals);
    if (calc.total.costAvailable) {
      calculableSearches++;
      calculableTotalCost += calc.total.totalCost || 0;
      calculableLlmCost += calc.llm.totalCost || 0;
      calculableExternalCost += calc.external.totalCost || 0;
      if (calc.total.isEstimated) estimatedSearches++;
    } else {
      unavailableSearches++;
      // If has estimated but not calculable, count as estimated unavailable
      if (calc.total.isEstimated) estimatedSearches++;
    }
  }
  // For coverage, searchesWithCalculableCost are those where costAvailable true
  // estimatedSearches includes both calculable+estimated and unavailable+estimated but we report separately
  // recompute estimated among calculable for scaling
  let calculableEstimatedCount = 0;
  for (const rid of requestIds) {
    const grp = byRequest.get(rid);
    const calc = calculateCostForRecords(grp.usages, grp.externals);
    if (calc.total.costAvailable && calc.total.isEstimated) calculableEstimatedCount++;
  }

  const avgCostPerSearch = calculableSearches > 0 ? calculableTotalCost / calculableSearches : null;
  const avgLlmPerSearch = calculableSearches > 0 ? calculableLlmCost / calculableSearches : null;
  const avgExternalPerSearch = calculableSearches > 0 ? calculableExternalCost / calculableSearches : null;
  const overallAvg = totalSearches > 0 ? overall.total.totalCost / totalSearches : null;

  const percentCalculable = totalSearches > 0 ? (calculableSearches / totalSearches) * 100 : 0;
  const coverage = {
    totalSearches,
    searchesWithCalculableCost: calculableSearches,
    searchesWithEstimatedCost: estimatedSearches,
    searchesWithUnavailableCost: unavailableSearches,
    calculableEstimatedCount,
    percentCalculable: Math.round(percentCalculable * 10) / 10,
    percentEstimated: totalSearches > 0 ? Math.round((estimatedSearches / totalSearches) * 1000) / 10 : 0,
    percentUnavailable: totalSearches > 0 ? Math.round((unavailableSearches / totalSearches) * 1000) / 10 : 0,
  };

  // Breakdown by provider
  const byProviderMap = new Map();
  const byModelMap = new Map();
  const byAgentMap = new Map();
  const byUsageType = { actual: { cost: 0, count: 0 }, estimated: { cost: 0, count: 0 }, unknown: { cost: 0, count: 0 } };
  for (const u of usages) {
    const c = calculateLlmCostForRecord(u);
    const cost = c.totalCost != null ? c.totalCost : 0;
    const avail = c.costAvailable;
    // byProvider
    const prov = u.provider ? String(u.provider).toLowerCase() : 'unknown';
    if (!byProviderMap.has(prov)) byProviderMap.set(prov, { provider: prov, llmCost: 0, count: 0, costAvailableCount: 0, unavailableCount: 0 });
    const p = byProviderMap.get(prov);
    p.count++;
    if (avail) { p.llmCost += cost; p.costAvailableCount++; } else p.unavailableCount++;

    // byModel
    const modelKey = u.model ? String(u.model) : 'unknown';
    const mk = `${prov}/${modelKey}`;
    if (!byModelMap.has(mk)) byModelMap.set(mk, { model: modelKey, provider: prov, llmCost: 0, count: 0, costAvailableCount: 0 });
    const m = byModelMap.get(mk);
    m.count++;
    if (avail) { m.llmCost += cost; m.costAvailableCount++; }

    // byAgent
    const ag = u.agent ? String(u.agent) : 'unknown';
    if (!byAgentMap.has(ag)) byAgentMap.set(ag, { agent: ag, llmCost: 0, count: 0, costAvailableCount: 0 });
    const a = byAgentMap.get(ag);
    a.count++;
    if (avail) { a.llmCost += cost; a.costAvailableCount++; }

    // byUsageType
    if (u.usageType === 'actual') {
      byUsageType.actual.count++;
      if (avail) byUsageType.actual.cost += cost;
    } else if (u.usageType === 'estimated') {
      byUsageType.estimated.count++;
      if (avail) byUsageType.estimated.cost += cost;
    } else {
      byUsageType.unknown.count++;
      if (avail) byUsageType.unknown.cost += cost;
    }
  }

  // Normalize to arrays with percentages
  const totalLlmForPct = overall.llm.totalCost || 0;
  const byProvider = [...byProviderMap.values()].map((x) => ({
    ...x,
    llmCost: Math.round(x.llmCost * 1e6) / 1e6,
    percentage: totalLlmForPct > 0 ? Math.round((x.llmCost / totalLlmForPct) * 1000) / 10 : 0,
  })).sort((a, b) => b.llmCost - a.llmCost);

  const byModel = [...byModelMap.values()].map((x) => ({
    ...x,
    llmCost: Math.round(x.llmCost * 1e6) / 1e6,
    percentage: totalLlmForPct > 0 ? Math.round((x.llmCost / totalLlmForPct) * 1000) / 10 : 0,
  })).sort((a, b) => b.llmCost - a.llmCost);

  const byAgent = [...byAgentMap.values()].map((x) => ({
    ...x,
    llmCost: Math.round(x.llmCost * 1e6) / 1e6,
    percentage: totalLlmForPct > 0 ? Math.round((x.llmCost / totalLlmForPct) * 1000) / 10 : 0,
  })).sort((a, b) => b.llmCost - a.llmCost);

  // byService (external)
  const byServiceMap = new Map();
  for (const e of externals) {
    const c = calculateExternalCostForRecord(e);
    const svc = e.service ? String(e.service).toLowerCase() : 'unknown';
    if (!byServiceMap.has(svc)) byServiceMap.set(svc, { service: svc, externalCost: 0, count: 0, costAvailableCount: 0, unavailableCount: 0 });
    const s = byServiceMap.get(svc);
    s.count++;
    if (c.costAvailable && c.totalCost != null) { s.externalCost += c.totalCost; s.costAvailableCount++; } else s.unavailableCount++;
  }
  const totalExternalForPct = overall.external.totalCost || 0;
  const byService = [...byServiceMap.values()].map((x) => ({
    ...x,
    externalCost: Math.round(x.externalCost * 1e6) / 1e6,
    percentage: totalExternalForPct > 0 ? Math.round((x.externalCost / totalExternalForPct) * 1000) / 10 : 0,
  })).sort((a, b) => b.externalCost - a.externalCost);

  // byCostType
  const byCostType = {
    llm: { cost: Math.round(overall.llm.totalCost * 1e6) / 1e6, percentage: overall.total.totalCost > 0 ? Math.round((overall.llm.totalCost / overall.total.totalCost) * 1000) / 10 : 0, count: usages.length },
    external: { cost: Math.round(overall.external.totalCost * 1e6) / 1e6, percentage: overall.total.totalCost > 0 ? Math.round((overall.external.totalCost / overall.total.totalCost) * 1000) / 10 : 0, count: externals.length },
  };

  // Daily groups from aggregate
  let daily = [];
  try {
    const agg = await calculateAggregateCost({ from, to, groupBy: 'day' });
    daily = agg.groups;
  } catch { daily = []; }

  // Round byUsageType costs
  byUsageType.actual.cost = Math.round(byUsageType.actual.cost * 1e6) / 1e6;
  byUsageType.estimated.cost = Math.round(byUsageType.estimated.cost * 1e6) / 1e6;
  byUsageType.unknown.cost = Math.round(byUsageType.unknown.cost * 1e6) / 1e6;

  // Cost drivers: sorted copies for quick insight
  const drivers = {
    topModel: byModel[0] || null,
    topAgent: byAgent[0] || null,
    topProvider: byProvider[0] || null,
    topService: byService[0] || null,
  };

  return {
    period: { from: from || null, to: to || null },
    totals: {
      searchCount: totalSearches,
      calculableSearchCount: calculableSearches,
      llmCost: Math.round(overall.llm.totalCost * 1e6) / 1e6,
      externalCost: Math.round(overall.external.totalCost * 1e6) / 1e6,
      totalCost: Math.round(overall.total.totalCost * 1e6) / 1e6,
      calculableTotalCost: Math.round(calculableTotalCost * 1e6) / 1e6,
      currency: 'USD',
      actualSearches: overall.summary ? undefined : undefined, // keep for compat
    },
    coverage,
    averages: {
      avgCostPerSearch: avgCostPerSearch != null ? Math.round(avgCostPerSearch * 1e6) / 1e6 : null,
      avgLlmPerSearch: avgLlmPerSearch != null ? Math.round(avgLlmPerSearch * 1e6) / 1e6 : null,
      avgExternalPerSearch: avgExternalPerSearch != null ? Math.round(avgExternalPerSearch * 1e6) / 1e6 : null,
      overallAvgCostPerSearch: overallAvg != null ? Math.round(overallAvg * 1e6) / 1e6 : null,
      // For scaling, use calculable avg (defensible)
      assumedCostPerSearch: avgCostPerSearch != null ? Math.round(avgCostPerSearch * 1e6) / 1e6 : null,
    },
    breakdown: {
      byProvider,
      byModel,
      byAgent,
      byService,
      byUsageType,
      byCostType,
    },
    drivers,
    daily,
    meta: {
      llmRecordCount: usages.length,
      externalRecordCount: externals.length,
      calculableLlmCost: Math.round(calculableLlmCost * 1e6) / 1e6,
      calculableExternalCost: Math.round(calculableExternalCost * 1e6) / 1e6,
    },
  };
}

async function calculateScaling({ from, to, scenarios } = {}) {
  const breakdown = await calculateCostBreakdown({ from, to });
  const scenariosList = Array.isArray(scenarios) && scenarios.length > 0
    ? scenarios.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0).slice(0, 10)
    : [1000, 10000, 50000];

  const { coverage, averages, totals } = breakdown;
  const MIN_CALCULABLE_SEARCHES = 5;
  const MIN_COVERAGE_PCT = 30;

  const insufficientReasons = [];
  if (coverage.totalSearches < 10) insufficientReasons.push(`Historical sample too small: ${coverage.totalSearches} total searches (need ≥10)`);
  if (coverage.searchesWithCalculableCost < MIN_CALCULABLE_SEARCHES) insufficientReasons.push(`Calculable cost sample too small: ${coverage.searchesWithCalculableCost} searches with calculable cost (need ≥${MIN_CALCULABLE_SEARCHES})`);
  if (coverage.percentCalculable < MIN_COVERAGE_PCT) insufficientReasons.push(`Cost coverage too low: ${coverage.percentCalculable}% calculable (need ≥${MIN_COVERAGE_PCT}%)`);
  if (averages.assumedCostPerSearch == null) insufficientReasons.push('No calculable average cost per search available');

  const insufficient = insufficientReasons.length > 0;

  const assumptions = {
    historicalPeriod: breakdown.period,
    historicalTotalSearches: coverage.totalSearches,
    historicalCalculableSearches: coverage.searchesWithCalculableCost,
    historicalCalculableCost: totals.calculableTotalCost,
    historicalCoveragePercent: coverage.percentCalculable,
    avgCostPerSearch: averages.assumedCostPerSearch,
    avgLlmPerSearch: averages.avgLlmPerSearch,
    avgExternalPerSearch: averages.avgExternalPerSearch,
    formula: 'projectedDailyCost = searchesPerDay × assumedCostPerSearch where assumedCostPerSearch = historicalCalculableCost / historicalCalculableSearchCount',
    note: 'Projections are modeled, not measured. They assume future traffic has the same provider/model/cost mix as the historical window.',
  };

  let projections = [];
  if (!insufficient) {
    const cps = averages.assumedCostPerSearch;
    const lps = averages.avgLlmPerSearch || 0;
    const eps = averages.avgExternalPerSearch || 0;
    projections = scenariosList.map((s) => ({
      searchesPerDay: s,
      projectedDailyCost: Math.round(s * cps * 100) / 100,
      projectedMonthlyCost: Math.round(s * cps * 30 * 100) / 100,
      projectedLlmDailyCost: Math.round(s * lps * 100) / 100,
      projectedExternalDailyCost: Math.round(s * eps * 100) / 100,
      currency: 'USD',
      assumedCostPerSearch: cps,
    }));
  }

  return {
    period: breakdown.period,
    measured: {
      totals: breakdown.totals,
      coverage: breakdown.coverage,
      averages: breakdown.averages,
    },
    assumptions,
    scenarios: scenariosList,
    projections,
    insufficient,
    insufficientReasons,
    warnings: insufficient ? insufficientReasons : (coverage.percentCalculable < 70 ? [`Coverage warning: only ${coverage.percentCalculable}% of searches have calculable cost — projections carry uncertainty`] : []),
    drivers: breakdown.drivers,
    breakdown: breakdown.breakdown,
  };
}

module.exports = {
  calculateLlmCostForRecord,
  calculateExternalCostForRecord,
  calculateCostForRecords,
  calculateCostForRequestId,
  calculateAggregateCost,
  calculateCostBreakdown,
  calculateScaling,
};
