/**
 * Unit tests — Layer 3 RankingEngine (§19 Phase 3.3)
 *
 * Pure module — no I/O, no network calls, no database queries.
 * The env.config dependency is mocked so weight config is hermetic.
 * Covers: computeMatchScore, computeQualityScore, computeFreshnessScore,
 * computeTrustScore, computeDiversityBonus, deduplicate, and rank().
 */
jest.mock('../src/config/env.config', () => ({
  discoveryPolicy: {},
  // nodeEnv intentionally omitted → not 'development' → ranking diagnostics
  // (Issue 6) are skipped in tests.
  rankingEngine: {
    matchWeight: 0.6,
    qualityWeight: 0.15,
    freshnessWeight: 0.1,
    trustWeight: 0.1,
    diversityWeight: 0.05,
  },
  featureFlags: {},
}));

const {
  rank,
  deduplicate,
  computeMatchScore,
  computeQualityScore,
  computeFreshnessScore,
  computeTrustScore,
  modalityOverlap,
  regionOverlap,
  normalizeTaskLabel,
  taskOverlap,
} = require('../src/modules/dataset/rankingEngine');

// ---- Fixtures ------------------------------------------------------------

const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

const makeDataset = (overrides = {}) => ({
  title: 'Adult resting-state fMRI in ADHD',
  description: 'A comprehensive resting-state fMRI dataset collected from ADHD patients.',
  source: 'openneuro',
  source_id: 'ds001',
  modality: ['fMRI'],
  species: ['human'],
  disease: 'ADHD',
  keywords: ['resting-state', 'adhd'],
  region: 'whole-brain',
  age_group: 'adult',
  quality_score: 0.85,
  trust_tier: 'verified',
  updated_at: daysAgo(10),
  ...overrides,
});

const fullFilters = {
  modality: ['fMRI'],
  species: ['human'],
  condition: ['ADHD'],
  task: 'resting-state',
  region: 'whole-brain',
  age_range: 'adult',
  format: ['NIfTI'],
  keywords: ['adhd'],
};

// ---- computeMatchScore ---------------------------------------------------

