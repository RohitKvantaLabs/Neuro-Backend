/**
 * DiscoveryPolicy
 *
 * Pure computation — no I/O, no network calls, no database queries.
 * Evaluates whether external discovery (Discovery Agent) is needed
 * based on multi-signal quality assessment of MongoDB results.
 *
 * Architecture ref: §8 "Discovery Policy Design"
 *
 * Signals (§8.5):
 *   1. zero_results          — weight 1.0 (always trigger)
 *   2. low_result_count      — weight 0.8
 *   3. poor_field_coverage   — weight 0.7
 *   4. freshness_requirement — weight 0.6
 *   5. low_metadata_quality  — weight 0.5
 *   6. high_query_complexity — weight 0.4
 *   7. low_confidence_results— weight 0.3
 */

const env = require('../../config/env.config');

// Default thresholds — overridden by env.discoveryPolicy config (§Appendix A)
const defaults = {
  minResults: 3,
  fieldCoverageThreshold: 0.3,
  qualityThreshold: 0.4,
  freshnessDays: 180,
  decisionThreshold: 0.5,
};

// Bounded multi-signal aggregation (Retrieval V2 Phase 14).
//
// BEFORE (V1): aggregatedConfidence = Math.max(triggered weights) — multiple
// meaningful weak signals could never combine (0.4 + 0.3 stayed 0.4 < 0.5),
// so discovery under-triggered exactly when local coverage was broadly poor.
//
// AFTER (V2): discounted accumulation over the TOP-K signals:
//   confidence = Σ w_i · DECAY^i   (weights sorted DESC, i from 0)
//   capped at CAP.
//
// Properties (cost discipline preserved):
//   - a single strong signal still triggers on its own (decay^0 = 1);
//   - two meaningful weak signals CAN combine: 0.4 + 0.3·0.6 = 0.58 ≥ 0.5;
//   - a single weak signal still cannot: 0.4 or 0.3 < 0.5 (no trivial
//     single-signal discovery);
//   - many trivial signals cannot force discovery: only the TOP-K=3 largest
//     weights participate, the geometric decay shrinks each follower, and the
//     hard cap bounds worst-case spend;
//   - every decision is explainable: per-signal contributions are returned
//     for telemetry.
const AGGREGATION_TOP_K = 3;
const AGGREGATION_DECAY = 0.6;
const AGGREGATION_CAP = 0.9;

/**
 * Aggregate triggered signals into one bounded confidence plus an explainable
 * contribution breakdown (telemetry, Phase 14 requirement).
 */
function aggregateSignals(triggered) {
  const sorted = [...triggered].sort((a, b) => b.weight - a.weight).slice(0, AGGREGATION_TOP_K);
  let total = 0;
  const contributions = sorted.map((s, i) => {
    const factor = Math.pow(AGGREGATION_DECAY, i);
    const contribution = Math.round(((s.weight * factor) + Number.EPSILON) * 10000) / 10000;
    total += contribution;
    return { signal: s.name, weight: s.weight, factor, contribution };
  });
  return {
    confidence: Math.min(Math.round(total * 10000) / 10000, AGGREGATION_CAP),
    contributions,
  };
}

function getThresholds() {
  const dp = env.discoveryPolicy || {};
  return {
    minResults:             dp.minResults             ?? defaults.minResults,
    fieldCoverageThreshold: dp.fieldCoverageThreshold ?? defaults.fieldCoverageThreshold,
    qualityThreshold:       dp.qualityThreshold       ?? defaults.qualityThreshold,
    freshnessDays:          dp.freshnessDays          ?? defaults.freshnessDays,
    decisionThreshold:      dp.decisionThreshold      ?? defaults.decisionThreshold,
  };
}

/**
 * Compute per-field coverage metrics from the MongoDB result set.
 *
 * @param {Object[]} results  - MongoDB dataset documents
 * @param {Object}   filters  - QueryFilters from parseQuery
 * @returns {Object} fieldCoverage map as described in §8.3
 */
