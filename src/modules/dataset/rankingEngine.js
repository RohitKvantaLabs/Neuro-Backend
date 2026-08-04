/**
 * Layer 3 Ranking Engine
 *
 * Pure computation — no I/O, no network calls, no database queries.
 * Merges MongoDB and discovery datasets, removes duplicates,
 * computes a weighted ranking score, and returns the top 30.
 *
 * Architecture ref: §9 "Layer 3 Ranking Engine Design"
 *
 * Formula (§9.3) — query-first rebalance 2026-08-04 (stabilization Issue 1):
 *
 *   BEFORE Phase 5 (favored shallow keyword matches):
 *     final_score = matchScore*0.50 + qualityScore*0.20 +
 *                   freshnessScore*0.15 + trustScore*0.10 + diversityBonus*0.05
 *
 *   Phase 5 (repository authority first — allowed unrelated datasets to
 *   outrank exact matches, the defect this session fixes):
 *     final_score = matchScore*0.30 + qualityScore*0.25 +
 *                   trustScore*0.20 + freshnessScore*0.15 + diversityBonus*0.10
 *
 *   AFTER (QUERY-FIRST):
 *     final_score = matchScore*0.60 + qualityScore*0.15 +
 *                   trustScore*0.10 + freshnessScore*0.10 + diversityBonus*0.05
 *
 * Query relevance is the dominant ranking factor. matchScore itself is now
 * graded (Issue 2 — exact matches carry an explicit premium): a requested
 * modality/disease/task/region/species that matches exactly scores 1.0 per
 * field, a *declared but non-matching* modality/species scores partial credit
 * (0.35/0.30 — evidence exists, so it is penalized, not excluded), and no
 * declaration scores 0. For "Parkinson disease MEG" (incl. the +0.10
 * exact-match premium per exact field): Parkinson+MEG (1.0) >
 * Parkinson+MRI (0.775) > generic Parkinson (0.60) > unrelated (0).
 *
 * Determinism (Issue 5): the final sort uses stable tie-breakers —
 * FinalScore DESC → QueryMatch DESC → Quality DESC → Trust DESC →
 * Freshness DESC → Title ASC → Repository ASC → source_id ASC — so repeated
 * identical searches produce identical ordering unless the data changes.
 *
 * Observability (Issue 6): in development mode only, a structured
 * ranking.diagnostics log records per-dataset components (dataset,
 * repository, final score, query match, modality/disease/task/region match,
 * quality, trust, freshness, diversity).
 */

const env = require('../../config/env.config');
const logger = require('../../utils/logger');

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

/**
 * Stem-aware region overlap (Issue 2 — brain region exact matches are
 * prioritized). Region values come from Stage-3 vocabulary enrichment
 * (``hippocampal``, ``motor cortex``) while the parser may emit a different
 * morphological form (``hippocampus``, ``motor cortex``). Matches on exact,
 * substring containment, or a shared token prefix of >= 5 chars (``hippocampus``
 * ↔ ``hippocampal`` share ``hippocamp``).
 */
function regionOverlap(requested, declared) {
  const r = String(requested || '').toLowerCase().trim();
  const d = String(declared || '').toLowerCase().trim();
  if (!r || !d) return false;
  if (r === d || r.includes(d) || d.includes(r)) return true;
  const rt = r.split(/\s+/);
  const dt = d.split(/\s+/);
  for (const a of rt) {
    for (const b of dt) {
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      if (i >= 5) return true;
    }
  }
  return false;
}

// Query-first weights (§9.3, stabilization Issue 1): query relevance is the
// dominant component; metadata quality, repository trust, freshness, and
// diversity are secondary. Mirrored in env.config.js rankingEngine defaults.
const DEFAULT_WEIGHTS = {
  match:     0.60,
  quality:   0.15,
  trust:     0.10,
  freshness: 0.10,
  diversity: 0.05,
};

// Per-field relative importance inside matchScore (Issue 2). The requested
// modality and condition (disease) are the strongest relevance signals;
// task/region/species follow; age_range/format/keywords are weaker.
const FIELD_WEIGHTS = {
  modality:  1.0,
  condition: 1.0,
  task:      0.8,
  region:    0.8,
  species:   0.6,
  age_range: 0.4,
  format:    0.3,
  keywords:  0.5,
};

// Exact-match premium (Issue 2): every requested field that matches exactly
// adds a flat bonus on top of the weighted credit average, so exact hits
// clearly outrank partial evidence. Capped so the score stays in [0,1].
const EXACT_MATCH_BONUS = 0.10;
const MAX_EXACT_PREMIUM = 0.30;