describe('computeMatchScore', () => {
  it('scores 1.0 when all requested fields match', () => {
    // format matches via keywords, so NIfTI must be present in keywords
    const dataset = makeDataset({ keywords: ['resting-state', 'adhd', 'NIfTI'] });
    const result = computeMatchScore(dataset, fullFilters);
    expect(result.score).toBe(1);
    expect(result.matchCount).toBe(8); // 7 filter fields + keywords
    expect(result.requestedCount).toBe(8);
    expect(result.matchRatio).toBe(1);
  });

  it('scores 0.5 (neutral) when no field is requested', () => {
    const result = computeMatchScore(makeDataset(), {});
    expect(result.score).toBe(0.5);
    expect(result.matchCount).toBe(0);
    expect(result.requestedCount).toBe(0);
  });

  it('scores 0 and penalizes for confirmed contradictions', () => {
    // condition also matches via keywords, so strip 'adhd' from keywords
    const result = computeMatchScore(
      makeDataset({ modality: ['EEG'], disease: 'none', keywords: ['resting-state'] }),
      { modality: ['fMRI'], condition: ['ADHD'] }
    );
    expect(result.matchCount).toBe(0);
    expect(result.mismatchedCount).toBe(2); // both concepts CONFIRMED mismatched
    expect(result.requestedCount).toBe(2);
    // EEG declared outside fMRI family & disease 'none' -> 0 credit + mismatch penalty = 0.
    expect(result.score).toBe(0);
    expect(result.credits.modality).toBe(0);
  });

  it('matches case-insensitively for modality and species', () => {
    const result = computeMatchScore(
      makeDataset({ modality: ['fmri'], species: ['Human'] }),
      { modality: ['fMRI'], species: ['human'] }
    );
    expect(result.score).toBe(1);
  });

  it('matches modality via synonym families (Phase 6 — "fmri" vs stored "mri")', () => {
    // OpenNeuro/DANDI store coarse values; the query parser emits precise ones.
    const result = computeMatchScore(
      makeDataset({ modality: ['mri'] }),
      { modality: ['fMRI'] }
    );
    expect(result.matchDetails.modality).toBe(true);
    expect(result.score).toBe(1);
  });

  it('penalizes confirmed mismatches far below unknown (Retrieval V2 Phase 7)', () => {
    // EEG declared vs fMRI requested → CONFIRMED mismatch:
    // base = 0.35 (partial credit) − 0.25 (mismatch penalty) = 0.10.
    const result = computeMatchScore(
      makeDataset({ modality: ['eeg'] }),
      { modality: ['fMRI'] }
    );
    expect(result.matchDetails.modality).toBe(false);
    expect(result.states.modality).toBe('mismatch');
    expect(result.score).toBe(0);
    expect(result.credits.modality).toBe(0);
  });

  it('treats missing metadata as UNKNOWN — neutral, not failure (Phase 7)', () => {
    // No modality declared → UNKNOWN: neutral credit 0.5, no mismatch penalty.
    const result = computeMatchScore(
      makeDataset({ modality: [] }),
      { modality: ['fMRI'] }
    );
    expect(result.states.modality).toBe('unknown');
    expect(result.score).toBeCloseTo(0.25);
    expect(result.unknownCount).toBe(1);
  });

  it('three-state hierarchy: exact > unknown(neutral) > mismatch(penalized)', () => {
    // Retrieval V2 deliberately replaces the V1 "declared-but-different beats
    // nothing-declared" rule: with sparse metadata (modality 25% populated),
    // an unknown must never be punished like a contradiction.
    const filters = { modality: ['MEG'] };
    const exactMeg = computeMatchScore(makeDataset({ modality: ['MEG'] }), filters);
    const noDeclaration = computeMatchScore(makeDataset({ modality: [] }), filters);
    const mriInstead = computeMatchScore(makeDataset({ modality: ['MRI'] }), filters);
    expect(exactMeg.score).toBe(1);
    expect(noDeclaration.score).toBeGreaterThan(mriInstead.score); // unknown > mismatch
  });

  it('exact matches carry the premium over partial evidence (Parkinson MEG hierarchy)', () => {
    // Query: "Parkinson disease MEG datasets" → modality + condition requested.
    const filters = { modality: ['MEG'], condition: ['parkinson'] };
    const parkinsonMeg = computeMatchScore(
      makeDataset({ modality: ['MEG'], disease: 'Parkinson disease' }), filters);
    const parkinsonMri = computeMatchScore(
      makeDataset({ modality: ['MRI'], disease: 'Parkinson disease' }), filters);
    const genericParkinson = computeMatchScore(
      makeDataset({ modality: [], disease: 'Parkinson disease' }), filters);
    const unrelated = computeMatchScore(
      makeDataset({ modality: [], disease: null, keywords: ['soil'] }), filters);
    expect(parkinsonMeg.score).toBeGreaterThan(parkinsonMri.score);   // MEG > MRI-declared-mismatch
    expect(genericParkinson.score).toBeGreaterThan(unrelated.score);  // Parkinson > unrelated
    // Retrieval V2: unknown modality (generic Parkinson, neutral 0.5 credit)
    // outranks a CONFIRMED modality mismatch (MRI declared, MEG requested).
    expect(genericParkinson.score).toBeGreaterThan(parkinsonMri.score);
  });

  it('modalityOverlap handles families, direct, and prefix cases', () => {
    expect(modalityOverlap('fMRI', 'mri')).toBe(true);       // synonym family
    expect(modalityOverlap('fmri', 'FMRI')).toBe(true);      // case-insensitive direct
    expect(modalityOverlap('eeg', 'mri')).toBe(false);       // no family link
    expect(modalityOverlap('mri', 'functional mri')).toBe(true); // family membership (mri family)
    expect(modalityOverlap('', 'mri')).toBe(false);          // empty guard
  });

  it('matches keywords against title and description', () => {
    const result = computeMatchScore(makeDataset(), { keywords: ['resting-state'] });
    // 'resting-state' appears in both title and keywords
    expect(result.matchDetails.keywords).toBe(true);
  });

  it('returns matchDetails for every requested field', () => {
    const result = computeMatchScore(makeDataset({ modality: ['EEG'] }), { modality: ['fMRI'], condition: ['ADHD'] });
    expect(result.matchDetails.modality).toBe(false);
    expect(result.matchDetails.condition).toBe(true);
  });

  it('matches region stem-warely (enriched "hippocampal" vs requested "hippocampus")', () => {
    const result = computeMatchScore(
      makeDataset({ region: 'hippocampal' }),
      { region: 'hippocampus' }
    );
    expect(result.matchDetails.region).toBe(true);
    expect(regionOverlap('hippocampus', 'hippocampal')).toBe(true);
    expect(regionOverlap('motor cortex', 'motor cortex')).toBe(true);
    expect(regionOverlap('amygdala', 'prefrontal cortex')).toBe(false);
    expect(regionOverlap('', 'hippocampus')).toBe(false);
  });

  it('matches condition bidirectionally (enriched label vs parser phrase)', () => {
    // Parser emits "Parkinson disease"; Stage-3 enrichment stores "parkinson".
    const result = computeMatchScore(
      makeDataset({ disease: 'parkinson' }),
      { condition: ['Parkinson disease'] }
    );
    expect(result.matchDetails.condition).toBe(true);
    expect(result.score).toBeGreaterThan(0.5);
    // And the reverse direction still works.
    const reverse = computeMatchScore(
      makeDataset({ disease: 'Parkinson disease' }),
      { condition: ['parkinson'] }
    );
    expect(reverse.matchDetails.condition).toBe(true);
  });

  it('handles single (non-array) requested values', () => {
    const result = computeMatchScore(makeDataset(), { task: 'resting-state' });
    expect(result.matchCount).toBe(1);
    expect(result.score).toBe(1);
  });

  it('task participates as first-class metadata — stored canonical field wins (Phase 11)', () => {
    // dataset.task is the canonical stored label; "working memory" (parser
    // variant) normalizes to the same "working-memory" family.
    const result = computeMatchScore(
      makeDataset({ title: 'Some study', keywords: [], task: 'working-memory' }),
      { task: 'working memory' }
    );
    expect(result.states.task).toBe('match');
    expect(result.evidence.task).toEqual(['task']);
    expect(result.score).toBe(1);
  });

  it('null task with no contrary evidence stays UNKNOWN, never mismatched', () => {
    const result = computeMatchScore(
      makeDataset({ title: 'Cortical thickness in aging', description: '', keywords: [], task: null }),
      { task: 'resting-state' }
    );
    expect(result.states.task).toBe('unknown');
    // Unknown → neutral credit 0.5 * coverage factor 0.5 = 0.25.
    expect(result.score).toBeCloseTo(0.25);
  });

  it('a different canonical task in text/evidence is a CONFIRMED mismatch', () => {
    // A resting-state dataset must NOT match a working-memory request:
    // free text declares the contrary paradigm.
    const miss = computeMatchScore(
      makeDataset({ keywords: [] }),
      { task: 'working memory' }
    );
    expect(miss.states.task).toBe('mismatch');
    expect(miss.score).toBe(0);
  });

  it('normalizes task variants onto canonical labels (Phase 13 vocabulary)', () => {
    expect(normalizeTaskLabel('Resting state')).toBe('resting-state');
    expect(normalizeTaskLabel('rs-fMRI')).toBe('resting-state');
    expect(normalizeTaskLabel('working memory')).toBe('working-memory');
    expect(taskOverlap('working memory', 'working-memory')).toBe(true);
    expect(taskOverlap('resting-state', 'working-memory')).toBe(false);
    expect(normalizeTaskLabel(null)).toBe(null);
    expect(normalizeTaskLabel('quantum knitting')).toBe(null); // unknown stays unknown
  });
});

