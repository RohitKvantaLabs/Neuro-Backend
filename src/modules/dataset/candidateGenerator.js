/**
 * CandidateGenerator — Retrieval V2 (Phases 4/5/6/9/12/13)
 *
 * Separates CANDIDATE RETRIEVAL from FINAL RELEVANCE RANKING.
 *
 *   BEFORE (V1): every parsed concept became a mandatory $and clause in
 *   buildMongoQuery → one weak concept (e.g. age_group, 6.25% populated)
 *   eliminated nearly all candidates ("Resting-state fMRI in children with
 *   ADHD" survived to exactly 1 of 864 datasets).
 *
 *   AFTER (V2): query understanding → recall-oriented candidate generation →
 *   per-candidate concept coverage (MATCH/MISMATCH/UNKNOWN) → ranking.
 *
 * Hard vs soft constraints (Phase 5):
 *   - HARD constraints come ONLY from explicit UI filter selections
 *     (req.body.filters). They are applied at every cascade level as strict
 *     $and clauses — explicit user filters are never weakened.
 *   - Natural-language concepts from the parser are SOFT: they drive candidate
 *     generation signals and later relevance scoring, but a candidate is NOT
 *     eliminated solely because one sparse-metadata concept is absent.
 *
 * Cascade (Phase 12) — strongest first, stop when the pool target is met:
 *   LEVEL 1  hard + $text over normalized semantic terms   (high precision)
 *   LEVEL 2  hard + $or of synonym-expanded concept clauses (recall-oriented;
 *            NOT a giant unconstrained OR — every clause is tied to a parsed
 *            concept, and hard constraints still apply)
 *   LEVEL 3  hard + $text(raw_query)                        (broad lexical)
 *   LEVEL 4+ repository/web discovery remain downstream in the orchestrator
 *            and discoveryPolicy — intentionally reused, not duplicated here.
 *
 * Minimum quality gate (Phase 6): candidates must match at least one concept
 * (MIN_CONCEPT_MATCHES) and must not carry more confirmed mismatches than
 * matches — very weak/contradictory candidates never enter the pool.
 */

'use strict';

const Dataset = require('./dataset.model');
const {
  computeMatchScore,
  MODALITY_SYNONYMS,
  TASK_VOCAB,
} = require('./rankingEngine');

// Pool sizing mirrors the catalog tier (CATALOG_CANDIDATE_LIMIT = 200): enough
// headroom for the top-30 ranker without pulling the whole collection.
const CANDIDATE_POOL_TARGET = 200;

// Phase 6 minimum coverage gate: at least one matched concept; confirmed
// mismatches may never outnumber matches.
const MIN_CONCEPT_MATCHES = 1;

// ─── Synonym families (Phase 13) ──────────────────────────────────────────────
// Centralized mirror of app/data/vocab.py AGE_TERMS / TASK_VOCAB. Query-side
// expansion ONLY — stored metadata values are never modified.

const AGE_SYNONYMS = {
  infant: ['infant', 'infants', 'newborn', 'newborns', 'neonatal', 'neonates'],
  child: ['child', 'children', 'pediatric', 'pediatrics', 'school-age', 'kid', 'kids'],
  adolescent: ['adolescent', 'adolescents', 'teenager', 'teenagers', 'youth'],
  adult: ['adult', 'adults'],
  elderly: ['elderly', 'older adult', 'older adults', 'older-adult', 'geriatric'],
};

const DISEASE_SYNONYMS = {
  adhd: ['adhd', 'attention deficit hyperactivity disorder', 'attention deficit disorder'],
  parkinson: ['parkinson', "parkinson's", 'parkinsons', 'parkinson disease'],
  alzheimer: ['alzheimer', "alzheimer's", 'alzheimers', 'alzheimer disease'],
  autism: ['autism', 'autistic', 'asd', 'autism spectrum disorder'],
  schizophrenia: ['schizophrenia', 'schizophrenic', 'psychosis'],
  depression: ['depression', 'depressive', 'major depressive disorder'],
  epilepsy: ['epilepsy', 'epileptic', 'seizure', 'seizures'],
};

