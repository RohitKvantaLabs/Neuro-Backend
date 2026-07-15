const axios = require('axios');
const env = require('../../config/env.config');
const logger = require('../../utils/logger');

/**
 * The only place in this codebase that calls the Python agent service.
 * Every call carries the shared internal secret - see
 * NODE_INTEGRATION_CONTRACT.md for the exact request/response shapes.
 */
const client = axios.create({
  baseURL: env.pythonAgent.baseUrl,
  timeout: env.pythonAgent.timeoutMs,
  headers: {
    'X-Internal-Secret': env.pythonAgent.internalSecret,
    'Content-Type': 'application/json',
  },
});

/**
 * BLOCKING - Node waits for this before querying Mongo. See CLAUDE.md
 * (Python repo) constraint: this is deliberately synchronous.
 */
async function parseQuery(query) {
  try {
    const { data } = await client.post('/agents/parse-query', { query });
    const filters = data?.filters && typeof data.filters === 'object' ? data.filters : {};

    return {
      ...filters,
      raw_query: query,
      modality: Array.isArray(filters.modality) ? filters.modality : [],
      species: Array.isArray(filters.species) ? filters.species : [],
      condition: Array.isArray(filters.condition) ? filters.condition : [],
      task: filters.task || null,
      format: Array.isArray(filters.format) ? filters.format : [],
    };
  } catch (err) {
    logger.warn(`Python parse-query failed for query="${query}": ${err.message}`);
    return {
      raw_query: query,
      modality: [],
      species: [],
      condition: [],
      task: null,
      format: [],
    };
  }
}

/**
 * Fire-and-forget from Node's perspective - we do not need to await the
 * response body's content, but the request itself should not be
 * cancelled early. Node typically calls this and immediately returns a
 * query_id to the frontend so it can open an SSE connection, without
 * waiting on this promise to resolve.
 */
async function triggerFallbackSearch({ queryId, query, filters }) {
  try {
    const { data } = await client.post('/agents/fallback-search', {
      query_id: queryId,
      query,
      filters,
    });
    logger.info(`Fallback search completed for query_id=${queryId}: datasets_found=${data.datasets_found}`);
    return data;
  } catch (err) {
    // Don't throw - the frontend is waiting on the SSE channel, not this
    // promise. Log loudly so a failure here isn't silently invisible.
    logger.error(`Fallback search request failed for query_id=${queryId}: ${err.message}`);
    return null;
  }
}

module.exports = { parseQuery, triggerFallbackSearch };
