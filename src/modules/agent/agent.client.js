const axios = require('axios');
const crypto = require('crypto');
const env = require('../../config/env.config');
const logger = require('../../utils/logger');
const TokenUsage = require('../admin/tokenUsage.model');
const AgentLog = require('../admin/agentLog.model');
const ExternalApiLog = require('../admin/externalApiLog.model');
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
async function parseQuery(query, userId = null, userEmail = 'anonymous', requestId = null) {
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
    const headers = {};
    if (requestId) headers['X-Request-Id'] = requestId;
    const { data } = await _pythonAgentCB.wrap(
      () => client.post('/agents/parse-query', { query }, { headers })
    )();
    const filters = data?.filters && typeof data.filters === 'object' ? data.filters : {};

    const modality = Array.isArray(filters.modality) ? filters.modality : [];
    const species = Array.isArray(filters.species) ? filters.species : [];
    const condition = Array.isArray(filters.condition) ? filters.condition : [];
    const task = filters.task || null;
    const region = filters.region || null;
    const age_range = filters.age_range || null;
    const format = Array.isArray(filters.format) ? filters.format : [];

    const hasStructuredSignal = Boolean(
      modality.length > 0 || species.length > 0 || condition.length > 0 ||
      task || region || age_range || format.length > 0
    );
    const text = (query || '').toLowerCase().trim();
    const neuroKeywords = [
      'fmri', 'eeg', 'meg', 'smri', 'dti', 'pet', 'ieeg', 'adhd', 'alzheimer', 'dementia',
      'autism', 'parkinson', 'depression', 'epilepsy', 'covid', 'schizophrenia', 'bipolar',
      'seizure', 'hippocampus', 'amygdala', 'cerebellum', 'thalamus', 'striatum', 'cortex',
      'brainstem', 'bids', 'nifti', 'dicom', 'neuroscience', 'neuroimaging', 'brain',
      'dataset', 'datasets', 'electrophysiology', 'connectome'
    ];
    const hasNeuroKeyword = text.length > 0 && neuroKeywords.some((k) => text.includes(k));
    const in_domain = hasStructuredSignal || hasNeuroKeyword;

    const result = {
      ...filters,
      raw_query: query,
      modality,
      species,
      condition,
      task,
      region,
      age_range,
      format,
      in_domain,
    };

    // ponytail: store in cache before returning.
    _parseCache.set(query, { filters: result, expiresAt: Date.now() + PARSE_CACHE_TTL_MS });

    const duration = Date.now() - start;
    const usage = data?.usage || null;
    const hasActual = usage && usage.prompt_tokens != null && usage.completion_tokens != null;
    const inputTokens = hasActual ? usage.prompt_tokens : null;
    const outputTokens = hasActual ? usage.completion_tokens : null;
    const totalTokens = hasActual ? (usage.total_tokens ?? (inputTokens + outputTokens)) : null;
    const usageType = hasActual ? 'actual' : 'estimated';
    const tokens = hasActual ? totalTokens : (estimateTokens(query) + (data?.filters ? estimateTokens(JSON.stringify(data.filters)) : 0));
    const provider = hasActual ? (usage.provider || data?.provider || 'groq') : (data?.provider || 'groq');
    const modelUsed = (hasActual && usage.model) ? usage.model : (data?.model || env.pythonAgent.model);

    // Fire-and-forget token & agent logging
    TokenUsage.create({
      requestId: requestId || null,
      userId,
      userEmail,
      agent: 'parse_query',
      provider,
      model: modelUsed,
      tokens: tokens || 0,
      inputTokens,
      outputTokens,
      totalTokens,
      usageType,
      query: query.slice(0, 500),
      durationMs: duration,
      status: 'success',
    }).catch(() => {});
    AgentLog.create({
      requestId: requestId || null,
      queryId: null,
      agent: 'parse_query',
      provider,
      model: modelUsed,
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
      requestId: requestId || null,
      queryId: null,
      agent: 'parse_query',
      provider: 'groq',
      model: env.pythonAgent.model,
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
async function runRepositorySearch({ query, filters, sources, limitPerSource, userId = null, userEmail = 'anonymous', requestId = null }) {
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
    const repoHeaders = {};
    if (requestId) repoHeaders['X-Request-Id'] = requestId;
    const { data } = await _pythonAgentCB.wrap(
      () => client.post('/agents/repository-search', {
        query,
        filters,
        sources,
        limit_per_source: limitPerSource,
      }, { headers: repoHeaders })
    )();

    // ponytail: store in cache before returning.
    _repoSearchCache.set(cacheKey, { data, expiresAt: Date.now() + REPO_SEARCH_CACHE_TTL_MS });

    const duration = Date.now() - start;
    // Repository search does not use LLM — keep estimated placeholder for observability
    const tokens = estimateTokens(query) + estimateTokens(JSON.stringify(filters || {}));
    const repoModel = data?.model || env.pythonAgent.model;

    logger.info(`Repository search completed for query="${query}": sources=${data?.sources_queried?.length ?? 0}, total_found=${data?.total_found ?? 0}`);

    // Fire-and-forget token & agent logging
    TokenUsage.create({
      requestId: requestId || null,
      userId: userId || null,
      userEmail: userEmail || 'anonymous',
      agent: 'repository_search',
      provider: 'heuristic',
      model: repoModel,
      tokens,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      usageType: 'estimated',
      query: query.slice(0, 500),
      durationMs: duration,
      status: 'success',
    }).catch(() => {});
    AgentLog.create({
      requestId: requestId || null,
      queryId: data?.query_id || null,
      userId: userId || null,
      agent: 'repository_search',
      provider: 'heuristic',
      model: repoModel,
      query: query.slice(0, 500),
      durationMs: duration,
      resultCount: data?.total_found ?? 0,
      status: 'success',
    }).catch(() => {});

    // Phase 5: external API per-service telemetry (fire-and-forget, never breaks search)
    const extCalls = Array.isArray(data?.external_calls) ? data.external_calls : [];
    for (const ec of extCalls) {
      ExternalApiLog.create({
        requestId: requestId || null,
        queryId: data?.query_id || null,
        service: String(ec.service || 'unknown'),
        operation: String(ec.operation || 'search'),
        endpoint: ec.endpoint ? String(ec.endpoint) : null,
        durationMs: typeof ec.durationMs === 'number' ? ec.durationMs : 0,
        status: ec.status === 'error' ? 'error' : 'success',
        httpStatus: typeof ec.httpStatus === 'number' ? ec.httpStatus : null,
        error: ec.error ? String(ec.error).slice(0, 500) : null,
      }).catch(() => {});
    }

    return data; // { query_id, sources_queried, total_found, elapsed_ms, datasets }
  } catch (err) {
    const duration = Date.now() - start;
    logger.warn(`Repository search failed for query="${query}": ${err.message}`);

    AgentLog.create({
      requestId: requestId || null,
      queryId: null,
      userId: userId || null,
      agent: 'repository_search',
      provider: 'heuristic',
      model: env.pythonAgent.model,
      query: query.slice(0, 500),
      durationMs: duration,
      resultCount: 0,
      status: 'error',
      errorMessage: err.message,
    }).catch(() => {});

    ExternalApiLog.create({
      requestId: requestId || null,
      queryId: null,
      service: 'repository_search',
      operation: 'search',
      endpoint: 'aggregate',
      durationMs: duration,
      status: 'error',
      httpStatus: err.response?.status ?? null,
      error: err.message ? String(err.message).slice(0, 500) : null,
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
async function runFallbackSearch({ query, filters, userId, userEmail, requestId = null }) {
  const start = Date.now();
  const fallbackQueryId = crypto.randomUUID();
  try {
    const fallbackHeaders = {};
    if (requestId) fallbackHeaders['X-Request-Id'] = requestId;
    const { data } = await _pythonAgentCB.wrap(
      () => client.post('/agents/fallback-search', {
      query_id: fallbackQueryId,
      query,
      filters,
      }, { headers: fallbackHeaders })
    )();
    const duration = Date.now() - start;
    const fbUsage = data?.usage || null;
    const fbHasActual = fbUsage && fbUsage.prompt_tokens != null && fbUsage.completion_tokens != null;
    const fbInputTokens = fbHasActual ? fbUsage.prompt_tokens : null;
    const fbOutputTokens = fbHasActual ? fbUsage.completion_tokens : null;
    const fbTotalTokens = fbHasActual ? (fbUsage.total_tokens ?? (fbInputTokens + fbOutputTokens)) : null;
    const fbUsageType = fbHasActual ? 'actual' : 'estimated';
    const fbTokens = fbHasActual ? fbTotalTokens : (estimateTokens(query) + estimateTokens(JSON.stringify(filters || {})));
    const fbProvider = fbHasActual ? (fbUsage.provider || data?.provider || 'groq') : (data?.provider || 'groq');
    const fbModelUsed = (fbHasActual && fbUsage.model) ? fbUsage.model : (data?.model || env.pythonAgent.model);

    logger.info(`Fallback agent search completed for query="${query}": datasets_found=${data?.datasets_found ?? 0}, published=${data?.published}`);

    // Fire-and-forget token & agent logging
    TokenUsage.create({
      requestId: requestId || null,
      userId: userId || null,
      userEmail: userEmail || 'anonymous',
      agent: 'fallback',
      provider: fbProvider,
      model: fbModelUsed,
      tokens: fbTokens || 0,
      inputTokens: fbInputTokens,
      outputTokens: fbOutputTokens,
      totalTokens: fbTotalTokens,
      usageType: fbUsageType,
      query: query.slice(0, 500),
      durationMs: duration,
      status: 'success',
    }).catch(() => {});
    AgentLog.create({
      requestId: requestId || null,
      queryId: data?.query_id || fallbackQueryId,
      userId: userId || null,
      agent: 'fallback',
      provider: fbProvider,
      model: fbModelUsed,
      query: query.slice(0, 500),
      durationMs: duration,
      resultCount: data?.datasets_found ?? 0,
      status: 'success',
    }).catch(() => {});

    // Phase 5: Tavily external call telemetry
    const fbExtCalls = Array.isArray(data?.external_calls) ? data.external_calls : [];
    for (const ec of fbExtCalls) {
      ExternalApiLog.create({
        requestId: requestId || null,
        queryId: data?.query_id || fallbackQueryId,
        service: String(ec.service || 'tavily'),
        operation: String(ec.operation || 'search'),
        endpoint: ec.endpoint ? String(ec.endpoint) : null,
        durationMs: typeof ec.durationMs === 'number' ? ec.durationMs : 0,
        status: ec.status === 'error' ? 'error' : 'success',
        httpStatus: typeof ec.httpStatus === 'number' ? ec.httpStatus : null,
        error: ec.error ? String(ec.error).slice(0, 500) : null,
      }).catch(() => {});
    }
    if (fbExtCalls.length === 0 && data?.datasets_found != null) {
      // Fallback succeeded without explicit external_calls (e.g., no Tavily) — still log aggregate for observability
      // Only log if we had a fallback attempt; Tavily may have been skipped (Null provider)
    }

    return data; // { query_id, datasets_found, published } — no dataset array
  } catch (err) {
    const duration = Date.now() - start;
    logger.error(`Fallback agent search failed for query="${query}": ${err.message}`);

    AgentLog.create({
      requestId: requestId || null,
      queryId: fallbackQueryId,
      userId: userId || null,
      agent: 'fallback',
      provider: 'groq',
      model: env.pythonAgent.model,
      query: query.slice(0, 500),
      durationMs: duration,
      resultCount: 0,
      status: 'error',
      errorMessage: err.message,
    }).catch(() => {});

    ExternalApiLog.create({
      requestId: requestId || null,
      queryId: fallbackQueryId,
      service: 'fallback',
      operation: 'search',
      endpoint: 'fallback',
      durationMs: duration,
      status: 'error',
      httpStatus: err.response?.status ?? null,
      error: err.message ? String(err.message).slice(0, 500) : null,
    }).catch(() => {});

    throw err; // re-throw for the controller to handle
  }
}

module.exports = { parseQuery, runFallbackSearch, runRepositorySearch, runRepositorySync };
