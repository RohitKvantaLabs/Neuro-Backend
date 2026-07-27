const axios = require('axios');
const crypto = require('crypto');
const env = require('../../config/env.config');
const logger = require('../../utils/logger');
const TokenUsage = require('../admin/tokenUsage.model');
const AgentLog = require('../admin/agentLog.model');
const { CircuitBreaker } = require('../../utils/circuitBreaker');

// ponytail: in-process query-parse cache — same query within 5 min skips LLM entirely.
const _parseCache = new Map(); // key: query string, value: { filters, expiresAt }
const PARSE_CACHE_TTL_MS = 5 * 60 * 1000;

// Circuit breaker for Python agent calls — 5 failures within 30s opens
// for 30s of fast-fail, preventing cascading waits when the Python side
// is slow or down.
const _pythonAgentCB = new CircuitBreaker('python-agents', {
  failureThreshold: 5,
  recoveryTimeoutMs: 30_000,
});

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
 * Estimate tokens from a text string (rough heuristic: ~4 chars per token)
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * BLOCKING - Node waits for this before querying Mongo. See CLAUDE.md
 * (Python repo) constraint: this is deliberately synchronous.
 */
async function parseQuery(query, userId = null, userEmail = 'anonymous') {
  // ponytail: cache hit — skip LLM entirely for repeated queries.
  const cached = _parseCache.get(query);
  if (cached && cached.expiresAt > Date.now()) {
    logger.info(`parseQuery cache hit for query="${query}"`);
    return cached.filters;
  }

  const start = Date.now();
  try {
    // Circuit breaker wraps the actual HTTP call — if Python is down/slow,
    // we fast-fail instead of blocking for the full timeout.
    const { data } = await _pythonAgentCB.wrap(
      () => client.post('/agents/parse-query', { query })
    )();
    const filters = data?.filters && typeof data.filters === 'object' ? data.filters : {};

    const result = {
      ...filters,
      raw_query: query,
      modality: Array.isArray(filters.modality) ? filters.modality : [],
      species: Array.isArray(filters.species) ? filters.species : [],
      condition: Array.isArray(filters.condition) ? filters.condition : [],
      task: filters.task || null,
      format: Array.isArray(filters.format) ? filters.format : [],
    };

    // ponytail: store in cache before returning.
    _parseCache.set(query, { filters: result, expiresAt: Date.now() + PARSE_CACHE_TTL_MS });

    const duration = Date.now() - start;
    const tokens = estimateTokens(query) + (data?.filters ? estimateTokens(JSON.stringify(data.filters)) : 0);

    // Fire-and-forget token & agent logging
    TokenUsage.create({
      userId,
      userEmail,
      agent: 'parse_query',
      model: data?.model || env.pythonAgent.model,
      tokens,
      query: query.slice(0, 500),
      durationMs: duration,
      status: 'success',
    }).catch(() => {});
    AgentLog.create({
      agent: 'parse_query',
      query: query.slice(0, 500),
      durationMs: duration,
      resultCount: Object.keys(filters).length,
      status: 'success',
    }).catch(() => {});

    return result;
  } catch (err) {
    logger.warn(`Python parse-query failed for query="${query}": ${err.message}`);
    const duration = Date.now() - start;

    AgentLog.create({
      agent: 'parse_query',
      query: query.slice(0, 500),
      durationMs: duration,
      resultCount: 0,
      status: 'error',
      errorMessage: err.message,
    }).catch(() => {});

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
async function runFallbackSearch({ query, filters, userId, userEmail }) {
  const start = Date.now();
  try {
    const { data } = await _pythonAgentCB.wrap(
      () => client.post('/agents/fallback-search', {
      query_id: crypto.randomUUID(),
      query,
      filters,
      })
    )();
    const duration = Date.now() - start;
    const tokens = estimateTokens(query) + estimateTokens(JSON.stringify(filters || {}));

    logger.info(`Fallback agent search completed for query="${query}": datasets_found=${data?.datasets_found ?? 0}, published=${data?.published}`);

    // Fire-and-forget token & agent logging
    TokenUsage.create({
      userId: userId || null,
      userEmail: userEmail || 'anonymous',
      agent: 'fallback',
      model: data?.model || env.pythonAgent.model,
      tokens,
      query: query.slice(0, 500),
      durationMs: duration,
      status: 'success',
    }).catch(() => {});
    AgentLog.create({
      userId: userId || null,
      agent: 'fallback',
      query: query.slice(0, 500),
      durationMs: duration,
      resultCount: data?.datasets_found ?? 0,
      status: 'success',
    }).catch(() => {});

    return data; // { query_id, datasets_found, published } — no dataset array
  } catch (err) {
    const duration = Date.now() - start;
    logger.error(`Fallback agent search failed for query="${query}": ${err.message}`);

    AgentLog.create({
      userId: userId || null,
      agent: 'fallback',
      query: query.slice(0, 500),
      durationMs: duration,
      resultCount: 0,
      status: 'error',
      errorMessage: err.message,
    }).catch(() => {});

    throw err; // re-throw for the controller to handle
  }
}

module.exports = { parseQuery, runFallbackSearch };