function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Expand one concept value into its full canonical synonym family (Phase 13):
 * modality → MODALITY_SYNONYMS family, age → AGE_SYNONYMS, task → TASK_VOCAB
 * tokens, disease → DISEASE_SYNONYMS. Unknown values expand to themselves.
 */
function expandConceptTerms(field, value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return [];
  if (field === 'modality') return [...new Set(MODALITY_SYNONYMS[v] || [v])];
  if (field === 'age_range' || field === 'age_group') return [...new Set(AGE_SYNONYMS[v] || [v])];
  if (field === 'task') {
    for (const [label, tokens] of Object.entries(TASK_VOCAB)) {
      if (label === v || tokens.includes(v)) return [label, ...tokens];
    }
    return [v];
  }
  if (field === 'condition') {
    for (const [label, tokens] of Object.entries(DISEASE_SYNONYMS)) {
      if (label === v || tokens.includes(v)) return [label, ...tokens];
    }
    return [v];
  }
  return [v];
}

// ─── Concepts & hard constraints ─────────────────────────────────────────────

/**
 * Build SOFT retrieval concepts from the parsed QueryFilters (one concept per
 * requested value — Phase 8 counts coverage per concept).
 */
function buildConcepts(filters = {}) {
  const f = filters && typeof filters === 'object' ? filters : {};
  const concepts = [];
  const addValue = (field, value) => {
    const v = String(value || '').trim();
    if (v) concepts.push({ field, value: v });
  };
  (Array.isArray(f.modality) ? f.modality : []).forEach((v) => addValue('modality', v));
  (Array.isArray(f.species) ? f.species : []).forEach((v) => addValue('species', v));
  (Array.isArray(f.condition) ? f.condition : f.disease ? [f.disease] : []).forEach((v) => addValue('condition', v));
  addValue('task', f.task);
  addValue('region', f.region);
  addValue('age_range', f.age_range || f.age_group);
  (Array.isArray(f.format) ? f.format : []).forEach((v) => addValue('format', v));
  return concepts;
}

// ─── Canonical bucket → Mongo range helpers (M3/M4/M6) ──────────────────────

// M3: Size buckets → byte ranges (matches classifySize in filter-classifications.ts)
const GB = 1024 ** 3;
const SIZE_BUCKET_RANGES = {
  '<10 GB':     { $lt: 10 * GB },
  '10–100 GB':  { $gte: 10 * GB, $lt: 101 * GB },
  '100–500 GB': { $gte: 100 * GB, $lt: 501 * GB },
  '500 GB+':    { $gte: 500 * GB },
};

// M4: Year buckets → numeric year ranges (matches classifyYear)
const YEAR_BUCKET_RANGES = {
  'Before 2020': { lt: 2020, gte: null },
  '2020–2022':   { gte: 2020, lt: 2023 },
  '2023–2025':   { gte: 2023, lt: 2026 },
  '2026+':       { gte: 2026, lt: null },
};

// M6: Participants buckets → subject_count ranges (matches classifyParticipants)
const PARTICIPANTS_BUCKET_RANGES = {
  '1–25':   { $gte: 1,   $lte: 25 },
  '26–50':  { $gte: 26,  $lte: 50 },
  '51–100': { $gte: 51,  $lte: 100 },
  '101+':   { $gte: 101 },
};

