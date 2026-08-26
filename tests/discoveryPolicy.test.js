/**
 * Unit tests — DiscoveryPolicy (§19 Phase 3.2)
 *
 * Pure module — no I/O, no network calls, no database queries.
 * The env.config dependency is mocked so threshold tests are hermetic.
 * Covers: computeFieldCoverage, computeRetrievalQuality, evaluate()
 * (all 7 signals + aggregation).
 */
jest.mock('../src/config/env.config', () => ({
  discoveryPolicy: {
    minResults: 3,
    fieldCoverageThreshold: 0.3,
    qualityThreshold: 0.4,
    freshnessDays: 180,
    decisionThreshold: 0.5,
  },
  rankingEngine: {},
  featureFlags: {},
}));

const {
  evaluate,
  computeRetrievalQuality,
  computeFieldCoverage,
} = require('../src/modules/dataset/discoveryPolicy');

// ---- Fixtures ------------------------------------------------------------

const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

const fmriDataset = {
  title: 'Adult resting-state fMRI',
  source: 'openneuro',
  source_id: 'ds001',
  modality: ['fMRI'],
  species: ['human'],
  disease: 'none',
  keywords: ['resting-state'],
  region: 'whole-brain',
  age_group: 'adult',
  quality_score: 0.85,
  trust_tier: 'verified',
  updated_at: daysAgo(10),
  ingested_at: daysAgo(12),
};

const basicFilters = {
  modality: ['fMRI'],
  species: ['human'],
  condition: ['ADHD'],
  raw_query: 'fmri human',
};

// ---- computeFieldCoverage ------------------------------------------------

describe('computeFieldCoverage', () => {
  it('returns requested:false and null ratio for unrequested fields', () => {
    const coverage = computeFieldCoverage([fmriDataset], { modality: ['fMRI'] });
    expect(coverage.species).toEqual({ requested: false, matchedRatio: null });
    expect(coverage.condition).toEqual({ requested: false, matchedRatio: null });
    expect(coverage.modality.requested).toBe(true);
  });

  it('computes matchedRatio as datasetsMatching / totalResults', () => {
    const coverage = computeFieldCoverage([fmriDataset, { ...fmriDataset, modality: ['EEG'] }], { modality: ['fMRI'] });
    expect(coverage.modality).toMatchObject({ requested: true, matchCount: 1, totalResults: 2 });
    expect(coverage.modality.matchedRatio).toBe(0.5);
  });

  it('matches array-valued filters if ANY value matches', () => {
    const coverage = computeFieldCoverage([{ ...fmriDataset, modality: ['EEG'] }], { modality: ['fMRI', 'EEG'] });
    expect(coverage.modality.matchedRatio).toBe(1);
  });

  it('checks condition against disease and keywords case-insensitively', () => {
    const coverage = computeFieldCoverage([fmriDataset], { condition: ['adhd'] });
    expect(coverage.condition).toBeDefined();
    expect(coverage.condition.requested).toBe(true);
    expect(coverage.condition.matchCount).toBe(0);
  });

  it('reports zero matchCount when no result matches', () => {
    const coverage = computeFieldCoverage([fmriDataset], { condition: ['ADHD'] });
    expect(coverage.condition.matchCount).toBe(0);
    expect(coverage.condition.matchedRatio).toBe(0);
  });
});

// ---- computeRetrievalQuality ---------------------------------------------

describe('computeRetrievalQuality', () => {
  it('returns all-zero/null metrics for empty results', () => {
    const quality = computeRetrievalQuality([], basicFilters);
    expect(quality.resultCount).toBe(0);
    expect(quality.fieldCoverage).toEqual({});
    expect(quality.avgMetadataCompleteness).toBe(0);
    expect(quality.avgTrustTier).toBe(0);
    expect(quality.averageAgeDays).toBeNull();
    expect(quality.uniqueSources).toBe(0);
    expect(quality.uniqueModalities).toBe(0);
  });

  it('computes averages, freshness, and diversity for a result set', () => {
    const quality = computeRetrievalQuality(
      [
        { ...fmriDataset, quality_score: 0.9, trust_tier: 'verified', updated_at: daysAgo(10), source: 'openneuro' },
        { ...fmriDataset, quality_score: 0.5, trust_tier: 'unverified', updated_at: daysAgo(400), source: 'dandi' },
      ],
      basicFilters
    );

    expect(quality.resultCount).toBe(2);
    expect(quality.avgMetadataCompleteness).toBeCloseTo(0.7, 5);
    expect(quality.avgTrustTier).toBeCloseTo(0.75, 5);
    expect(quality.averageAgeDays).toBeGreaterThan(100);
    expect(quality.uniqueSources).toBe(2);
    expect(quality.uniqueModalities).toBe(1);
    expect(quality.newestDatasetDate).toBeInstanceOf(Date);
    expect(quality.oldestDatasetDate).toBeInstanceOf(Date);
  });

  it('uses 0.5 as a neutral quality_score when missing', () => {
    const quality = computeRetrievalQuality([{ ...fmriDataset, quality_score: null }], basicFilters);
    expect(quality.avgMetadataCompleteness).toBe(0.5);
  });

  it('uses 0.5 as a neutral trust tier for unknown tiers', () => {
    const quality = computeRetrievalQuality([{ ...fmriDataset, trust_tier: 'something_else' }], basicFilters);
    expect(quality.avgTrustTier).toBe(0.5);
  });

  it('returns null freshness when no dates are present', () => {
    const quality = computeRetrievalQuality([{ ...fmriDataset, updated_at: null, ingested_at: null }], basicFilters);
    expect(quality.averageAgeDays).toBeNull();
    expect(quality.newestDatasetDate).toBeNull();
  });

  it('attaches the complexity info to the quality object', () => {
    const complexityInfo = { level: 'high', score: 0.6, dimensionCount: 3, freshness: false };
    const quality = computeRetrievalQuality([fmriDataset], basicFilters, complexityInfo);
    expect(quality.complexity).toBe(complexityInfo);
  });
});

