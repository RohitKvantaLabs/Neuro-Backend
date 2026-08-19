/**
 * RetrievalOrchestrator
 *
 * Coordinates the full retrieval pipeline:
 *   1. Parse query (Python agent)
 *   2. Search MongoDB (local knowledge)
 *   3. Compute retrieval quality metrics
 *   4. Consult Discovery Policy → decide if external discovery is needed
 *   5. If needed: run Discovery Agent (Python writes to MongoDB), then re-query
 *   6. Layer 3: merge + deduplicate + rank
 *   7. Return OrchestratorResult
 *
 * Architecture ref: §7 "Retrieval Orchestrator Design"
 *
 * Option A contract (approved by user):
 *   - runFallbackSearch() causes Python to write verified datasets to MongoDB
 *   - After it completes, re-query MongoDB with the same filters
 *   - Datasets present in the re-query but NOT in the original query
 *     are treated as discoveryResults and passed to Layer 3
 *   - agent.client.js is NOT modified — its interface stays unchanged
 */

const logger                                      = require('../../utils/logger');
const env                                         = require('../../config/env.config');
const { parseQuery, runFallbackSearch, runRepositorySearch } = require('../agent/agent.client');
const { searchMongoDB }                           = require('./dataset.service');
const { catalogSearch }                           = require('./catalogSearch.service'); // Option B hybrid branch
const { analyzeQueryComplexity }                  = require('./queryComplexityAnalyzer');
const { computeRetrievalQuality, evaluate, evaluateAfterRepositories } = require('./discoveryPolicy');
const { rank }                                    = require('./rankingEngine');

/**
 * Build a Set of stable unique keys from a result array.
 * Key = "source:source_id" — same dedup key used by Layer 3.
 */
function buildKeySet(results) {
  const keys = new Set();
  for (const ds of results) {
    if (ds.source && ds.source_id) keys.add(`${ds.source}:${ds.source_id}`);
  }
  return keys;
}

/**
 * Identify datasets in afterResults that were not in originalKeys.
 * These are the datasets newly written by the Discovery Agent.
 */
function extractNetNew(afterResults, originalKeys) {
  return afterResults.filter((ds) => {
    const key = `${ds.source}:${ds.source_id}`;
    return !originalKeys.has(key);
  });
}

/**
 * Coordinate the full retrieval pipeline.
 *
 * @param {string} query            - Raw user query string
 * @param {Object} explicitFilters  - Optional UI-supplied filters
 * @param {Object} userContext      - { userId, userEmail }
 * @returns {Promise<OrchestratorResult>} - { source, results, metrics }
 */
