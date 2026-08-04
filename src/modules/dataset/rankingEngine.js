/**
 * Layer 3 Ranking Engine
 *
 * Pure computation — no I/O, no network calls, no database queries.
 * Merges MongoDB and discovery datasets, removes duplicates,
 * computes a weighted ranking score, and returns the top 20.
 *
 * Architecture ref: §9 "Layer 3 Ranking Engine Design"
 *
 * Formula (§9.3) — rebalanced 2026-08-04 (stabilization Phase 5):
 *
 *   BEFORE (favored shallow keyword matches):
 *     final_score = matchScore*0.50 + qualityScore*0.20 +
 *                   freshnessScore*0.15 + trustScore*0.10 + diversityBonus*0.05
 *
 *   AFTER (repository authority + dataset quality + semantic relevance first):
 *     final_score = matchScore*0.30 + qualityScore*0.25 +
 *                   trustScore*0.20 + freshnessScore*0.15 + diversityBonus*0.10
 *
 * Rationale: match (free-text/token coincidence) no longer dominates — a
 * verified repository dataset with rich metadata outranks a shallow
 * keyword-coincidence MongoDB record. Semantic relevance stays the largest
 * single component, but metadata completeness (quality), repository
 * authority (trust), and diversity now carry meaningful weight.
 */

const env = require('../../config/env.config');

/**
 * Modality synonym families (mirrors Neuro-Agents app/connectors/base.py
 * MODALITY_SYNONYMS — stabilization Phase 6). Repository-native values are
 * coarse (OpenNeuro stores ``mri`` for all MRI scans; DANDI
 * ``Electrophysiology``) while the Query Parser emits precise terms (``fMRI``,
 * ``sMRI``). A requested modality matches when it shares a synonym family with
 * a declared value, so relevance is semantic rather than exact-token.
 */
const MODALITY_SYNONYMS = {
  fmri: new Set(['fmri', 'mri', 'functional mri', 'functional magnetic resonance imaging']),
  smri: new Set(['smri', 'mri', 'structural mri', 'structural magnetic resonance imaging']),
  mri:  new Set(['mri', 'fmri', 'smri', 'functional mri', 'structural mri']),
  eeg:  new Set(['eeg', 'electroencephalography']),
  meg:  new Set(['meg', 'magnetoencephalography']),
  ieeg: new Set(['ieeg', 'intracranial eeg', 'ecog']),
  ecog: new Set(['ecog', 'ieeg', 'intracranial eeg']),
  pet:  new Set(['pet', 'positron emission tomography']),
  dti:  new Set(['dti', 'diffusion mri', 'diffusion tensor imaging', 'mri']),
  nirs: new Set(['nirs', 'fnirs', 'functional near-infrared spectroscopy']),
  fnirs: new Set(['fnirs', 'nirs']),
};

function modalityOverlap(requested, declared) {
  const r = String(requested || '').trim().toLowerCase();
  const d = String(declared || '').trim().toLowerCase();
  if (!r || !d) return false;
  if (r === d) return true;
  const famR = MODALITY_SYNONYMS[r];
  const famD = MODALITY_SYNONYMS[d];
  if (famR && famD) {
    for (const v of famR) if (famD.has(v)) return true;
    return false;
  }
  if (famR) return famR.has(d);
  if (famD) return famD.has(r);
  return r.includes(d) || d.includes(r); // fuzzy fallback ("mri" vs "functional mri")
}

const DEFAULT_WEIGHTS = {
  match:     0.30,
  quality:   0.25,
  trust:     0.20,
  freshness: 0.15,
  diversity: 0.10,
};

function getWeights() {
  const re = env.rankingEngine || {};
  return {
    match:     re.matchWeight     ?? DEFAULT_WEIGHTS.match,
    quality:   re.qualityWeight   ?? DEFAULT_WEIGHTS.quality,
    freshness: re.freshnessWeight ?? DEFAULT_WEIGHTS.freshness,
    trust:     re.trustWeight     ?? DEFAULT_WEIGHTS.trust,
    diversity: re.diversityWeight ?? DEFAULT_WEIGHTS.diversity,
  };
}

// ---------- Individual scorers (§9.4) ----------

/**
 * MatchScore (§9.4.1) — how well a dataset covers the requested filter fields.
 */
