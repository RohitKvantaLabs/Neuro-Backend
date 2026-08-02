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

// §4.7 — in-process repository-search result cache. Same filters within the
// configured TTL (default 5 min, §5.2) skip the Python repository tier entirely.
// Key = stable JSON of { filters, sources, limitPerSource } — mirrors _parseCache.
const _repoSearchCache = new Map();
const REPO_SEARCH_CACHE_TTL_MS = env.repositoryRetrieval?.cacheTtlMs || 5 * 60 * 1000;

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
      resultCount: 0,
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
 * §4.7/§4.2 — repository tier search.
 *
 * POST /agents/repository-search: Python runs the enabled connectors in
 * parallel, aggregates the candidate pool, runs quality pipeline stages 1–6
 * (no publish) and returns scored/deduped Dataset[] directly in the response.
 *
 * Results are cached in-process for REPO_SEARCH_CACHE_TTL_MS keyed on the
 * stable JSON of { filters, sources, limitPerSource } — identical filters
 * within the TTL skip the Python repository tier entirely.
 *
 * Returns: { query_id, sources_queried, total_found, elapsed_ms, datasets }
 * Throws on HTTP/network failure — the orchestrator degrades to the web tier.
 */
async function runRepositorySearch({ query, filters, sources, limitPerSource, userId = null, userEmail = 'anonymous' }) {
  const cacheKey = JSON.stringify({ filters, sources, limitPerSource });

  // ponytail: cache hit — skip the Python repository tier entirely.
  const cached = _repoSearchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    logger.info(`runRepositorySearch cache hit for query="${query}"`);
    return cached.data;
  }

  const start = Date.now();
  try {
    // Circuit breaker wraps the HTTP call — if Python is down/slow, we
    // fast-fail instead of blocking for the full timeout.
    const { data } = await _pythonAgentCB.wrap(
      () => client.post('/agents/repository-search', {
        query,
        filters,
        sources,
        limit_per_source: limitPerSource,
      })
    )();

    // ponytail: store in cache before returning.
    _repoSearchCache.set(cacheKey, { data, expiresAt: Date.now() + REPO_SEARCH_CACHE_TTL_MS });

    const duration = Date.now() - start;
    const tokens = estimateTokens(query) + estimateTokens(JSON.stringify(filters || {}));

    logger.info(`Repository search completed for query="${query}": sources=${data?.sources_queried?.length ?? 0}, total_found=${data?.total_found ?? 0}`);

    // Fire-and-forget token & agent logging
    TokenUsage.create({
      userId: userId || null,
      userEmail: userEmail || 'anonymous',
      agent: 'repository_search',
      model: data?.model || env.pythonAgent.model,
      tokens,
      query: query.slice(0, 500),
      durationMs: duration,
      status: 'success',
    }).catch(() => {});
    AgentLog.create({
      userId: userId || null,
      agent: 'repository_search',
      query: query.slice(0, 500),
      durationMs: duration,
      resultCount: data?.total_found ?? 0,
      status: 'success',
    }).catch(() => {});

    return data; // { query_id, sources_queried, total_found, elapsed_ms, datasets }
  } catch (err) {
    const duration = Date.now() - start;
    logger.warn(`Repository search failed for query="${query}": ${err.message}`);

    AgentLog.create({
      userId: userId || null,
      agent: 'repository_search',
      query: query.slice(0, 500),
      durationMs: duration,
      resultCount: 0,
      status: 'error',
      errorMessage: err.message,
    }).catch(() => {});

    throw err; // re-throw for the orchestrator to degrade (repo tier → web tier)
  }
}

/**
 * §4.7 — admin resync trigger.
 *
 * POST /agents/repository-sync: Python runs the batch pipeline (fetch →
 * normalize → quality pipeline stages 1–7 publish) for one/all sources and
 * returns per-source PipelineResult.
 *
 * Returns: { results: { [source]: PipelineResult } }
 * Throws on HTTP/network failure — admin.controller marks the repo offline.
 */
async function runRepositorySync({ source = null, limitPerSource = null, embed = true }) {
  const start = Date.now();
  try {
    const { data } = await _pythonAgentCB.wrap(
      () => client.post('/agents/repository-sync', {
        source,
        limit_per_source: limitPerSource,
        embed,
      })
    )();
    const duration = Date.now() - start;
    logger.info(`Repository sync completed for source="${source || 'all'}" in ${duration}ms`);
    return data; // { results: { [source]: PipelineResult } }
  } catch (err) {
    logger.error(`Repository sync failed for source="${source || 'all'}": ${err.message}`);
    throw err; // re-throw for the admin controller to mark the repo offline
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

module.exports = { parseQuery, runFallbackSearch, runRepositorySearch, runRepositorySync };
