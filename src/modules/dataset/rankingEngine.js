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
  mri:  new Set(['mri', 'fmri', 'smri', 'functional mri', 'structural mri', 'functional nuclear magnetic resonance', 'functional nuclear magnetic resonance imaging']),
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

// ─── Retrieval V2 (Phase 11) — canonical task vocabulary ─────────────────────
// Mirrors app/data/vocab.py TASK_VOCAB (single source of truth lives Python-
// side; this is the retrieval/ranking mirror, same pattern as MODALITY_SYNONYMS
// ↔ connectors/base.py). Canonical labels are hyphenated; variants normalize so
// parsed "working memory" and stored "working-memory" share one token space.
const TASK_VOCAB = {
  'resting-state': ['resting state', 'resting-state', 'resting state fmri', 'resting-state fmri', 'rs-fmri', 'resting state functional mri'],
  'working-memory': ['working memory', 'working-memory'],
  motor: ['motor task', 'motor imagery', 'motor learning', 'finger tapping'],
  attention: ['attention task', 'sustained attention', 'selective attention', 'divided attention', 'visual attention', 'attention network test'],
  language: ['language task', 'language processing', 'speech production', 'sentence comprehension'],
};

/**
 * Normalize a free-form task string onto the canonical TASK_VOCAB label.
 * Returns null for empty/unknown input — unknown stays unknown (never mapped
 * onto a near-miss label).
 */
function normalizeTaskLabel(value) {
  if (!value) return null;
  const v = String(value).trim().toLowerCase();
  if (!v) return null;
  for (const [label, tokens] of Object.entries(TASK_VOCAB)) {
    if (v === label || tokens.includes(v)) return label;
    for (const t of tokens) {
      if (v.includes(t) || t.includes(v)) return label;
    }
  }
  return null;
}

/**
 * True when a requested task and a stored task/text fragment refer to the
 * same canonical label (synonym-aware both directions).
 */
function taskOverlap(requested, declaredText) {
  const r = normalizeTaskLabel(requested);
  const d = normalizeTaskLabel(declaredText);
  return Boolean(r && d && r === d);
}

/**
 * Which OTHER canonical task labels appear in free text — used to distinguish
 * a CONFIRMED task mismatch (text declares a different paradigm) from UNKNOWN.
 */
function otherTaskLabelInText(requested, text) {
  const r = normalizeTaskLabel(requested);
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  for (const label of Object.keys(TASK_VOCAB)) {
    if (label === r) continue;
    for (const token of TASK_VOCAB[label]) {
      if (t.includes(token)) return label;
    }
  }
  return null;
}

// Concept states (Retrieval V2 Phases 7/10): every requested structured concept
// evaluates to exactly one of:
//   match    — dataset-owned evidence agrees with the request (credit 1)
//   mismatch — dataset DECLARES a different value (partial credit + penalty)
//   unknown  — no declaration exists (neutral credit; NOT a failure)
const STATE = { MATCH: 'match', MISMATCH: 'mismatch', UNKNOWN: 'unknown' };

// Neutral credit for UNKNOWN fields: neither rewarded nor penalized. Sparse
// metadata is the norm (disease 13.77%, age_group 6.25% populated), so missing
// data must not drag scores down like a contradiction does (Phase 7).
const UNKNOWN_CREDIT = 0.5;

// Confirmed-mismatch handling: a declared-but-different value represents a
// confirmed contradiction (credit 0.0) PLUS an explicit per-field penalty so a
// contradictory dataset cannot ride freshness/trust past a true match.
const MODALITY_PARTIAL_CREDIT = 0.0;
const SPECIES_PARTIAL_CREDIT  = 0.0;
const CONCEPT_MISMATCH_CREDIT = 0.0; // condition / task / region / age_range
const MISMATCH_PENALTY_PER_FIELD = 0.40;
const MAX_MISMATCH_PENALTY = 0.60;

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
 * Retrieval V2 (Phases 7/10/11): every requested structured concept resolves
 * to one of three states instead of binary hit/miss:
 *   - MATCH    → credit 1.0 (+ exact-match premium)
 *   - MISMATCH → dataset DECLARES a different value: partial credit
 *                (modality 0.35 / species 0.30 / others 0.30 — evidence
 *                exists, so penalized not zero) PLUS an explicit per-field
 *                mismatch penalty so contradictory metadata cannot ride
 *                freshness/trust past a true match.
 *   - UNKNOWN  → no declaration in sparse metadata: neutral credit 0.5,
 *                explicitly NOT treated as failure (disease 13.77%, age_group
 *                6.25% populated — unknown must not sink a candidate).
 *
 * Task participates as first-class metadata: the stored canonical ``task``
 * field is checked first (synonym-normalized), then keywords/title/description
 * text evidence. A stored null task is UNKNOWN unless free text declares a
 * DIFFERENT canonical paradigm (confirmed mismatch).
 *
 * Evidence (Phase 9): ``matchDetails[field]`` keeps the boolean result and
 * ``evidence[field]`` lists WHERE the signal came from ('metadata', 'task',
 * 'keywords', 'title', 'description') for diagnostics/dev explanations.
 */