// Partial credit when a *declared* modality/species exists but does not match
// the request: the record carries modality evidence, so it is penalized but
// not excluded (Issue 4). This is what separates "Parkinson + MRI" from
// "generic Parkinson" when MEG is requested.
const MODALITY_PARTIAL_CREDIT = 0.35;
const SPECIES_PARTIAL_CREDIT  = 0.30;

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
 *
 * Query-first grading (stabilization Issue 2): each requested field
 * contributes a graded credit (0..1) instead of a binary hit/miss, so exact
 * matches carry an explicit premium over partial evidence:
 *   - modality: 1.0 on synonym-family match, 0.35 when a modality is declared
 *     but does not match the request (evidence exists → penalty, not zero),
 *     0 when nothing is declared.
 *   - species: 1.0 exact, 0.30 declared-but-different, 0 none.
 *   - condition / task / region / age_range / format / keywords: 1.0 match,
 *     else 0.
 * Score = weighted-credit average + exact-match premium (capped at 1.0).
 * ``matchDetails`` keeps the boolean per-field map and adds ``credits``.
 */
function computeMatchScore(dataset, filters) {
  const FILTER_FIELDS = ['modality', 'species', 'condition', 'task', 'region', 'age_range', 'format'];
  let matchedCount = 0;
  let requestedCount = 0;
  let weightedCredit = 0;
  let totalWeight = 0;
  const matchDetails = {};
  const credits = {};

  for (const field of FILTER_FIELDS) {
    const requested = filters[field];
    if (!requested || (Array.isArray(requested) && requested.length === 0)) continue;

    requestedCount++;
    const values = Array.isArray(requested) ? requested : [requested];
    let matched = false;
    let credit = 0;

    if (field === 'modality') {
      const declared = dataset.modality || [];
      if (values.some((v) => declared.some((m) => modalityOverlap(v, m)))) {
        matched = true;
        credit = 1;
      } else if (declared.length > 0) {
        credit = MODALITY_PARTIAL_CREDIT; // declared but different family — partial evidence
      }
    } else if (field === 'species') {
      const declared = dataset.species || [];
      if (values.some((v) => declared.some((s) => s.toLowerCase() === v.toLowerCase()))) {
        matched = true;
        credit = 1;
      } else if (declared.length > 0) {
        credit = SPECIES_PARTIAL_CREDIT;
      }
    } else if (field === 'condition') {
      // Bidirectional overlap: the parser may emit "Parkinson disease" while
      // Stage-3 enrichment stores the canonical label "parkinson" (or vice
      // versa). Match when either side contains the other.
      matched = values.some((v) => {
        const vl = v.toLowerCase();
        const dl = (dataset.disease || '').toLowerCase();
        if (dl && (dl.includes(vl) || vl.includes(dl))) return true;
        return (dataset.keywords || []).some((k) => {
          const kl = k.toLowerCase();
          return kl.includes(vl) || vl.includes(kl);
        });
      });
      credit = matched ? 1 : 0;
    } else if (field === 'task') {
      // Task evidence lives in keywords AND the free-text title/description
      // (e.g. "Working memory capacity in adolescents (fMRI)").
      matched = values.some((v) => {
        const vl = v.toLowerCase();
        return (
          (dataset.keywords || []).some((k) => k.toLowerCase().includes(vl)) ||
          (dataset.title || '').toLowerCase().includes(vl) ||
          (dataset.description || '').toLowerCase().includes(vl)
        );
      });
      credit = matched ? 1 : 0;
    } else if (field === 'region') {
      matched = values.some((v) => (dataset.region ? regionOverlap(v, dataset.region) : false));
      credit = matched ? 1 : 0;
    } else if (field === 'age_range') {
      matched = values.some((v) => (dataset.age_group || '').toLowerCase().includes(v.toLowerCase()));
      credit = matched ? 1 : 0;
    } else if (field === 'format') {
      // Format evidence (NIfTI / BIDS / DICOM) can also appear in free text.
      matched = values.some((v) => {
        const vl = v.toLowerCase();
        return (
          (dataset.keywords || []).some((k) => k.toLowerCase().includes(vl)) ||
          (dataset.title || '').toLowerCase().includes(vl) ||
          (dataset.description || '').toLowerCase().includes(vl)
        );
      });
      credit = matched ? 1 : 0;
    }

    matchDetails[field] = matched;
    credits[field] = credit;
    if (matched) matchedCount++;
    const w = FIELD_WEIGHTS[field] || 0;
    totalWeight += w;
    weightedCredit += credit * w;
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
    credits.keywords = kwMatched ? 1 : 0;
    if (kwMatched) matchedCount++;
    const w = FIELD_WEIGHTS.keywords || 0;
    totalWeight += w;
    weightedCredit += (kwMatched ? 1 : 0) * w;
  }

  // Neutral 0.5 when nothing was requested; otherwise graded average + premium.
  const baseScore  = totalWeight > 0 ? weightedCredit / totalWeight : 0.5;
  const exactPremium = totalWeight > 0 ? Math.min(EXACT_MATCH_BONUS * matchedCount, MAX_EXACT_PREMIUM) : 0;
  const score      = totalWeight > 0 ? Math.min(baseScore + exactPremium, 1) : 0.5;
  const matchRatio = requestedCount > 0 ? matchedCount / requestedCount : 0;

  return { score, matchCount: matchedCount, requestedCount, matchRatio, matchDetails, credits, baseScore };
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
 * Values scaled so the bonus stays effective under the current (query-first)
 * diversityWeight of 0.05: a singleton source contributes up to 0.50 × 0.05
 * = 0.025, enough to resolve near-ties without dominating relevance.
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

// ---------- Deterministic comparator (§9.6, Issue 5) ----------

/**
 * Stable tie-breaker chain so repeated identical searches return the same
 * order unless the underlying data changes:
 * FinalScore DESC → QueryMatch DESC → Quality DESC → Trust DESC →
 * Freshness DESC → Title ASC → Repository ASC → source_id ASC.
 */
function compareRanked(a, b) {
  if (b._rankingScore !== a._rankingScore) return b._rankingScore - a._rankingScore;
  if (b._matchScore !== a._matchScore)     return b._matchScore - a._matchScore;
  if (b._qualityScore !== a._qualityScore) return b._qualityScore - a._qualityScore;
  if (b._trustScore !== a._trustScore)     return b._trustScore - a._trustScore;
  if (b._freshnessScore !== a._freshnessScore) return b._freshnessScore - a._freshnessScore;
  const byTitle  = String(a.title || '').localeCompare(String(b.title || ''));
  if (byTitle !== 0) return byTitle;
  const bySource = String(a.source || '').localeCompare(String(b.source || ''));
  if (bySource !== 0) return bySource;
  return String(a.source_id || '').localeCompare(String(b.source_id || ''));
}

// ---------- Ranking diagnostics (§9.6, Issue 6) ----------

/**
 * Structured ranking diagnostics — development mode only. Logs every Top-30
 * dataset with its components: dataset, repository, final score, query match,
 * modality/disease/task/region match, quality, trust, freshness, diversity.
 * Never breaks ranking: failures are swallowed.
 */
function logRankingDiagnostics(filters, scored) {
  if (env.nodeEnv !== 'development') return;
  try {
    logger.info(`[RankingEngine] ${JSON.stringify({
      event: 'ranking.diagnostics',
      query: (filters && filters.raw_query) || '',
      top: scored.slice(0, 30).map((d) => ({
        dataset:       d.title || d.source_id || '',
        repository:    d.source || '',
        finalScore:    d._rankingScore,
        queryMatch:    d._matchScore,
        modalityMatch: d._matchDetails && d._matchDetails.modality !== undefined ? d._matchDetails.modality : null,
        diseaseMatch:  d._matchDetails && d._matchDetails.condition !== undefined ? d._matchDetails.condition : null,
        taskMatch:     d._matchDetails && d._matchDetails.task !== undefined ? d._matchDetails.task : null,
        regionMatch:   d._matchDetails && d._matchDetails.region !== undefined ? d._matchDetails.region : null,
        quality:       d._qualityScore,
        trust:         d._trustScore,
        freshness:     d._freshnessScore,
        diversity:     d._diversityBonus,
      })),
    })}`);
  } catch (err) {
    logger.warn(`[RankingEngine] diagnostics logging failed: ${err.message}`);
  }
}

// ---------- Final ranking (§9.6 / §4.5) ----------

/**
 * Merge, deduplicate, score, sort, and return top 30 results.
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
      // Component scores — used by the deterministic tie-breakers (Issue 5)
      // and the dev-mode diagnostics log (Issue 6).
      _matchScore:    Math.round(matchResult.score * 10000) / 10000,
      _qualityScore:  Math.round(qualityScore * 10000) / 10000,
      _trustScore:    Math.round(trustScore * 10000) / 10000,
      _freshnessScore: Math.round(freshnessScore * 10000) / 10000,
      _diversityBonus: diversityBonus,
      _matchDetails: {
        ...matchResult.matchDetails,
        credits:       matchResult.credits,
        matchCount:    matchResult.matchCount,
        requestedCount: matchResult.requestedCount,
        matchRatio:    matchResult.matchRatio,
      },
    };
  });

  // Deterministic sort: score DESC, then the stable tie-breaker chain.
  scored.sort(compareRanked);
  logRankingDiagnostics(filters, scored);
  return scored.slice(0, 30);
}

module.exports = {
  rank,
  deduplicate,
  computeMatchScore,
  computeQualityScore,
  computeFreshnessScore,
  computeTrustScore,
  modalityOverlap,
  regionOverlap,
};