function computeMatchScore(dataset, filters) {
  const FILTER_FIELDS = ['modality', 'species', 'condition', 'task', 'region', 'age_range', 'format'];
  let matchedCount = 0;
  let requestedCount = 0;
  const matchDetails = {};

  for (const field of FILTER_FIELDS) {
    const requested = filters[field];
    if (!requested || (Array.isArray(requested) && requested.length === 0)) continue;

    requestedCount++;
    const values = Array.isArray(requested) ? requested : [requested];
    let matched = false;

    if (field === 'modality') {
      matched = values.some((v) =>
        (dataset.modality || []).some((m) => modalityOverlap(v, m)));
    } else if (field === 'species') {
      matched = values.some((v) => (dataset.species || []).some((s) => s.toLowerCase() === v.toLowerCase()));
    } else if (field === 'condition') {
      matched = values.some((v) => {
        const vl = v.toLowerCase();
        return (
          (dataset.disease || '').toLowerCase().includes(vl) ||
          (dataset.keywords || []).some((k) => k.toLowerCase().includes(vl))
        );
      });
    } else if (field === 'task') {
      matched = values.some((v) => (dataset.keywords || []).some((k) => k.toLowerCase().includes(v.toLowerCase())));
    } else if (field === 'region') {
      matched = values.some((v) => (dataset.region || '').toLowerCase().includes(v.toLowerCase()));
    } else if (field === 'age_range') {
      matched = values.some((v) => (dataset.age_group || '').toLowerCase().includes(v.toLowerCase()));
    } else if (field === 'format') {
      matched = values.some((v) => (dataset.keywords || []).some((k) => k.toLowerCase().includes(v.toLowerCase())));
    }

    matchDetails[field] = matched;
    if (matched) matchedCount++;
  }

  // Keyword free-text matching (§9.4.1)
  if (Array.isArray(filters.keywords) && filters.keywords.length > 0) {
    requestedCount++;
    const kwMatched = filters.keywords.some((kw) => {
      const kl = kw.toLowerCase();
      return (
        (dataset.keywords || []).some((dk) => dk.toLowerCase().includes(kl)) ||
        (dataset.title || '').toLowerCase().includes(kl) ||
        (dataset.description || '').toLowerCase().includes(kl)
      );
    });
    matchDetails.keywords = kwMatched;
    if (kwMatched) matchedCount++;
  }

  const score     = requestedCount > 0 ? matchedCount / requestedCount : 0.5;
  const matchRatio = requestedCount > 0 ? matchedCount / requestedCount : 0;

  return { score, matchCount: matchedCount, requestedCount, matchRatio, matchDetails };
}

/**
 * QualityScore (§9.4.2) — reuses existing quality_score or computes a fallback.
 */
function computeQualityScore(dataset) {
  if (dataset.quality_score != null) return dataset.quality_score;

  // ponytail: fallback for discovered datasets without quality_score
  let score = 0;
  if (dataset.title       && dataset.title.length       > 5)  score += 0.15;
  if (dataset.description && dataset.description.length > 20) score += 0.10;
  if (dataset.modality    && dataset.modality.length    > 0)  score += 0.07;
  if (dataset.species     && dataset.species.length     > 0)  score += 0.06;
  if (dataset.keywords    && dataset.keywords.length    > 0)  score += 0.06;
  if (dataset.subject_count != null && dataset.subject_count > 0) score += 0.06;
  return Math.min(score, 0.25) * 4; // normalize 0–1
}

/**
 * FreshnessScore (§9.4.3) — age-bracket scoring.
 */
function computeFreshnessScore(dataset) {
  const updatedAt = dataset.updated_at || dataset.ingested_at;
  if (!updatedAt) return 0.5; // neutral

  const ageDays = (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays <= 30)  return 1.0;
  if (ageDays <= 90)  return 0.8;
  if (ageDays <= 180) return 0.6;
  if (ageDays <= 365) return 0.4;
  return 0.2;
}

/**
 * TrustScore (§9.4.4) — trust_tier enum to score.
 */
function computeTrustScore(dataset) {
  const tiers = { verified: 1.0, unverified: 0.5, stale: 0.0 };
  return tiers[dataset.trust_tier] ?? 0.5;
}

/**
 * DiversityBonus (§9.4.5) — boost underrepresented sources.
 *
 * Rebalanced 2026-08-04 (Phase 5): values scaled up to be effective under the
 * new diversityWeight of 0.10 (the old max 0.05 × 0.05 weight contributed at
 * most 0.0025 — a rounding error).
 */
