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
 * BLOCKING - waits for Python to finish writing datasets into Mongo,
 * then returns only the receipt. Python owns all writes to the datasets
 * collection; Node re-queries Mongo after this resolves to pick them up.
 * Returns: { query_id, datasets_found, published }
 * Throws on HTTP/network failure — let the controller handle it.
 */
async function runFallbackSearch({ query, filters }) {
  const { data } = await client.post('/agents/fallback-search', { query, filters });
  logger.info(`Fallback agent search completed for query="${query}": datasets_found=${data?.datasets_found ?? 0}, published=${data?.published}`);
  return data; // { query_id, datasets_found, published } — no dataset array
}

module.exports = { parseQuery, runFallbackSearch };