function computeFieldCoverage(results, filters) {
  const total = results.length;
  const coverage = {};

  // Map from filter key → dataset field(s) to check
  const fieldMap = {
    modality:  (ds, val) => (ds.modality  || []).some((m) => m.toLowerCase() === val.toLowerCase()),
    species:   (ds, val) => (ds.species   || []).some((s) => s.toLowerCase() === val.toLowerCase()),
    condition: (ds, val) => {
      const v = val.toLowerCase();
      return (
        (ds.disease  || '').toLowerCase().includes(v) ||
        (ds.keywords || []).some((k) => k.toLowerCase().includes(v))
      );
    },
    // Retrieval V2 Phase 11: task is first-class metadata — coverage checks
    // the stored canonical task field as well as keywords.
    task: (ds, val) =>
      (ds.keywords || []).some((k) => k.toLowerCase().includes(val.toLowerCase())) ||
      Boolean(
        ds.task &&
          (String(ds.task).toLowerCase().includes(val.toLowerCase()) ||
            val.toLowerCase().includes(String(ds.task).toLowerCase()))
      ),
    region: (ds, val) => (ds.region || '').toLowerCase().includes(val.toLowerCase()),
    age_range:  (ds, val) => (ds.age_group || '').toLowerCase().includes(val.toLowerCase()),
    age_group:  (ds, val) => (ds.age_group || '').toLowerCase().includes(val.toLowerCase()),
    format: (ds, val) => (ds.keywords || []).some((k) => k.toLowerCase().includes(val.toLowerCase())),
  };

  const requestedFields = ['modality', 'species', 'condition', 'task', 'region', 'age_range', 'format'];

  for (const field of requestedFields) {
    const requested = filters[field];
    const hasValue = Array.isArray(requested) ? requested.length > 0 : Boolean(requested);

    if (!hasValue) {
      coverage[field] = { requested: false, matchedRatio: null };
      continue;
    }

    // For array-valued filters, a dataset "matches" if it matches ANY of the values
    const values = Array.isArray(requested) ? requested : [requested];
    const checker = fieldMap[field] || (() => false);
    const matchCount = results.filter((ds) => values.some((v) => checker(ds, v))).length;
    const matchedRatio = total > 0 ? matchCount / total : 0;

    coverage[field] = { requested: true, matchedRatio, matchCount, totalResults: total };
  }

  return coverage;
}

/**
 * Compute aggregate RetrievalQuality from MongoDB results and filters.
 *
 * @param {Object[]} results - MongoDB dataset documents
 * @param {Object}   filters - QueryFilters
 * @param {Object}   complexityInfo - from analyzeQueryComplexity()
 * @returns {Object} RetrievalQuality as described in §8.3
 */
function computeRetrievalQuality(results, filters, complexityInfo = {}) {
  const total = results.length;

  if (total === 0) {
    return {
      resultCount: 0,
      fieldCoverage: {},
      avgMetadataCompleteness: 0,
      avgTrustTier: 0,
      newestDatasetDate: null,
      oldestDatasetDate: null,
      averageAgeDays: null,
      uniqueSources: 0,
      uniqueModalities: 0,
      complexity: complexityInfo,
    };
  }

  const fieldCoverage = computeFieldCoverage(results, filters);

  // Average metadata quality — use quality_score if present, else 0.5 as neutral
  const avgMetadataCompleteness = results.reduce((sum, ds) => {
    return sum + (ds.quality_score != null ? ds.quality_score : 0.5);
  }, 0) / total;

  // Average trust tier (verified=1, unverified=0.5, stale=0)
  const tierValues = { verified: 1.0, unverified: 0.5, stale: 0.0 };
  const avgTrustTier = results.reduce((sum, ds) => {
    return sum + (tierValues[ds.trust_tier] ?? 0.5);
  }, 0) / total;

  // Freshness
  const dates = results
    .map((ds) => ds.updated_at || ds.ingested_at)
    .filter(Boolean)
    .map((d) => new Date(d).getTime());

  const now = Date.now();
  const newestDatasetDate  = dates.length ? new Date(Math.max(...dates)) : null;
  const oldestDatasetDate  = dates.length ? new Date(Math.min(...dates)) : null;
  const averageAgeDays     = dates.length
    ? dates.reduce((sum, t) => sum + (now - t) / (1000 * 60 * 60 * 24), 0) / dates.length
    : null;

  // Diversity
  const uniqueSources    = new Set(results.map((ds) => ds.source).filter(Boolean)).size;
  const uniqueModalities = new Set(results.flatMap((ds) => ds.modality || [])).size;

  return {
    resultCount: total,
    fieldCoverage,
    avgMetadataCompleteness,
    avgTrustTier,
    newestDatasetDate,
    oldestDatasetDate,
    averageAgeDays,
    uniqueSources,
    uniqueModalities,
    complexity: complexityInfo,
  };
}

/**
 * Evaluate whether external discovery is needed.
 *
 * Public API unchanged (§4.4) — delegates to the shared signal core with the
 * default thresholds from getThresholds().
 *
 * @param {Object} quality     - from computeRetrievalQuality()
 * @param {Object} filters     - QueryFilters
 * @param {Object} options     - { queryComplexity, freshnessRequirement }
 * @returns {{ shouldDiscover: boolean, reason: string|null, confidence: number, signals: string[] }}
 */
function evaluate(quality, filters, options = {}) {
  return _evaluateCore(quality, filters, options, getThresholds());
}

/**
 * Core signal evaluation shared by evaluate() and evaluateAfterRepositories().
 * Pure — no I/O. Accepts an explicit threshold set so the post-repository
 * decision can raise the effective bar (§4.4) without changing evaluate().
 *
 * @param {Object} quality     - from computeRetrievalQuality()
 * @param {Object} filters     - QueryFilters
 * @param {Object} options     - { queryComplexity, freshnessRequirement }
 * @param {Object} thresholds  - resolved threshold set (getThresholds() by default)
 * @returns {{ shouldDiscover: boolean, reason: string|null, confidence: number, signals: string[] }}
 */
