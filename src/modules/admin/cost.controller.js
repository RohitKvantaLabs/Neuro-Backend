/**
 * Phase 6 — Cost Intelligence Controller
 * Additive Admin APIs — do not modify existing response fields of other endpoints.
 */

const ApiResponse = require('../../utils/ApiResponse');
const ApiError = require('../../utils/ApiError');
const asyncHandler = require('../../utils/asyncHandler');
const { calculateCostForRequestId, calculateAggregateCost, calculateLlmCostForRecord, calculateExternalCostForRecord, calculateCostForRecords } = require('../../services/cost.service');

// GET /admin/cost/request/:requestId — per-search cost
const getCostByRequestId = asyncHandler(async (req, res) => {
  const { requestId } = req.params;
  if (!requestId) throw new ApiError(400, 'requestId is required.');
  const result = await calculateCostForRequestId(requestId);
  return new ApiResponse(200, result, 'Cost calculated for request.').send(res);
});

// GET /admin/cost/daily?date=YYYY-MM-DD&from=&to= — daily aggregation
const getDailyCost = asyncHandler(async (req, res) => {
  const { date, from, to } = req.query;
  let fromDate = from || null;
  let toDate = to || null;
  if (date && !from && !to) {
    const d = new Date(date);
    if (isNaN(d)) throw new ApiError(400, 'Invalid date format. Use YYYY-MM-DD.');
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
    fromDate = start.toISOString();
    toDate = end.toISOString();
  } else if (!fromDate && !toDate) {
    // Default: last 30 days
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 30);
    fromDate = start.toISOString();
    toDate = end.toISOString();
  }
  const result = await calculateAggregateCost({ from: fromDate, to: toDate, groupBy: 'day' });
  return new ApiResponse(200, result, 'Daily cost aggregation.').send(res);
});

// GET /admin/cost/monthly?month=YYYY-MM&from=&to= — monthly aggregation
const getMonthlyCost = asyncHandler(async (req, res) => {
  const { month, from, to } = req.query;
  let fromDate = from || null;
  let toDate = to || null;
  if (month && !from && !to) {
    const m = new Date(`${month}-01T00:00:00.000Z`);
    if (isNaN(m)) throw new ApiError(400, 'Invalid month format. Use YYYY-MM.');
    const start = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0, 23, 59, 59, 999));
    fromDate = start.toISOString();
    toDate = end.toISOString();
  } else if (!fromDate && !toDate) {
    const end = new Date();
    const start = new Date();
    start.setMonth(start.getMonth() - 12);
    fromDate = start.toISOString();
    toDate = end.toISOString();
  }
  const result = await calculateAggregateCost({ from: fromDate, to: toDate, groupBy: 'month' });
  return new ApiResponse(200, result, 'Monthly cost aggregation.').send(res);
});

// GET /admin/cost/summary?from=&to=&groupBy=day|month — flexible summary
const getCostSummary = asyncHandler(async (req, res) => {
  const { from, to, groupBy = 'day' } = req.query;
  if (!['day', 'month'].includes(groupBy)) throw new ApiError(400, 'groupBy must be day or month.');
  let fromDate = from || null;
  let toDate = to || null;
  if (!fromDate && !toDate) {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 30);
    fromDate = start.toISOString();
    toDate = end.toISOString();
  }
  const result = await calculateAggregateCost({ from: fromDate, to: toDate, groupBy });
  return new ApiResponse(200, result, 'Cost summary.').send(res);
});

// GET /admin/cost/pricing — expose current pricing table (read-only)
const getPricing = asyncHandler(async (req, res) => {
  const { getLlmPricingTable, getExternalApiPricing } = require('../../config/pricing.config');
  return new ApiResponse(200, {
    llm: getLlmPricingTable(),
    external: getExternalApiPricing(),
    note: 'External API pricing defaults to unavailable (null). Set TAVILY_PRICE_PER_1K_SEARCHES to enable Tavily cost.',
  }).send(res);
});

// Phase 11 — Cost Breakdown
const getCostBreakdown = asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  if (from && isNaN(new Date(from))) throw new ApiError(400, 'Invalid from date');
  if (to && isNaN(new Date(to))) throw new ApiError(400, 'Invalid to date');
  const { calculateCostBreakdown } = require('../../services/cost.service');
  const result = await calculateCostBreakdown({ from: from || null, to: to || null });
  return new ApiResponse(200, result, 'Cost breakdown.').send(res);
});

// Phase 11 — Cost Scaling
const getCostScaling = asyncHandler(async (req, res) => {
  const { from, to, scenarios } = req.query;
  if (from && isNaN(new Date(from))) throw new ApiError(400, 'Invalid from date');
  if (to && isNaN(new Date(to))) throw new ApiError(400, 'Invalid to date');
  let scen = null;
  if (scenarios) {
    // Accept comma-separated e.g. ?scenarios=1000,10000,50000
    const parts = String(scenarios).split(',').map((s) => s.trim()).filter(Boolean);
    scen = parts.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0);
    if (scen.length === 0) throw new ApiError(400, 'Invalid scenarios');
    if (scen.length > 10) throw new ApiError(400, 'Too many scenarios (max 10)');
  }
  const { calculateScaling } = require('../../services/cost.service');
  const result = await calculateScaling({ from: from || null, to: to || null, scenarios: scen });
  return new ApiResponse(200, result, 'Cost scaling projections.').send(res);
});

module.exports = {
  getCostByRequestId,
  getDailyCost,
  getMonthlyCost,
  getCostSummary,
  getPricing,
  getCostBreakdown,
  getCostScaling,
};