// M2: Modality bucket → raw token families for $or regex matching
// Mirrors modalityBucketToTokens in filter-classifications.ts
const MODALITY_BUCKET_TOKENS = {
  'MRI':   ['mri', 'fmri', 'smri', 'structural mri', 'functional mri',
             'magnetic resonance imaging', 'functional magnetic resonance imaging',
             'structural magnetic resonance imaging', 'dti', 'dwi', 'diffusion',
             't1w', 't2w', 'bold', 'anat', 'func'],
  'EEG':   ['eeg', 'electroencephalography', 'electroencephalogram', 'electrophysiology',
             'ecg', 'emg', 'lfp', 'local field potential'],
  'IEEG':  ['ieeg', 'intracranial eeg', 'intracranial electroencephalography',
             'ecog', 'electrocorticography', 'seeg', 'stereoelectroencephalography'],
  'MEG':   ['meg', 'magnetoencephalography'],
  'fNIRS': ['fnirs', 'nirs', 'near-infrared spectroscopy', 'near infrared spectroscopy'],
  'PET':   ['pet', 'positron emission tomography'],
};

// M5: Human token set for species matching
const HUMAN_SPECIES_TOKENS = [
  'human', 'humans', 'homo sapiens', 'participant', 'participants',
  'subject', 'subjects', 'patient', 'patients', 'adult', 'adults',
  'child', 'children', 'person', 'people',
];

/**
 * Extract HARD constraints from explicit UI filter selections only (Phase 5 + M2–M6).
 *
 * M2: modality bucket → synonym-family $or regex
 * M3: size bucket → byte range predicate on size_bytes
 * M4: year bucket → numeric year range across year fields
 * M5: species bucket → Human ($in tokens) or Animal ($nin human tokens)
 * M6: participants bucket → subject_count $gte/$lte range
 */
function extractHardConstraints(explicitFilters) {
  const ef =
    explicitFilters && typeof explicitFilters === 'object'
      ? explicitFilters
      : {};
  const list = (key) => {
    const raw = ef[key] ?? ef[key.replace(/([A-Z])/g, '_$1').toLowerCase()];
    if (!raw) return [];
    return (Array.isArray(raw) ? raw : [raw]).map((v) => String(v || '').trim()).filter(Boolean);
  };

  const rx = (v) => new RegExp(escapeRegex(v), 'i');
  const hard = { $and: [] };
  const pushOr = (clauses) => {
    if (clauses.length > 0) hard.$and.push(clauses.length === 1 ? clauses[0] : { $or: clauses });
  };

  pushOr(list('repository').map((v) => ({ source: rx(v) })));

  // M2: modality bucket → expand to full synonym set
  pushOr(
    list('modality').flatMap((bucket) => {
      const tokens = MODALITY_BUCKET_TOKENS[bucket];
      if (tokens) return tokens.map((t) => ({ modality: rx(t) }));
      return [{ modality: rx(bucket) }]; // Unspecified / unknown passthrough
    })
  );

  // M5: species bucket → Human (inclusive) or Animal (exclusive)
  const speciesValues = list('species');
  for (const bucket of speciesValues) {
    const b = bucket.trim().toLowerCase();
    if (b === 'human') {
      pushOr(HUMAN_SPECIES_TOKENS.map((t) => ({ species: rx(t) })));
    } else if (b === 'animal') {
      // Animal = has a species field that is NOT a human term
      hard.$and.push({
        species: { $exists: true, $not: new RegExp(HUMAN_SPECIES_TOKENS.map(escapeRegex).join('|'), 'i') },
      });
    }
    // Unspecified: no constraint
  }

  // Explicit disease stays a strict structured filter (UI semantics preserved).
  pushOr(
    list('disease').flatMap((v) => {
      if (v.toLowerCase() === 'unspecified') return [{ disease: { $in: [null, '', 'none', 'null', 'nan'] } }];
      if (v.toLowerCase() === 'others') return []; // "Others" is a frontend-only catch-all
      return [{ disease: rx(v) }, { keywords: rx(v) }];
    })
  );

  pushOr(list('ageGroup').map((v) => ({ age_group: rx(v) })));
  pushOr(list('region').map((v) => ({ region: rx(v) })));
  pushOr(list('task').flatMap((v) => [{ task: rx(v) }, { keywords: rx(v) }]));
  pushOr(list('format').flatMap((v) => [{ keywords: rx(v) }]));
  pushOr(list('availability').map((v) => ({ access_tier: rx(v) })));

  // M3: size bucket → byte range on size_bytes
  for (const bucket of list('size')) {
    const range = SIZE_BUCKET_RANGES[bucket];
    if (range) hard.$and.push({ size_bytes: range });
  }

  // M4: year bucket → numeric year range across all date fields
  for (const bucket of list('year')) {
    const range = YEAR_BUCKET_RANGES[bucket];
    if (!range) continue;
    const buildRange = () => {
      const r = {};
      if (range.gte != null) r.$gte = range.gte;
      if (range.lt  != null) r.$lt  = range.lt;
      return r;
    };
    const r = buildRange();
    if (Object.keys(r).length > 0) {
      hard.$and.push({
        $or: [
          { publication_year: r },
          { published_at: r },
          { date_published: r },
        ],
      });
    }
  }

  // M6: participants bucket → subject_count range
  for (const bucket of list('participants')) {
    const range = PARTICIPANTS_BUCKET_RANGES[bucket];
    if (range) hard.$and.push({ subject_count: range });
  }

  return hard.$and.length > 0 ? hard : null;
}


