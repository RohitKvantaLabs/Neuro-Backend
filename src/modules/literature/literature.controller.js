'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const env = require('../../config/env.config');
const { parseQuery } = require('../agent/agent.client');
const { orchestrateLiterature } = require('./literatureOrchestrator');
const { User } = require('../user/user.model');

const searchLiterature = asyncHandler(async (req, res) => {
  if (env.featureFlags?.useLiterature === false) {
    throw new ApiError(404, 'Literature search is disabled');
  }

  const { query } = req.body;
  const rawQuery = typeof query === 'string' ? query.trim() : '';
  if (!rawQuery || rawQuery.length < 2) {
    throw new ApiError(400, 'A query string of at least 2 characters is required.');
  }

  let filters;
  try {
    filters = await parseQuery(rawQuery, req.user?.id || null, req.user?.email || 'anonymous');
  } catch (err) {
    logger.warn(`[Literature] parseQuery failed: ${err.message} — using raw fallback`);
    filters = { raw_query: rawQuery, modality: [], condition: [], task: null, region: null, age_range: null, species: [], keywords: [] };
  }
  if (!filters.raw_query) filters.raw_query = rawQuery;

  // Domain guard: if not neuroscience, still allow literature but mark
  // We do not block literature on in_domain false; papers exist beyond neuro
  const litResult = await orchestrateLiterature(filters);

  return new ApiResponse(200, {
    query: rawQuery,
    filters,
    results: litResult.results,
    metrics: litResult.metrics,
    cacheHit: litResult.cacheHit,
    latencyMs: litResult.latencyMs,
  }, litResult.results.length > 0 ? 'Literature found.' : 'No sufficiently relevant research papers were found.').send(res);
});

module.exports = { searchLiterature };
