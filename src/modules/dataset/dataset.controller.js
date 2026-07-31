const ApiError = require('../../utils/ApiError');
const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const logger = require('../../utils/logger');
const env = require('../../config/env.config');
const { parseQuery, runFallbackSearch } = require('../agent/agent.client');
const { searchDatasets } = require('./dataset.service');
const { orchestrateSearch } = require('./retrievalOrchestrator');
const Dataset = require('./dataset.model');
const { User } = require('../user/user.model');
const QueryLog = require('../queryLog/queryLog.model');
const SearchHistory = require('../user/searchHistory.model');

/**
 * POST /datasets/search
 *
 * When FF_USE_NEW_ORCHESTRATOR=true:
 *   Delegates entirely to RetrievalOrchestrator, which implements the full
 *   Retrieval Orchestrator architecture (§7): parse → MongoDB → quality →
 *   Discovery Policy → optional Discovery Agent → Layer 3 ranking.
 *
 * When FF_USE_NEW_ORCHESTRATOR=false (default):
 *   Runs the original binary decision flow (cache hit → return, miss → fallback).
 *   Preserved exactly for rollback safety (§18.6).
 *
 * §10.5: Fire-and-forget SearchHistory write for authenticated users.
 * Node stays read-only for the datasets collection — Python owns writes.
 */
const search = asyncHandler(async (req, res) => {
  const { query, filters: explicitFilters } = req.body;
  const hasExplicitFilters = explicitFilters && typeof explicitFilters === 'object' && Object.values(explicitFilters).some(v => Array.isArray(v) ? v.length > 0 : Boolean(v));
  const rawQuery = (typeof query === 'string' ? query.trim() : '');

  if (!rawQuery && !hasExplicitFilters) {
    throw new ApiError(400, 'A query string of at least 2 characters or active filter selections are required.');
  }

  let effectiveQuery = rawQuery;
  if (!effectiveQuery && hasExplicitFilters) {
    const filterTokens = Object.values(explicitFilters).flatMap(v => Array.isArray(v) ? v : [v]).filter(Boolean);
    effectiveQuery = filterTokens.join(' ');
  }

  let userEmail = 'anonymous';
  if (req.user?.id) {
    try {
      const u = await User.findById(req.user.id).select('email').lean();
      if (u) userEmail = u.email;
    } catch { /* best-effort */ }
  }

  // §10.5: fire-and-forget — don't block the response on the history write
  if (req.user?.id) {
    SearchHistory.create({ userId: req.user.id, query: (rawQuery || effectiveQuery).slice(0, 500) })
      .catch((err) => logger.warn(`SearchHistory write failed: ${err.message}`));
  }

  // ── Feature flag: new Retrieval Orchestrator (§18.5) ──────────────────────
  if (env.featureFlags?.useNewOrchestrator) {
    const orchestratorResult = await orchestrateSearch(
      effectiveQuery || 'neuroscience datasets',
      hasExplicitFilters ? explicitFilters : null,
      { userId: req.user?.id, userEmail }
    );

    await QueryLog.create({
      userId:       req.user?.id || null,
      rawQuery:     rawQuery,
      filters:      orchestratorResult.filters,
      resultSource: orchestratorResult.source,
      resultCount:  orchestratorResult.metrics.totalFound,
    }).catch((err) => logger.warn(`QueryLog write failed: ${err.message}`));

    return new ApiResponse(
      200,
      {
        source:  orchestratorResult.source,
        results: orchestratorResult.results,
        metrics: orchestratorResult.metrics,
      },
      orchestratorResult.results.length > 0
        ? 'Results found.'
        : 'No datasets found for this query.'
    ).send(res);
  }

  // ── Legacy path (unchanged) ───────────────────────────────────────────────
  let filters;
  try {
    filters = await parseQuery(effectiveQuery || 'neuroscience datasets', req.user?.id, userEmail);
  } catch (err) {
    logger.warn(`Dataset search parser fallback triggered for query="${effectiveQuery}": ${err.message}`);
    filters = { raw_query: effectiveQuery };
  }

  // Merge user explicit filters over parser filters
  if (hasExplicitFilters) {
    filters = { ...filters, ...explicitFilters, raw_query: effectiveQuery || filters.raw_query };
  }

  const cachedResults = await searchDatasets(filters);

  if (cachedResults.length > 0) {
    await QueryLog.create({
      userId: req.user?.id || null,
      rawQuery: query,
      filters,
      resultSource: 'cache',
      resultCount: cachedResults.length,
    });
    return new ApiResponse(200, { source: 'cache', results: cachedResults }, 'Results found.').send(res);
  }

  // Cache miss: return Python's verified records directly.
  let fallbackDatasets = [];
  try {
    const agentResult = await runFallbackSearch({
      query,
      filters,
      userId: req.user?.id,
      userEmail,
    });
    fallbackDatasets = Array.isArray(agentResult?.datasets) ? agentResult.datasets : [];
  } catch (err) {
    logger.error(`Fallback agent search failed for query="${query}": ${err.message}`);
    throw new ApiError(502, 'Dataset fallback search could not be completed. Please try again.');
  }

  await QueryLog.create({
    userId: req.user?.id || null,
    rawQuery: query,
    filters,
    resultSource: 'fallback',
    resultCount: fallbackDatasets.length,
  });

  return new ApiResponse(
    200,
    { source: 'agent', results: fallbackDatasets },
    fallbackDatasets.length > 0 ? 'Results found via live search.' : 'No datasets found for this query.'
  ).send(res);
});

// GET /datasets/:id — fetch a single dataset by Mongo _id or source_id for the detail page
const getById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const mongoose = require('mongoose');
  let dataset = null;
  if (mongoose.Types.ObjectId.isValid(id)) {
    dataset = await Dataset.findById(id).lean();
  }
  if (!dataset) {
    dataset = await Dataset.findOne({ source_id: id }).lean();
  }
  if (!dataset) throw new ApiError(404, 'Dataset not found.');
  return new ApiResponse(200, dataset).send(res);
});

module.exports = { search, getById };