// ─── Query builders ──────────────────────────────────────────────────────────

/** $text search string built from normalized concepts (+ safe keywords). */
function semanticSearchText(filters) {
  const terms = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (s && !terms.includes(s)) terms.push(s);
  };
  (Array.isArray(filters.modality) ? filters.modality : []).forEach(push);
  if (filters.task) push(filters.task);
  (Array.isArray(filters.condition) ? filters.condition : []).forEach(push);
  if (filters.age_range || filters.age_group) push(filters.age_range || filters.age_group);
  if (filters.region) push(filters.region);
  (Array.isArray(filters.species) ? filters.species : []).forEach(push);
  return terms.join(' ');
}

/**
 * One concept clause: any synonym-family term hitting ANY evidence surface
 * (structured metadata field, keywords, title, description) — Phase 6 signal 3
 * "normalized query concepts + synonyms already supported by the project".
 */
function conceptClause(concept) {
  const terms = expandConceptTerms(concept.field, concept.value);
  const clauses = [];
  const surfacesByField = {
    modality: ['modality', 'keywords', 'title', 'description'],
    species: ['species', 'keywords', 'title', 'description'],
    condition: ['disease', 'keywords', 'title', 'description'],
    task: ['task', 'keywords', 'title', 'description'],
    age_range: ['age_group', 'keywords', 'title', 'description'],
    format: ['keywords', 'title', 'description'],
    region: ['region', 'keywords', 'title', 'description'],
  };
  for (const term of terms) {
    const rx = { $regex: escapeRegex(term), $options: 'i' };
    for (const surface of surfacesByField[concept.field] || []) {
      clauses.push({ [surface]: rx });
    }
  }
  return clauses;
}

// ─── Coverage (Phases 8/9 — single implementation lives in rankingEngine) ────

/**
 * Evaluate concept coverage for a candidate using computeMatchScore's
 * three-state logic (MATCH / MISMATCH / UNKNOWN) so ranking and gating share
 * ONE implementation. Evidence sources are retained per concept (Phase 9).
 */
function evaluateCandidateCoverage(dataset, filters) {
  const m = computeMatchScore(dataset, filters);
  return {
    matched: m.matchCount,
    mismatched: m.mismatchedCount,
    unknown: m.unknownCount,
    requested: m.requestedCount,
    states: m.states,
    evidence: m.evidence,
  };
}

/** Phase 6 gate — very weak or net-contradictory candidates are excluded. */
function passesMinimumCoverage(coverage) {
  if (coverage.matched < MIN_CONCEPT_MATCHES) return false;
  if (coverage.mismatched > coverage.matched) return false;
  return true;
}