// ---- evaluate -------------------------------------------------------------

describe('evaluate — signal 1: zero_results (fast path)', () => {
  it('always triggers discovery for zero results', () => {
    const decision = evaluate({ resultCount: 0, fieldCoverage: {}, avgMetadataCompleteness: 0 }, basicFilters);
    expect(decision.shouldDiscover).toBe(true);
    expect(decision.confidence).toBe(1.0);
    expect(decision.signals).toEqual(['zero_results']);
    expect(decision.reason).toContain('No datasets found');
  });
});

describe('evaluate — signal 2: low_result_count', () => {
  const goodQuality = (resultCount, overrides = {}) => ({
    resultCount,
    fieldCoverage: {},
    avgMetadataCompleteness: 0.9,
    avgTrustTier: 1.0,
    averageAgeDays: 10,
    ...overrides,
  });

  it('triggers discovery when resultCount < minResults (3)', () => {
    const decision = evaluate(goodQuality(1), basicFilters);
    expect(decision.signals).toContain('low_result_count');
    expect(decision.shouldDiscover).toBe(true);
    expect(decision.confidence).toBe(0.8);
  });

  it('does not trigger for sufficient results', () => {
    const decision = evaluate(goodQuality(5), basicFilters);
    expect(decision.signals).not.toContain('low_result_count');
    expect(decision.shouldDiscover).toBe(false);
  });
});

describe('evaluate — signal 3: poor_field_coverage', () => {
  const qualityWithCoverage = (coverage) => ({
    resultCount: 5,
    fieldCoverage: coverage,
    avgMetadataCompleteness: 0.9,
    avgTrustTier: 1.0,
    averageAgeDays: 10,
  });

  it('triggers when a requested field has matchedRatio below threshold', () => {
    const decision = evaluate(
      qualityWithCoverage({
        condition: { requested: true, matchedRatio: 0, matchCount: 0, totalResults: 5 },
      }),
      basicFilters
    );
    expect(decision.signals).toContain('poor_field_coverage');
    expect(decision.shouldDiscover).toBe(true);
    expect(decision.reason).toContain('condition coverage');
  });

  it('does not trigger when all requested fields are covered', () => {
    const decision = evaluate(
      qualityWithCoverage({
        condition: { requested: true, matchedRatio: 0.8, matchCount: 4, totalResults: 5 },
      }),
      basicFilters
    );
    expect(decision.signals).not.toContain('poor_field_coverage');
  });

  it('ignores unrequested fields (matchedRatio null)', () => {
    const decision = evaluate(
      qualityWithCoverage({ region: { requested: false, matchedRatio: null } }),
      basicFilters
    );
    expect(decision.signals).not.toContain('poor_field_coverage');
  });
});

describe('evaluate — signal 4: freshness_requirement', () => {
  const baseQuality = {
    resultCount: 5,
    fieldCoverage: {},
    avgMetadataCompleteness: 0.9,
    avgTrustTier: 1.0,
    averageAgeDays: 300,
  };

  it('triggers when freshness required and results are stale', () => {
    const decision = evaluate(baseQuality, basicFilters, { freshnessRequirement: true });
    expect(decision.signals).toContain('freshness_requirement');
    expect(decision.shouldDiscover).toBe(true);
    expect(decision.confidence).toBe(0.6);
  });

  it('does not trigger when results are fresh', () => {
    const decision = evaluate({ ...baseQuality, averageAgeDays: 30 }, basicFilters, { freshnessRequirement: true });
    expect(decision.signals).not.toContain('freshness_requirement');
  });

  it('does not trigger when freshness is not required', () => {
    const decision = evaluate(baseQuality, basicFilters, { freshnessRequirement: false });
    expect(decision.signals).not.toContain('freshness_requirement');
  });
});

