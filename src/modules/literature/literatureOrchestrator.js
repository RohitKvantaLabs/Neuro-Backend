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

  // Parallel provider calls, isolated failures
  const rawByProvider = await Promise.all(
    providers.map(async (p) => {
      try {
        const raw = await Promise.race([
          p.search(literatureQuery, { limit }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('literature provider timeout 8s')), 8000)),
        ]);
        return { provider: p.name, raw: Array.isArray(raw) ? raw : [], error: null };
      } catch (err) {
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
