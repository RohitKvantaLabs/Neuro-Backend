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

  it('scores proportionally for partial matches (graded modality credit)', () => {
    // condition also matches via keywords, so strip 'adhd' from keywords
    const result = computeMatchScore(
      makeDataset({ modality: ['EEG'], disease: 'none', keywords: ['resting-state'] }),
      { modality: ['fMRI'], condition: ['ADHD'] }
    );
    expect(result.matchCount).toBe(0);
    expect(result.requestedCount).toBe(2);
    // EEG is declared but not in the fMRI synonym family → 0.35 partial credit
    // (evidence exists → penalized, not zero); condition misses → 0.
    // base = (0.35*1 + 0*1) / 2 = 0.175, no exact premium (0 matches).
    expect(result.score).toBeCloseTo(0.175);
    expect(result.credits.modality).toBe(0.35);
    expect(result.credits.condition).toBe(0);
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

  it('penalizes (not excludes) a declared modality outside the synonym family', () => {
    const result = computeMatchScore(
      makeDataset({ modality: ['eeg'] }),
      { modality: ['fMRI'] }
    );
    expect(result.matchDetails.modality).toBe(false);
    // Declared-but-different modality gets partial evidence credit, not zero.
    expect(result.score).toBeCloseTo(0.35);
    expect(result.credits.modality).toBe(0.35);
  });

  it('a declared modality is closer to the request than none (Issue 4 hierarchy)', () => {
    const exactMeg = computeMatchScore(makeDataset({ modality: ['MEG'] }), { modality: ['MEG'] });
    const mriInstead = computeMatchScore(makeDataset({ modality: ['MRI'] }), { modality: ['MEG'] });
    const none = computeMatchScore(makeDataset({ modality: [] }), { modality: ['MEG'] });
    // Exact match > declared-but-different > no declaration.
    expect(exactMeg.score).toBe(1);
    expect(mriInstead.score).toBeGreaterThan(none.score);
    expect(exactMeg.score).toBeGreaterThan(mriInstead.score);
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
    expect(parkinsonMeg.score).toBeGreaterThan(parkinsonMri.score);   // MEG > MRI
    expect(parkinsonMri.score).toBeGreaterThan(genericParkinson.score); // MRI > generic Parkinson
    expect(genericParkinson.score).toBeGreaterThan(unrelated.score);    // Parkinson > unrelated
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

  it('matches task from the title/description free text, not just keywords', () => {
    const result = computeMatchScore(
      makeDataset({ title: 'Working memory capacity in adolescents (fMRI)', keywords: [] }),
      { task: 'working memory' }
    );
    expect(result.matchDetails.task).toBe(true);
    expect(result.score).toBe(1);
    // A resting-state dataset must NOT match a working-memory request.
    const miss = computeMatchScore(
      makeDataset({ keywords: [] }),
      { task: 'working memory' }
    );
    expect(miss.matchDetails.task).toBe(false);
    expect(miss.score).toBe(0);
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
});