function computeDiversityBonus(dataset, sourceCounts) {
  const source = dataset.source || 'unknown';
  const count  = sourceCounts[source] || 0;
  if (count <= 1) return 0.50;
  if (count <= 3) return 0.20;
  return 0.0;
}

// ---------- Deduplication (§9.5 / §4.5) ----------

/**
 * Merge three pools — MongoDB, repository, web discovery — deduplicating by
 * source:source_id. Priority order is Mongo first, then repository, then web
 * (§4.5), so earlier pools win on ties.
 *
 * Backward-compatible: the legacy 2-pool call deduplicate(mongo, discovery)
 * is still supported (repository pool omitted).
 *
 * @param {Object[]} mongodbResults
 * @param {Object[]} repositoryResults
 * @param {Object[]} discoveryResults
 * @returns {Object[]} merged array with _source annotation
 */
function deduplicate(mongodbResults, repositoryResults, discoveryResults) {
  // Legacy 2-pool call: deduplicate(mongodbResults, discoveryResults)
  if (discoveryResults === undefined) {
    discoveryResults = repositoryResults;
    repositoryResults = [];
  }

  const seen   = new Set();
  const merged = [];

  const pools = [
    [mongodbResults,    'mongodb'],
    [repositoryResults, 'repository'],
    [discoveryResults,  'discovery'],
  ];

  for (const [pool, label] of pools) {
    for (const ds of pool || []) {
      const key = `${ds.source}:${ds.source_id}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push({ ...ds, _source: label });
      }
    }
  }

  return merged;
}

// ---------- Final ranking (§9.6 / §4.5) ----------

/**
 * Merge, deduplicate, score, sort, and return top 20 results.
 *
 * §4.5: rank now accepts THREE pools (Mongo first, then repository, then web).
 * Weights/formula unchanged from §9.3.
 *
 * Backward-compatible: the legacy 3-arg call rank(mongo, discovery, filters)
 * is still supported (repository pool omitted).
 *
 * @param {Object[]} mongodbResults    - from MongoDB search before discovery
 * @param {Object[]} repositoryResults - repository tier results (§4.2)
 * @param {Object[]} discoveryResults  - net-new results after web discovery ran
 * @param {Object}   filters           - QueryFilters from parseQuery
 * @returns {Object[]} ranked datasets with _rankingScore, _source, _matchDetails
 */
function rank(mongodbResults, repositoryResults, discoveryResults, filters) {
  // Legacy 3-arg call: rank(mongodbResults, discoveryResults, filters)
  if (!Array.isArray(discoveryResults)) {
    filters = discoveryResults;
    discoveryResults = repositoryResults;
    repositoryResults = [];
  }

  const merged = deduplicate(mongodbResults, repositoryResults, discoveryResults);
  if (merged.length === 0) return [];

  const weights = getWeights();

  // Pre-compute source counts for diversity bonus
  const sourceCounts = {};
  for (const ds of merged) {
    const src = ds.source || 'unknown';
    sourceCounts[src] = (sourceCounts[src] || 0) + 1;
  }

  const scored = merged.map((dataset) => {
    const matchResult    = computeMatchScore(dataset, filters);
    const qualityScore   = computeQualityScore(dataset);
    const freshnessScore = computeFreshnessScore(dataset);
    const trustScore     = computeTrustScore(dataset);
    const diversityBonus = computeDiversityBonus(dataset, sourceCounts);

    const finalScore = (
      matchResult.score * weights.match     +
      qualityScore      * weights.quality   +
      freshnessScore    * weights.freshness +
      trustScore        * weights.trust     +
      diversityBonus    * weights.diversity
    );

    return {
      ...dataset,
      _rankingScore: Math.round(finalScore * 10000) / 10000,
      _matchDetails: {
        ...matchResult.matchDetails,
        matchCount:    matchResult.matchCount,
        requestedCount: matchResult.requestedCount,
        matchRatio:    matchResult.matchRatio,
      },
    };
  });

  // Sort descending by score, return top 20
  scored.sort((a, b) => b._rankingScore - a._rankingScore);
  return scored.slice(0, 20);
}

module.exports = {
  rank,
  deduplicate,
  computeMatchScore,
  computeQualityScore,
  computeFreshnessScore,
  computeTrustScore,
  modalityOverlap,
};