describe('evaluate — signal 5: low_metadata_quality', () => {
  const baseQuality = {
    resultCount: 5,
    fieldCoverage: {},
    avgTrustTier: 1.0,
    averageAgeDays: 10,
  };

  it('triggers when avgMetadataCompleteness < threshold (0.4)', () => {
    const decision = evaluate({ ...baseQuality, avgMetadataCompleteness: 0.2 }, basicFilters);
    expect(decision.signals).toContain('low_metadata_quality');
    expect(decision.confidence).toBe(0.5);
    expect(decision.shouldDiscover).toBe(true);
  });

  it('does not trigger when metadata is sufficient', () => {
    const decision = evaluate({ ...baseQuality, avgMetadataCompleteness: 0.8 }, basicFilters);
    expect(decision.signals).not.toContain('low_metadata_quality');
    expect(decision.shouldDiscover).toBe(false);
  });
});

describe('evaluate — signal 6: high_query_complexity', () => {
  const baseQuality = {
    fieldCoverage: {},
    avgMetadataCompleteness: 0.9,
    avgTrustTier: 1.0,
    averageAgeDays: 10,
  };

  it('triggers for high complexity with few results', () => {
    const decision = evaluate(
      { ...baseQuality, resultCount: 2 },
      basicFilters,
      { queryComplexity: { level: 'high' } }
    );
    expect(decision.signals).toContain('high_query_complexity');
  });

  it('does not trigger for low complexity even with few results', () => {
    const decision = evaluate(
      { ...baseQuality, resultCount: 2 },
      basicFilters,
      { queryComplexity: { level: 'low' } }
    );
    expect(decision.signals).not.toContain('high_query_complexity');
  });

  it('does not trigger for high complexity with enough results', () => {
    const decision = evaluate(
      { ...baseQuality, resultCount: 10 },
      basicFilters,
      { queryComplexity: { level: 'high' } }
    );
    expect(decision.signals).not.toContain('high_query_complexity');
  });
});

describe('evaluate — signal 7: low_confidence_results', () => {
  const baseQuality = {
    resultCount: 5,
    fieldCoverage: {},
    avgMetadataCompleteness: 0.9,
    averageAgeDays: 10,
  };

  it('triggers when all results are unverified (avgTrustTier <= 0.5)', () => {
    const decision = evaluate({ ...baseQuality, avgTrustTier: 0.5 }, basicFilters);
    expect(decision.signals).toContain('low_confidence_results');
    expect(decision.confidence).toBe(0.3);
    expect(decision.shouldDiscover).toBe(false); // 0.3 < decision threshold 0.5
  });

  it('does not trigger for verified results', () => {
    const decision = evaluate({ ...baseQuality, avgTrustTier: 1.0 }, basicFilters);
    expect(decision.signals).not.toContain('low_confidence_results');
  });
});

describe('evaluate — aggregation & boundaries', () => {
  it('aggregates confidence as the MAX weight of triggered signals', () => {
    // low_result_count (0.8) + low_confidence_results (0.3) → max = 0.8
    const decision = evaluate(
      {
        resultCount: 1,
        fieldCoverage: {},
        avgMetadataCompleteness: 0.9,
        avgTrustTier: 0.5,
        averageAgeDays: 10,
      },
      basicFilters
    );
    expect(decision.confidence).toBe(0.9);
    expect(decision.signals).toContain('low_result_count');
    expect(decision.signals).toContain('low_confidence_results');
    expect(decision.shouldDiscover).toBe(true);
  });

  it('returns shouldDiscover:false with null reason when no signal triggers', () => {
    const decision = evaluate(
      {
        resultCount: 10,
        fieldCoverage: { condition: { requested: true, matchedRatio: 0.9 } },
        avgMetadataCompleteness: 0.9,
        avgTrustTier: 1.0,
        averageAgeDays: 10,
      },
      basicFilters,
      { queryComplexity: { level: 'low' } }
    );
    expect(decision.shouldDiscover).toBe(false);
    expect(decision.reason).toBeNull();
    expect(decision.confidence).toBe(0);
    expect(decision.signals).toEqual([]);
  });

  it('uses the decision threshold inclusively (>= 0.5)', () => {
    // low_metadata_quality alone = 0.5 → shouldDiscover true
    const decision = evaluate(
      {
        resultCount: 5,
        fieldCoverage: {},
        avgMetadataCompleteness: 0.2,
        avgTrustTier: 1.0,
        averageAgeDays: 10,
      },
      basicFilters
    );
    expect(decision.confidence).toBe(0.5);
    expect(decision.shouldDiscover).toBe(true);
  });
});
