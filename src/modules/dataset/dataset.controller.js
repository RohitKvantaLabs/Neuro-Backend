const ApiError = require('../../utils/ApiError');
const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const logger = require('../../utils/logger');
const { parseQuery, runFallbackSearch } = require('../agent/agent.client');
const { searchDatasets } = require('./dataset.service');
const QueryLog = require('../queryLog/queryLog.model');
const SearchHistory = require('../user/searchHistory.model');

/**
 * POST /datasets/search
 *
 * Flow:
 *   1. Blocking call to Python's parse-query -> structured filters
 *   2. Query Mongo with those filters
 *   3. Cache hit -> return results directly, done
 *   4. Cache miss -> blocking call to Python's fallback-search
 *      Python writes any new matches into Mongo during that call.
 *      Re-run the same Mongo search to pick them up; return 200.
 *
 * §10.5: Fire-and-forget SearchHistory write for authenticated users.
 * Node stays read-only for the datasets collection — Python owns writes.
 */
const search = asyncHandler(async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    throw new ApiError(400, 'A query string of at least 2 characters is required.');
  }

  let filters;
  try {
    filters = await parseQuery(query);
  } catch (err) {
    logger.warn(`Dataset search parser fallback triggered for query="${query}": ${err.message}`);
    filters = { raw_query: query };
  }

  const cachedResults = await searchDatasets(filters);

  // §10.5: fire-and-forget — don't block the response on the history write
  if (req.user?.id) {
    SearchHistory.create({ userId: req.user.id, query: query.trim().slice(0, 500) })
      .catch((err) => logger.warn(`SearchHistory write failed: ${err.message}`));
  }

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

  // Cache miss: block on Python's fallback search.
  // Python writes any new datasets into Mongo as part of that same call.
  // Re-run Mongo search after the call resolves to pick them up.
  let agentReceipt = null;
  try {
    agentReceipt = await runFallbackSearch({ query, filters });
  } catch (err) {
    logger.error(`Fallback agent search failed for query="${query}": ${err.message}`);
  }

  // Python already wrote any new matches into Mongo by the time its
  // response returns — re-run the same search to pick them up.
  const freshResults = agentReceipt ? await searchDatasets(filters) : [];

  await QueryLog.create({
    userId: req.user?.id || null,
    rawQuery: query,
    filters,
    resultSource: 'fallback',
    resultCount: freshResults.length,
  });

  return new ApiResponse(
    200,
    { source: 'agent', results: freshResults },
    freshResults.length > 0 ? 'Results found via live search.' : 'No datasets found for this query.'
  ).send(res);
});

module.exports = { search };