function _evaluateCore(quality, filters, options = {}, thresholds = getThresholds()) {
  const triggered = []; // { name, weight, detail? }

  // Signal 1: zero results — always trigger immediately (fast path)
  if (quality.resultCount === 0) {
    return {
      shouldDiscover: true,
      reason: 'No datasets found in MongoDB',
      confidence: 1.0,
      signals: ['zero_results'],
    };
  }

  // Signal 2: low result count
  if (quality.resultCount < thresholds.minResults) {
    triggered.push({ name: 'low_result_count', weight: 0.8 });
  }

  // Signal 3: poor field coverage (any requested field below threshold)
  const coverage = quality.fieldCoverage || {};
  for (const [field, info] of Object.entries(coverage)) {
    if (info.requested && info.matchedRatio != null && info.matchedRatio < thresholds.fieldCoverageThreshold) {
      triggered.push({
        name: 'poor_field_coverage',
        weight: 0.7,
        detail: `${field} coverage ${(info.matchedRatio * 100).toFixed(0)}%`,
      });
      break; // one signal is enough — avoid double-counting same type
    }
  }

  // Signal 4: freshness requirement
  const requiresFreshness = options.freshnessRequirement || (quality.complexity && quality.complexity.freshness);
  if (requiresFreshness && quality.averageAgeDays != null && quality.averageAgeDays > thresholds.freshnessDays) {
    triggered.push({ name: 'freshness_requirement', weight: 0.6 });
  }

  // Signal 5: low metadata quality
  if (quality.avgMetadataCompleteness < thresholds.qualityThreshold) {
    triggered.push({ name: 'low_metadata_quality', weight: 0.5 });
  }

  // Signal 6: high query complexity with few results
  const complexity = options.queryComplexity || quality.complexity || {};
  if (
    (complexity.level === 'high' || complexity.level === 'very_high') &&
    quality.resultCount < 5
  ) {
    triggered.push({ name: 'high_query_complexity', weight: 0.4 });
  }

  // Signal 7: all results are unverified
  if (quality.avgTrustTier != null && quality.avgTrustTier <= 0.5 && quality.resultCount > 0) {
    triggered.push({ name: 'low_confidence_results', weight: 0.3 });
  }

  // Aggregate: bounded discounted combination of the strongest signals
  // (Retrieval V2 Phase 14) — replaces the V1 pure-MAX aggregation.
  const { confidence: aggregatedConfidence, contributions } = triggered.length > 0
    ? aggregateSignals(triggered)
    : { confidence: 0, contributions: [] };

  const shouldDiscover = aggregatedConfidence >= thresholds.decisionThreshold;

  const reason = shouldDiscover
    ? triggered
        .map((s) => s.detail || s.name)
        .concat([`aggregation=${contributions.map((c) => `${c.signal}:${c.contribution}`).join(' + ')}`])
        .join(', ')
    : null;

  return {
    shouldDiscover,
    reason,
    confidence: aggregatedConfidence,
    signals: triggered.map((s) => s.name),
  };
}

/**
 * Evaluate whether web discovery is still needed AFTER the repository tier ran.
 *
 * §4.4 — reuses evaluate() semantics but raises the effective bar against the
 * combined Mongo + repository pool before spending money on the web tier:
 *   - minResults        × 2 (repositories should beat the base bar)
 *   - fieldCoverageThreshold + 0.2 (capped at 1.0)
 *   - gates on env.featureFlags.useWebDiscovery (default true)
 *
 * Pure — no I/O. Existing evaluate() is unchanged.
 *
 * @param {Object} quality     - from computeRetrievalQuality([...mongo, ...repo])
 * @param {Object} filters     - QueryFilters
 * @param {Object} options     - { queryComplexity, freshnessRequirement }
 * @returns {{ shouldDiscoverWeb: boolean, reason: string|null, confidence: number, signals: string[] }}
 */
function evaluateAfterRepositories(quality, filters, options = {}) {
  // Gate 0: web tier feature flag (default true, §5.2).
  if (env.featureFlags?.useWebDiscovery === false) {
    return {
      shouldDiscoverWeb: false,
      reason: 'web_discovery_disabled',
      confidence: 0,
      signals: [],
    };
  }

  // Raise the effective bar against the combined pool (§4.4).
  const base = getThresholds();
  const raised = {
    ...base,
    minResults: base.minResults * 2,
    fieldCoverageThreshold: Math.min(1, base.fieldCoverageThreshold + 0.2),
  };

  const decision = _evaluateCore(quality, filters, options, raised);
  return {
    shouldDiscoverWeb: decision.shouldDiscover,
    reason: decision.reason,
    confidence: decision.confidence,
    signals: decision.signals,
  };
}

module.exports = { evaluate, evaluateAfterRepositories, computeRetrievalQuality, computeFieldCoverage, aggregateSignals };
