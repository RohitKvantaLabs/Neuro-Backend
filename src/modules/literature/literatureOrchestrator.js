'use strict';

const logger = require('../../utils/logger');
const { buildLiteratureQuery } = require('./literatureQuery');
const { normalizeLiteratureResults } = require('./literatureNormalizer');
const { deduplicateLiterature } = require('./literatureDedup');
const { rankLiterature } = require('./literatureRanker');
const { OpenAlexProvider } = require('./openalex.provider');
const { TavilyLiteratureProvider } = require('./tavilyLiterature.provider');
const { TtlCache } = require('../../utils/ttlCache');

const literatureCache = new TtlCache({ ttlMs: 5 * 60 * 1000 });

/**
 * Fire-and-forget ExternalApiLog helper — observational only, never breaks literature path.
 * Uses existing ExternalApiLog model (Phase 5) with service `openalex`/`tavily` and operation `literature_search`.
 */
function logLiteratureExternal(requestId, service, operation, endpoint, durationMs, status, httpStatus, error) {
  try {
    const ExternalApiLog = require('../admin/externalApiLog.model');
    ExternalApiLog.create({
      requestId: requestId || null,
      queryId: null,
      service: String(service),
      operation: String(operation),
      endpoint: endpoint ? String(endpoint) : null,
      durationMs: typeof durationMs === 'number' ? Math.round(durationMs) : 0,
      status: status === 'error' ? 'error' : 'success',
      httpStatus: typeof httpStatus === 'number' ? httpStatus : null,
      error: error ? String(error).slice(0, 500) : null,
    }).catch(() => {});
  } catch { /* never break literature */ }
}

/**
 * Literature lane orchestration — independent from dataset lane.
 * Parallel execution: datasetOrchestrator and literatureOrchestrator can be awaited together.
 */
async function orchestrateLiterature(filters, options = {}) {
  const startMs = Date.now();
  const literatureQuery = buildLiteratureQuery(filters);
  const cacheKey = JSON.stringify({ q: literatureQuery.literatureSearch, concepts: literatureQuery.concepts });
  const cached = literatureCache.get(cacheKey);
  if (cached) {
    logger.info(`[Literature] cache hit for "${literatureQuery.literatureSearch}"`);
    return { ...cached, cacheHit: true, latencyMs: Date.now() - startMs };
  }

  const limit = options.limit || 10;
  const providers = options.providers || [new OpenAlexProvider(), new TavilyLiteratureProvider()];

  // Parallel provider calls, isolated failures — with ExternalApiLog telemetry (Phase 12, observational)
  const requestId = options.requestId || null;
  const rawByProvider = await Promise.all(
    providers.map(async (p) => {
      const provStart = Date.now();
      const isOpenAlex = p.name.toLowerCase().includes('openalex');
      const service = isOpenAlex ? 'openalex' : 'tavily';
      const operation = 'literature_search';
      const endpoint = isOpenAlex ? 'works' : 'search';
      try {
        const raw = await Promise.race([
          p.search(literatureQuery, { limit }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('literature provider timeout 8s')), 8000)),
        ]);
        const dur = Date.now() - provStart;
        logLiteratureExternal(requestId, service, operation, endpoint, dur, 'success', 200, null);
        return { provider: p.name, raw: Array.isArray(raw) ? raw : [], error: null };
      } catch (err) {
        const dur = Date.now() - provStart;
        const httpStatus = err.response?.status ?? (err.status ?? null);
        const isTimeout = err.message && err.message.includes('timeout');
        logLiteratureExternal(requestId, service, operation, endpoint, dur, 'error', typeof httpStatus === 'number' ? httpStatus : (isTimeout ? null : null), err.message);
        logger.warn(`[Literature] provider ${p.name} failed: ${err.message}`);
        return { provider: p.name, raw: [], error: err.message };
      }
    })
  );

  let candidates = [];
  let providersCalled = [];
  let providerErrors = [];
  for (const r of rawByProvider) {
    providersCalled.push(r.provider);
    if (r.error) providerErrors.push({ provider: r.provider, error: r.error });
    const norm = normalizeLiteratureResults(
      r.provider.toLowerCase().includes('openalex') ? 'openalex' : 'tavily',
      r.raw
    );
    // tag provider on each candidate already done in normalizer
    candidates.push(...norm);
  }

  const beforeDedup = candidates.length;
  const deduped = deduplicateLiterature(candidates);
  const ranked = rankLiterature(deduped, literatureQuery);

  const result = {
    query: literatureQuery,
    results: ranked,
    metrics: {
      beforeDedup,
      afterDedup: deduped.length,
      totalFound: ranked.length,
      providersCalled,
      providerErrors,
    },
    cacheHit: false,
    latencyMs: Date.now() - startMs,
  };

  literatureCache.set(cacheKey, { ...result, latencyMs: 0 });
  logger.info(`[Literature] query="${literatureQuery.literatureSearch}" before=${beforeDedup} after=${deduped.length} ranked=${ranked.length} in ${result.latencyMs}ms`);
  return result;
}

module.exports = { orchestrateLiterature, literatureCache };
