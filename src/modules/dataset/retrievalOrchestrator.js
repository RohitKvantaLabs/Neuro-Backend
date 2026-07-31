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
const { parseQuery, runFallbackSearch }           = require('../agent/agent.client');
const { searchMongoDB }                           = require('./dataset.service');
const { analyzeQueryComplexity }                  = require('./queryComplexityAnalyzer');
const { computeRetrievalQuality, evaluate }       = require('./discoveryPolicy');
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
  // Step 4: Compute Retrieval Quality
  // ──────────────────────────────────────────────
  const quality = computeRetrievalQuality(mongodbResults, filters, complexity);

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
  // Step 6: External Discovery (if needed)
  // Option A: runFallbackSearch → Python writes to MongoDB → re-query → diff
  // ──────────────────────────────────────────────
  let discoveryResults = [];

  if (discoveryDecision.shouldDiscover) {
    const originalKeys = buildKeySet(mongodbResults);

    try {
      await runFallbackSearch({ query, filters, userId, userEmail });

      // Re-query MongoDB to pick up datasets the agent just wrote
      const afterResults = await searchMongoDB(filters);

      // Net-new datasets = those present after discovery but not before
      discoveryResults = extractNetNew(afterResults, originalKeys);

      logger.info(`[Orchestrator] Discovery complete — net-new datasets: ${discoveryResults.length}`);
    } catch (err) {
      // §7.5: Discovery failure → return MongoDB results only, log error
      logger.error(`[Orchestrator] Discovery agent failed: ${err.message} — falling back to MongoDB results only`);
      discoveryDecision = { ...discoveryDecision, shouldDiscover: false, reason: 'discovery_error' };
    }
  }

  // ──────────────────────────────────────────────
  // Step 7: Layer 3 — Merge + Rank
  // ──────────────────────────────────────────────
  let rankedResults;
  try {
    rankedResults = rank(mongodbResults, discoveryResults, filters);
  } catch (err) {
    // §7.5: Ranking failure → return unranked merged results
    logger.error(`[Orchestrator] Layer 3 ranking failed: ${err.message} — returning unranked`);
    rankedResults = [
      ...mongodbResults.map((ds) => ({ ...ds, _source: 'mongodb' })),
      ...discoveryResults.map((ds) => ({ ...ds, _source: 'discovery' })),
    ];
  }

  // ──────────────────────────────────────────────
  // Step 8: Return OrchestratorResult (§7.3)
  // ──────────────────────────────────────────────
  const source = discoveryDecision.shouldDiscover
    ? (discoveryResults.length > 0 ? 'merged' : 'cache')
    : 'cache';

  return {
    source,
    results: rankedResults,
    filters, // expose parsed filters for QueryLog
    metrics: {
      totalFound:       rankedResults.length,
      fromMongoDB:      mongodbResults.length,
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