// ---- computeQualityScore -------------------------------------------------

describe('computeQualityScore', () => {
  it('reuses an existing quality_score', () => {
    expect(computeQualityScore(makeDataset({ quality_score: 0.42 }))).toBe(0.42);
    expect(computeQualityScore(makeDataset({ quality_score: 0 }))).toBe(0);
  });

  it('computes a fallback score for discovered datasets without quality_score', () => {
    const score = computeQualityScore(
      makeDataset({
        quality_score: undefined,
        title: 'Rich dataset title',
        description: 'A very long and detailed description of the dataset contents.',
        modality: ['fMRI'],
        species: ['human'],
        keywords: ['resting-state'],
        subject_count: 120,
      })
    );
    // title(0.15) + description(0.10) + modality(0.07) + species(0.06) + keywords(0.06) + subject_count(0.06) = 0.5 → capped 0.25*4 = 1.0
    expect(score).toBe(1.0);
  });

  it('returns a low fallback score for sparse datasets', () => {
    const score = computeQualityScore(makeDataset({ quality_score: undefined, title: 'Tiny', description: '', modality: [], keywords: [] }));
    expect(score).toBeLessThan(1);
  });

  it('normalizes the fallback into the 0–1 range', () => {
    const score = computeQualityScore(makeDataset({ quality_score: undefined }));
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

// ---- computeFreshnessScore -----------------------------------------------

describe('computeFreshnessScore', () => {
  it('returns neutral 0.5 when no date is present', () => {
    expect(computeFreshnessScore(makeDataset({ updated_at: null, ingested_at: null }))).toBe(0.5);
  });

  it('scores age brackets correctly', () => {
    // Values sit comfortably INSIDE each bracket to avoid a 1ms boundary race
    // between fixture construction and Date.now() inside the scorer.
    expect(computeFreshnessScore(makeDataset({ updated_at: daysAgo(25) }))).toBe(1.0);   // <= 30 days
    expect(computeFreshnessScore(makeDataset({ updated_at: daysAgo(60) }))).toBe(0.8);   // <= 90 days
    expect(computeFreshnessScore(makeDataset({ updated_at: daysAgo(120) }))).toBe(0.6);  // <= 180 days
    expect(computeFreshnessScore(makeDataset({ updated_at: daysAgo(300) }))).toBe(0.4);  // <= 365 days
    expect(computeFreshnessScore(makeDataset({ updated_at: daysAgo(500) }))).toBe(0.2);  // older than 1 year
  });

  it('falls back to ingested_at when updated_at is missing', () => {
    const score = computeFreshnessScore(makeDataset({ updated_at: null, ingested_at: daysAgo(25) }));
    expect(score).toBe(1.0);
  });
});

// ---- computeTrustScore ---------------------------------------------------

describe('computeTrustScore', () => {
  it('maps the three trust tiers', () => {
    expect(computeTrustScore(makeDataset({ trust_tier: 'verified' }))).toBe(1.0);
    expect(computeTrustScore(makeDataset({ trust_tier: 'unverified' }))).toBe(0.5);
    expect(computeTrustScore(makeDataset({ trust_tier: 'stale' }))).toBe(0.0);
  });

  it('defaults unknown tiers to 0.5', () => {
    expect(computeTrustScore(makeDataset({ trust_tier: 'mystery' }))).toBe(0.5);
    expect(computeTrustScore(makeDataset({ trust_tier: undefined }))).toBe(0.5);
  });
});

// ---- deduplicate ---------------------------------------------------------

describe('deduplicate', () => {
  it('merges mongodb and discovery results', () => {
    const merged = deduplicate([makeDataset({ source_id: 'ds001' })], [makeDataset({ source_id: 'ds002' })]);
    expect(merged).toHaveLength(2);
  });

  it('removes duplicates by source:source_id', () => {
    const merged = deduplicate(
      [makeDataset({ source: 'openneuro', source_id: 'ds001' })],
      [makeDataset({ source: 'openneuro', source_id: 'ds001' })]
    );
    expect(merged).toHaveLength(1);
  });

  it('keeps distinct source_id across different sources', () => {
    const merged = deduplicate(
      [makeDataset({ source: 'openneuro', source_id: 'ds001' })],
      [makeDataset({ source: 'dandi', source_id: 'ds001' })]
    );
    expect(merged).toHaveLength(2);
  });

  it('gives MongoDB results priority (kept on tie)', () => {
    const mongodbDs = makeDataset({ source_id: 'ds001', title: 'MongoDB version' });
    const discoveryDs = makeDataset({ source_id: 'ds001', title: 'Discovery version' });
    const merged = deduplicate([mongodbDs], [discoveryDs]);
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe('MongoDB version');
    expect(merged[0]._source).toBe('mongodb');
  });

  it('annotates _source on every merged dataset', () => {
    const merged = deduplicate([makeDataset({ source_id: 'ds001' })], [makeDataset({ source_id: 'ds002' })]);
    expect(merged.map((ds) => ds._source)).toEqual(['mongodb', 'discovery']);
  });
});

// ---- rank ----------------------------------------------------------------

describe('rank', () => {
  it('returns an empty array when both sources are empty', () => {
    expect(rank([], [], fullFilters)).toEqual([]);
  });

  it('deduplicates across sources before ranking', () => {
    const ranked = rank(
      [makeDataset({ source_id: 'ds001' })],
      [makeDataset({ source_id: 'ds001' }), makeDataset({ source_id: 'ds002' })],
      fullFilters
    );
    expect(ranked).toHaveLength(2);
  });

  it('sorts by _rankingScore descending', () => {
    const good = makeDataset({ source_id: 'ds-good', quality_score: 0.95, updated_at: daysAgo(5) });
    const meh = makeDataset({ source_id: 'ds-meh', quality_score: 0.4, updated_at: daysAgo(400), trust_tier: 'stale' });
    const ranked = rank([meh], [good], fullFilters);
    expect(ranked[0].source_id).toBe('ds-good');
    expect(ranked[1].source_id).toBe('ds-meh');
    expect(ranked[0]._rankingScore).toBeGreaterThan(ranked[1]._rankingScore);
  });

  it('adds _rankingScore, _source, and _matchDetails to each result', () => {
    const [result] = rank([makeDataset({ source_id: 'ds001' })], [], fullFilters);
    expect(typeof result._rankingScore).toBe('number');
    expect(result._source).toBe('mongodb');
    expect(result._matchDetails).toBeDefined();
    expect(result._matchDetails.matchCount).toBeGreaterThan(0);
    expect(result._matchDetails.matchRatio).toBeGreaterThan(0);
  });

  it('limits the result set to the top 30', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      makeDataset({ source_id: `ds-${i}`, title: `Dataset ${i}` })
    );
    const ranked = rank(many, [], {});
    expect(ranked).toHaveLength(30);
  });

  it('does not mutate the input arrays', () => {
    const mongo = [makeDataset({ source_id: 'ds001' })];
    const discovery = [makeDataset({ source_id: 'ds002' })];
    rank(mongo, discovery, fullFilters);
    expect(mongo).toHaveLength(1);
    expect(discovery).toHaveLength(1);
  });

  it('is deterministic — identical inputs produce identical order (Issue 5)', () => {
    const mongo = [
      makeDataset({ source_id: 'ds-c', title: 'Charlie' }),
      makeDataset({ source_id: 'ds-a', title: 'Alpha' }),
      makeDataset({ source_id: 'ds-b', title: 'Bravo' }),
    ];
    const repo = [makeDataset({ source: 'zenodo', source_id: 'z1', title: 'Zulu' })];
    const first  = rank(mongo, repo, [], {}).map((d) => d.source_id);
    const second = rank(mongo, repo, [], {}).map((d) => d.source_id);
    const third  = rank(mongo, repo, [], {}).map((d) => d.source_id);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('breaks score ties by Title ASC then Repository ASC (Issue 5)', () => {
    const equal = (source, source_id, title) =>
      makeDataset({ source, source_id, title, quality_score: 0.5, updated_at: daysAgo(50) });
    // Identical final scores — ordering must come from the tie-breaker chain.
    const ranked = rank(
      [
        equal('openneuro', 'ds-2', 'Zebra'),
        equal('openneuro', 'ds-1', 'Alpha'),
        equal('dandi', 'd-1', 'Alpha'),   // same title → Repository ASC
      ],
      [],
      {}
    );
    // 'Alpha' × 2 tie on title → Repository ASC: 'dandi' < 'openneuro' → d-1 first.
    expect(ranked.map((d) => d.source_id)).toEqual(['d-1', 'ds-1', 'ds-2']);
  });

  it('attaches component scores used by tie-breakers and diagnostics (Issue 6)', () => {
    const [result] = rank([makeDataset({ source_id: 'ds001' })], [], fullFilters);
    expect(typeof result._matchScore).toBe('number');
    expect(typeof result._qualityScore).toBe('number');
    expect(typeof result._trustScore).toBe('number');
    expect(typeof result._freshnessScore).toBe('number');
    expect(typeof result._diversityBonus).toBe('number');
    expect(result._matchDetails.credits).toBeDefined();
    expect(result._matchDetails.credits.modality).toBe(1);
  });

  it('attaches three-state coverage to every ranked result (Phase 8)', () => {
    const [result] = rank(
      [makeDataset({ source_id: 'ds001', age_group: null, disease: null })],
      [],
      { modality: ['fMRI'], condition: ['ADHD'], age_range: 'child' }
    );
    expect(result._matchDetails.coverage).toEqual({ matched: 2, mismatched: 0, unknown: 1 });
    expect(result._matchDetails.states.age_range).toBe('unknown');
    expect(result._matchDetails.states.condition).toBe('match');
  });
});

// ---- Retrieval V2 end-to-end ranking scenarios (Phase 16 TESTs 1/2/7) ----

describe('Retrieval V2 — relevance scenarios', () => {
  const queryFilters = { modality: ['fMRI'], condition: ['ADHD'], age_range: 'child' };

  const pediatricMatch = () =>
    makeDataset({
      source_id: 'ped-1',
      title: 'Multimodal resting state networks in pediatric ADHD',
      modality: ['fMRI'],
      disease: 'ADHD',
      age_group: 'child',
      keywords: ['adhd', 'fmri'],
    });

  const adultContradiction = () =>
    makeDataset({
      source_id: 'adu-1',
      title: 'Adult ADHD resting-state fMRI',
      modality: ['fMRI'],
      disease: 'ADHD',
      age_group: 'adult', // CONFIRMED mismatch vs requested child
      keywords: ['adhd', 'fmri'],
    });

  it('TEST 2: pediatric match outranks adult contradiction even when the adult record is fresher and verified', () => {
    const pediatric = pediatricMatch();
    const adult = adultContradiction();
    // Give the contradictory record every secondary advantage.
    adult.quality_score = 1.0;
    adult.trust_tier = 'verified';
    adult.updated_at = daysAgo(5); // freshness 1.0
    pediatric.quality_score = 0.6;
    pediatric.trust_tier = 'unverified';
    pediatric.updated_at = daysAgo(200); // freshness 0.6

    const [first] = rank([adult, pediatric], [], queryFilters);
    expect(first.source_id).toBe('ped-1');
  });

  it('TEST 2: confirmed mismatch receives a meaningful penalty (math check)', () => {
    const m = computeMatchScore(adultContradiction(), queryFilters);
    expect(m.mismatchedCount).toBe(1);
    expect(m.score).toBeCloseTo(0.4944, 3);
    expect(m.score).toBeLessThan(computeMatchScore(pediatricMatch(), queryFilters).score);
  });

  it('TEST 1: fully-matching candidate ranks above unknown-metadata candidates; unknown ≠ mismatch', () => {
    const allUnknown = makeDataset({
      source_id: 'unk-1',
      title: 'Some collection of neuroimaging data', // no concept evidence at all
      description: '',
      modality: [],
      species: [],
      disease: null,
      keywords: ['neuroimaging'],
      region: null,
      age_group: null,
    });
    const ranked = rank([allUnknown, pediatricMatch()], [], queryFilters);
    expect(ranked[0].source_id).toBe('ped-1');
    const unknownEntry = ranked.find((r) => r.source_id === 'unk-1');
    expect(unknownEntry._matchDetails.states.age_range).toBe('unknown');
    expect(unknownEntry._matchDetails.coverage.unknown).toBeGreaterThanOrEqual(2);
  });

  it('5/5 confirmed match strictly outranks 3/5 candidate despite secondary diversity bonus', () => {
    const fullMatch = makeDataset({
      source_id: 'full-5',
      source: 'zenodo',
      title: 'Wavelet variance coefficients of children with ADHD',
      modality: ['fMRI'],
      species: ['human'],
      disease: 'adhd',
      age_group: 'child',
      task: 'resting-state',
      quality_score: 0.69,
      trust_tier: 'verified',
    });
    const partialMatch = makeDataset({
      source_id: 'part-3',
      source: 'neurovault', // gets singleton diversity bonus +0.50 * 0.05 = +0.025
      title: 'The structural-functional connectome',
      modality: ['fMRI'],
      species: ['human'],
      disease: null,
      age_group: null,
      task: 'resting-state',
      quality_score: 0.63,
      trust_tier: 'verified',
    });

    const ranked = rank([partialMatch, fullMatch], [], {
      modality: ['fMRI'],
      species: ['human'],
      condition: ['ADHD'],
      task: 'resting-state',
      age_range: 'child',
    });

    expect(ranked[0].source_id).toBe('full-5');
  });

  it('deduplicates datasets with doi: prefix vs raw DOI string across repositories', () => {
    const docZenodo = makeDataset({
      source: 'zenodo',
      source_id: '6904112',
      doi: '10.5061/dryad.fxpnvx0vc',
      title: 'Date advanced functional nuclear magnetic resonance',
    });
    const docDryad = makeDataset({
      source: 'dryad',
      source_id: 'dryad.fxpnvx0vc',
      doi: 'doi:10.5061/dryad.fxpnvx0vc',
      title: 'Date advanced functional nuclear magnetic resonance',
    });

    const merged = deduplicate([docZenodo, docDryad]);
    expect(merged).toHaveLength(1);
    expect(merged[0].source_id).toBe('6904112');
  });

  it('recognizes "functional nuclear magnetic resonance" as generic MRI modality synonym', () => {
    const res = computeMatchScore(
      makeDataset({ modality: ['functional nuclear magnetic resonance'] }),
      { modality: ['mri'] }
    );
    expect(res.matchDetails.modality).toBe(true);
    expect(res.states.modality).toBe('match');
  });
});
