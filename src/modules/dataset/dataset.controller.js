const crypto = require('crypto');
const ApiError = require('../../utils/ApiError');
const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const logger = require('../../utils/logger');
const { parseQuery, triggerFallbackSearch } = require('../agent/agent.client');
const { searchDatasets } = require('./dataset.service');
const QueryLog = require('../queryLog/queryLog.model');
const SearchHistory = require('../user/searchHistory.model');

/**
 * POST /datasets/search
 *
 * Flow (matches NODE_INTEGRATION_CONTRACT.md):
 *   1. Blocking call to Python's parse-query -> structured filters
 *   2. Query Mongo with those filters
 *   3. Cache hit -> return results directly, done
 *   4. Cache miss -> fire off fallback-search (don't await it), return a
 *      queryId immediately so the frontend can open the SSE stream
 *
 * §10.5: Fire-and-forget SearchHistory write for authenticated users.
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

  // Cache miss: hand off to Python. Deliberately NOT awaited - the
  // frontend gets a queryId now and opens an SSE connection; the actual
  // result arrives asynchronously via Redis (see realtime/redis.subscriber.js).
  const queryId = crypto.randomUUID();
  triggerFallbackSearch({ queryId, query, filters }); // fire-and-forget on purpose

  await QueryLog.create({
    userId: req.user?.id || null,
    rawQuery: query,
    filters,
    resultSource: 'fallback',
    resultCount: 0, // unknown yet - fallback hasn't completed
  });

  return new ApiResponse(
    202,
    { source: 'fallback', queryId, streamUrl: `/api/v1/stream/${queryId}` },
    'Searching further - connect to the stream URL for results.'
  ).send(res);
});

module.exports = { search };