// ─── Cascade execution ───────────────────────────────────────────────────────

async function generateCandidates(filters, hardConstraints, options = {}) {
  const target = options.poolTarget || CANDIDATE_POOL_TARGET;
  const pool = new Map(); // source:source_id → doc (dedup across levels)
  const levelsUsed = [];
  let droppedWeak = 0;

  const hardAnd = hardConstraints && hardConstraints.$and ? hardConstraints.$and : [];

  const addDocs = (docs, level) => {
    let added = 0;
    for (const doc of docs) {
      const key = `${doc.source}:${doc.source_id}`;
      if (pool.has(key)) continue;
      const coverage = evaluateCandidateCoverage(doc, filters);
      if (!passesMinimumCoverage(coverage)) {
        droppedWeak++;
        continue;
      }
      pool.set(key, {
        ...doc,
        _source: doc._source || 'mongodb_dataset',
        _provenance: doc._provenance || 'mongodb_dataset',
        _retrievalLevel: level,
        _coverage: coverage,
      });
      added++;
    }
    return added;
  };

  const runLevel = async (level, mongoQuery, limit) => {
    if (!mongoQuery || Object.keys(mongoQuery).length === 0) return;
    if (pool.size >= target) return;
    try {
      const projection = { score: { $meta: 'textScore' } };
      const hasText = Boolean(mongoQuery.$text);
      let docs;
      if (hasText) {
        docs = await Dataset.find(mongoQuery, projection)
          .sort({ score: { $meta: 'textScore' } })
          .limit(limit)
          .lean();
      } else {
        docs = await Dataset.find(mongoQuery).limit(limit).lean();
      }
      const added = addDocs(docs, level);
      if (added > 0 || docs.length > 0) levelsUsed.push(level);
    } catch {
      // Level failure degrades to the next cascade level (§7.5 convention).
    }
  };

  // LEVEL 1 — strong multi-concept: $text over normalized semantic terms.
  const semanticText = semanticSearchText(filters);
  if (semanticText) {
    await runLevel(1, { $text: { $search: semanticText }, ...(hardAnd.length ? { $and: hardAnd } : {}) }, target - pool.size);
  }

  // LEVEL 2 — recall-oriented multi-concept OR (never a bare giant OR:
  // hard constraints still bind, and every clause maps to a parsed concept).
  if (pool.size < target) {
    const concepts = buildConcepts(filters);
    const conceptClauses = concepts.flatMap(conceptClause);
    if (conceptClauses.length > 0) {
      await runLevel(
        2,
        { $or: conceptClauses, ...(hardAnd.length ? { $and: hardAnd } : {}) },
        target - pool.size
      );
    }
  }

  // LEVEL 3 — broad lexical fallback on the raw query text.
  if (pool.size < target && filters.raw_query) {
    await runLevel(3, { $text: { $search: filters.raw_query.trim() }, ...(hardAnd.length ? { $and: hardAnd } : {}) }, target - pool.size);
  }

  // Coverage distribution for metrics/regression reporting (Phase 17):
  // keyed "matched/requested" e.g. "4/4" → count.
  const coverageDistribution = {};
  for (const doc of pool.values()) {
    const c = doc._coverage;
    const key = `${c.matched}/${c.requested}`;
    coverageDistribution[key] = (coverageDistribution[key] || 0) + 1;
  }

  return {
    candidates: [...pool.values()],
    levelsUsed,
    droppedWeak,
    coverageDistribution,
    poolTarget: target,
  };
}

module.exports = {
  generateCandidates,
  buildConcepts,
  extractHardConstraints,
  evaluateCandidateCoverage,
  passesMinimumCoverage,
  expandConceptTerms,
  conceptClause,
  semanticSearchText,
  CANDIDATE_POOL_TARGET,
  MIN_CONCEPT_MATCHES,
};