function computeMatchScore(dataset, filters) {
  const FILTER_FIELDS = ['modality', 'species', 'condition', 'task', 'region', 'age_range', 'format'];
  let matchedCount = 0;
  let mismatchedCount = 0;
  let unknownCount = 0;
  let requestedCount = 0;
  let weightedCredit = 0;
  let totalWeight = 0;
  const matchDetails = {};
  const credits = {};
  const states = {};
  const evidence = {};

  for (const field of FILTER_FIELDS) {
    const requested = filters[field];
    if (!requested || (Array.isArray(requested) && requested.length === 0)) continue;

    requestedCount++;
    const values = Array.isArray(requested) ? requested : [requested];
    let state = STATE.UNKNOWN;
    let credit = UNKNOWN_CREDIT;
    let sources = [];

    if (field === 'modality') {
      const declared = dataset.modality || [];
      if (values.some((v) => declared.some((m) => modalityOverlap(v, m)))) {
        state = STATE.MATCH; credit = 1; sources = ['metadata'];
      } else if (declared.length > 0) {
        state = STATE.MISMATCH; credit = MODALITY_PARTIAL_CREDIT; sources = ['metadata'];
      }
    } else if (field === 'species') {
      const declared = dataset.species || [];
      if (values.some((v) => declared.some((s) => s.toLowerCase() === v.toLowerCase()))) {
        state = STATE.MATCH; credit = 1; sources = ['metadata'];
      } else if (declared.length > 0) {
        state = STATE.MISMATCH; credit = SPECIES_PARTIAL_CREDIT; sources = ['metadata'];
      }
    } else if (field === 'condition') {
      // Bidirectional overlap: the parser may emit "Parkinson disease" while
      // Stage-3 enrichment stores the canonical label "parkinson" (or vice
      // versa). Match when either side contains the other. Keywords count as
      // evidence too (sparse structured disease coverage — Phase 6 TEST 6).
      const dl = (dataset.disease || '').toLowerCase();
      let kwHit = false;
      const condMatch = values.some((v) => {
        const vl = v.toLowerCase();
        if (dl && (dl.includes(vl) || vl.includes(dl))) { sources = ['metadata']; return true; }
        kwHit = (dataset.keywords || []).some((k) => {
          const kl = k.toLowerCase();
          return kl.includes(vl) || vl.includes(kl);
        });
        if (kwHit) sources = ['keywords'];
        return kwHit;
      });
      if (condMatch) {
        state = STATE.MATCH; credit = 1;
      } else if (dl) {
        state = STATE.MISMATCH; credit = CONCEPT_MISMATCH_CREDIT; sources = ['metadata'];
      }
    } else if (field === 'task') {
      // First-class task field (normalized), then keywords/title/description.
      const storedTask = normalizeTaskLabel(dataset.task);
      const textHaystacks = [
        ['keywords', (dataset.keywords || []).join(' ')],
        ['title', dataset.title || ''],
        ['description', dataset.description || ''],
      ];
      if (storedTask && values.some((v) => taskOverlap(v, storedTask))) {
        state = STATE.MATCH; credit = 1; sources = ['task'];
      } else {
        for (const [srcName, text] of textHaystacks) {
          if (values.some((v) => taskOverlap(v, text) || String(text).toLowerCase().includes(String(v).toLowerCase()))) {
            state = STATE.MATCH; credit = 1; sources = [srcName];
            break;
          }
        }
      }
      if (state !== STATE.MATCH) {
        // Confirmed mismatch ONLY on positive contrary evidence (Phase 7):
        // a different canonical stored task, or text declaring another paradigm.
        const contraryStored = storedTask && !values.some((v) => taskOverlap(v, storedTask));
        const contraryText = textHaystacks.some(([, text]) =>
          values.some((v) => otherTaskLabelInText(v, text)));
        if (contraryStored || contraryText) {
          state = STATE.MISMATCH; credit = CONCEPT_MISMATCH_CREDIT;
          sources = contraryStored ? ['task'] : ['text'];
        }
      }
    } else if (field === 'region') {
      if (values.some((v) => (dataset.region ? regionOverlap(v, dataset.region) : false))) {
        state = STATE.MATCH; credit = 1; sources = ['metadata'];
      } else if (dataset.region) {
        state = STATE.MISMATCH; credit = CONCEPT_MISMATCH_CREDIT; sources = ['metadata'];
      }
    } else if (field === 'age_range') {
      const ag = (dataset.age_group || '').toLowerCase();
      if (values.some((v) => v && ag.includes(v.toLowerCase())) ||
          values.some((v) => v && v.toLowerCase().includes(ag) && ag)) {
        state = STATE.MATCH; credit = 1; sources = ['metadata'];
      } else if (ag) {
        state = STATE.MISMATCH; credit = CONCEPT_MISMATCH_CREDIT; sources = ['metadata'];
      }
    } else if (field === 'format') {
      // Format evidence (NIfTI / BIDS / DICOM) can also appear in free text.
      const fmtMatch = values.some((v) => {
        const vl = v.toLowerCase();
        return (
          (dataset.keywords || []).some((k) => k.toLowerCase().includes(vl)) ||
          (dataset.title || '').toLowerCase().includes(vl) ||
          (dataset.description || '').toLowerCase().includes(vl)
        );
      });
      if (fmtMatch) {
        state = STATE.MATCH; credit = 1; sources = ['text'];
      }
      // No structured format field exists → never a confirmed mismatch.
    }

    matchDetails[field] = state === STATE.MATCH;
    credits[field] = state === STATE.UNKNOWN ? 0 : credit;
    states[field] = state;
    evidence[field] = sources;
    if (state === STATE.MATCH) matchedCount++;
    else if (state === STATE.MISMATCH) mismatchedCount++;
    else unknownCount++;
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
    states.keywords = kwMatched ? STATE.MATCH : STATE.UNKNOWN;
    evidence.keywords = kwMatched ? ['text'] : [];
    if (kwMatched) matchedCount++; else unknownCount++;
    const w = FIELD_WEIGHTS.keywords || 0;
    totalWeight += w;
    weightedCredit += (kwMatched ? 1 : UNKNOWN_CREDIT) * w;
  }

  // Neutral 0.5 when nothing was requested; otherwise coverage-aware graded average
  // + exact-match premium − confirmed-mismatch penalty (capped to [0,1]).
  const baseScore       = totalWeight > 0 ? weightedCredit / totalWeight : 0.5;
  const matchRatio      = requestedCount > 0 ? matchedCount / requestedCount : 0;
  const coverageFactor  = requestedCount > 0 ? (0.5 + 0.5 * matchRatio) : 1.0;
  const coverageBase    = baseScore * coverageFactor;
  const exactPremium    = totalWeight > 0 ? Math.min(EXACT_MATCH_BONUS * matchedCount, MAX_EXACT_PREMIUM) : 0;
  const mismatchPenalty = Math.min(MISMATCH_PENALTY_PER_FIELD * mismatchedCount, MAX_MISMATCH_PENALTY);
  const score           = totalWeight > 0
    ? Math.max(0, Math.min(coverageBase + exactPremium - mismatchPenalty, 1))
    : 0.5;

  return {
    score,
    matchCount: matchedCount,
    mismatchedCount,
    unknownCount,
    requestedCount,
    matchRatio,
    matchDetails,
    credits,
    states,
    evidence,
    baseScore,
  };
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
function normalizeDoi(doi) {
  return String(doi || '').trim().toLowerCase().replace(/^doi:\s*/i, '');
}

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
      const normDoi = ds.doi ? normalizeDoi(ds.doi) : null;
      const doiKey = normDoi ? `doi:${normDoi}` : null;

      if (seen.has(key) || (doiKey && seen.has(doiKey))) {
        continue;
      }

      seen.add(key);
      if (doiKey) seen.add(doiKey);
      merged.push({ ...ds, _source: label });
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
        // Phase 9/11 — three-state concept detail + evidence for dev
        // explanations ("why did this rank here?"). Production users never
        // receive these fields; they exist only in this development log.
        modalityState: d._matchDetails && d._matchDetails.states ? d._matchDetails.states.modality : null,
        conditionState: d._matchDetails && d._matchDetails.states ? d._matchDetails.states.condition : null,
        taskState:     d._matchDetails && d._matchDetails.states ? d._matchDetails.states.task : null,
        ageState:      d._matchDetails && d._matchDetails.states ? d._matchDetails.states.age_range : null,
        evidence:      d._matchDetails && d._matchDetails.evidence ? d._matchDetails.evidence : {},
        coverage:      d._matchDetails && d._matchDetails.coverage ? d._matchDetails.coverage : null,
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
        states:        matchResult.states,
        evidence:      matchResult.evidence,
        matchCount:    matchResult.matchCount,
        mismatchedCount: matchResult.mismatchedCount,
        unknownCount:  matchResult.unknownCount,
        requestedCount: matchResult.requestedCount,
        matchRatio:    matchResult.matchRatio,
        // Phase 8 — candidate concept coverage, retained for ranking input
        // and dev diagnostics: { matched, mismatched, unknown }.
        coverage: {
          matched:    matchResult.matchCount,
          mismatched: matchResult.mismatchedCount,
          unknown:    matchResult.unknownCount,
        },
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
  MODALITY_SYNONYMS,
  // Retrieval V2 — shared pure helpers (candidateGenerator imports these;
  // one-way dependency, no cycle).
  normalizeTaskLabel,
  taskOverlap,
  otherTaskLabelInText,
  TASK_VOCAB,
  STATE,
};