async function orchestrateSearch(query, explicitFilters, userContext = {}) {
  const startMs = Date.now();
  const { userId, userEmail = 'anonymous' } = userContext;

  // ──────────────────────────────────────────────
  // Step 1: Parse Query
  // ──────────────────────────────────────────────
  let filters;
  try {
    filters = await parseQuery(query, userId, userEmail);
  } catch (err) {
    logger.warn(`[Orchestrator] parseQuery failed: ${err.message} — using raw fallback`);
    filters = { raw_query: query, modality: [], species: [], condition: [], task: null, format: [] };
  }

  // Merge explicit UI filters over parser result
  if (explicitFilters && typeof explicitFilters === 'object') {
    const hasExplicit = Object.values(explicitFilters).some(
      (v) => (Array.isArray(v) ? v.length > 0 : Boolean(v))
    );
    if (hasExplicit) {
      filters = { ...filters, ...explicitFilters, raw_query: query || filters.raw_query };
    }
  }

  // ──────────────────────────────────────────────
  // Step 2: Query Complexity Analysis
  // ──────────────────────────────────────────────
  const complexity = analyzeQueryComplexity(filters);

  // ──────────────────────────────────────────────
  // Step 3: Local MongoDB Retrieval
  // ──────────────────────────────────────────────
  let mongodbResults = [];
  try {
    mongodbResults = await searchMongoDB(filters);
  } catch (err) {
    logger.error(`[Orchestrator] MongoDB search failed: ${err.message}`);
    // Continue — Discovery Agent may salvage results
  }

  // ──────────────────────────────────────────────
  // Step 3b: Catalog Retrieval (Option B hybrid — additive branch)
  // Only runs when FF_USE_CATALOG=true. The existing searchMongoDB path
  // above is completely unchanged regardless of this flag.
  // ──────────────────────────────────────────────
  let catalogResults = [];
  if (env.featureFlags?.useCatalog) {
    try {
      catalogResults = await catalogSearch(filters);
      logger.info(`[Orchestrator] Catalog branch — ${catalogResults.length} candidates`);
    } catch (err) {
      // Catalog failure: degrade gracefully, existing datasets results remain.
      logger.warn(`[Orchestrator] Catalog search failed: ${err.message} — continuing without catalog`);
      catalogResults = [];
    }
  }

  // ──────────────────────────────────────────────
  // Step 4: Compute Retrieval Quality
  // When FF_USE_CATALOG=true the combined local pool (catalog+datasets) is
  // evaluated. DiscoveryPolicy.computeRetrievalQuality() is pool-agnostic
  // (it reads any array of dataset-shaped docs) — no policy code changes.
  // When FF_USE_CATALOG=false, localPool === mongodbResults (flag-off parity).
  // ──────────────────────────────────────────────
  const localPool = catalogResults.length > 0 ? [...mongodbResults, ...catalogResults] : mongodbResults;
  const quality = computeRetrievalQuality(localPool, filters, complexity);

  // ──────────────────────────────────────────────
  // Step 5: Discovery Policy Evaluation
  // ──────────────────────────────────────────────
  let discoveryDecision;
  try {
    discoveryDecision = evaluate(quality, filters, {
      queryComplexity:     complexity,
      freshnessRequirement: complexity.freshness,
    });
  } catch (err) {
    logger.warn(`[Orchestrator] Discovery policy evaluation failed: ${err.message} — defaulting to discover`);
    // Conservative default: run discovery if policy computation fails (§7.5)
    discoveryDecision = { shouldDiscover: true, reason: 'policy_error', confidence: 0, signals: [] };
  }

  logger.info(
    `[Orchestrator] query="${query}" complexity=${complexity.level} ` +
    `mongoResults=${mongodbResults.length} shouldDiscover=${discoveryDecision.shouldDiscover} ` +
    `signals=${discoveryDecision.signals.join(',') || 'none'}`
  );

  // ──────────────────────────────────────────────
  // Step 6: Two-tier Discovery (if needed) — §4.4
  // Tier 1: repository search (free, fast) → Tier 2: web discovery only if
  // the combined Mongo+repo pool still fails the raised post-repo bar.
  // ──────────────────────────────────────────────
  let repositoryResults = [];
  let discoveryResults = [];

  if (discoveryDecision.shouldDiscover) {
    // Tier 1: repository search (§4.4) — gated by FF_USE_REPOSITORY_LAYER.
    if (env.featureFlags?.useRepositoryLayer && typeof runRepositorySearch === 'function') {
      try {
        const repoRes = await runRepositorySearch({ query, filters, userId, userEmail });
        repositoryResults = Array.isArray(repoRes?.datasets) ? repoRes.datasets : [];
        logger.info(`[Orchestrator] Repository tier complete — ${repositoryResults.length} datasets`);
      } catch (err) {
        // §7.5: repo failure → degrade to web tier
        logger.warn(`[Orchestrator] Repository search failed: ${err.message} — skipping repo tier`);
        repositoryResults = [];
      }
    }

    // Tier 2: web discovery only if repositories didn't satisfy quality (§4.4).
    // localPool already contains catalog+datasets; include repo results for re-evaluation.
    const combined = [...localPool, ...repositoryResults];
    const postRepoQuality = computeRetrievalQuality(combined, filters, complexity);
    let webDecision;
    try {
      webDecision = evaluateAfterRepositories(postRepoQuality, filters, {
        queryComplexity: complexity,
        freshnessRequirement: complexity.freshness,
      });
    } catch (err) {
      // Conservative default: run web discovery if post-repo policy fails
      logger.warn(`[Orchestrator] Post-repo policy evaluation failed: ${err.message} — defaulting to web discovery`);
      webDecision = { shouldDiscoverWeb: true, reason: 'policy_error', confidence: 0, signals: [] };
    }

    if (webDecision.shouldDiscoverWeb) {
      try {
        await runFallbackSearch({ query, filters, userId, userEmail });

        // Re-query MongoDB to pick up datasets the agent just wrote
        const afterResults = await searchMongoDB(filters);

        // Net-new datasets = those present after web discovery but not before
        // (mongo + repo keys are the baseline)
        discoveryResults = extractNetNew(afterResults, buildKeySet(combined));

        logger.info(`[Orchestrator] Web discovery complete — net-new datasets: ${discoveryResults.length}`);
      } catch (err) {
        // §7.5: Web discovery failure → return Mongo+repo results only, log error
        logger.error(`[Orchestrator] Web discovery failed: ${err.message} — falling back to Mongo+repo results only`);
        discoveryDecision = { ...discoveryDecision, shouldDiscover: false, reason: 'discovery_error' };
      }
    }
  }

  // ──────────────────────────────────────────────
  // Step 7: Layer 3 — Merge (3 pools) + Rank (§4.5)
  // When FF_USE_CATALOG=true: catalog results are combined with mongodbResults
  // as the first pool argument so datasets docs win on identical source:source_id
  // (datasets pool appears first in [...mongodbResults, ...catalogResults]).
  // rankingEngine.js rank()/deduplicate() are NOT modified.
  // When FF_USE_CATALOG=false: localPool === mongodbResults (identical behavior).
  // ──────────────────────────────────────────────
  let rankedResults;
  try {
    rankedResults = rank(localPool, repositoryResults, discoveryResults, filters);
  } catch (err) {
    // §7.5: Ranking failure → return unranked merged results
    logger.error(`[Orchestrator] Layer 3 ranking failed: ${err.message} — returning unranked`);
    rankedResults = [
      ...localPool.map((ds) => ({ ...ds, _source: ds._source || 'mongodb' })),
      ...discoveryResults.map((ds) => ({ ...ds, _source: 'discovery' })),
    ];
  }

  // ──────────────────────────────────────────────
  // Step 8: Return OrchestratorResult (§7.3) — source is 'merged' when the
  // repository or web tier contributed anything (§4.7).
  // ──────────────────────────────────────────────
  const source = (repositoryResults.length > 0 || discoveryResults.length > 0)
    ? 'merged'
    : 'cache';

  return {
    source,
    results: rankedResults,
    filters, // expose parsed filters for QueryLog
    metrics: {
      totalFound:       rankedResults.length,
      fromMongoDB:      mongodbResults.length,
      fromCatalog:      catalogResults.length,   // NEW — catalog candidates (0 when flag OFF)
      fromRepository:   repositoryResults.length,
      fromDiscovery:    discoveryResults.length,
      queryComplexity:  complexity.level,
      qualityScore:     quality.avgMetadataCompleteness,
      discoveryReason:  discoveryDecision.reason,
      signals:          discoveryDecision.signals,
      latencyMs:        Date.now() - startMs,
    },
  };
}

module.exports = { orchestrateSearch };
