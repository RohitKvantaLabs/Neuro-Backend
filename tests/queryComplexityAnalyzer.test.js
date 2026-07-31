/**
 * Unit tests — QueryComplexityAnalyzer (§19 Phase 3.1)
 *
 * Pure module — no I/O, no side effects, no env dependency.
 * Covers: dimension counting, level mapping (low/medium/high/very_high),
 * score normalization (capped at 1.0), and freshness keyword detection.
 */
const {
  analyzeQueryComplexity,
  FRESHNESS_KEYWORDS,
} = require('../src/modules/dataset/queryComplexityAnalyzer');

describe('analyzeQueryComplexity', () => {
  it('returns low complexity for empty filters', () => {
    const result = analyzeQueryComplexity({});
    expect(result.dimensionCount).toBe(0);
    expect(result.score).toBe(0);
    expect(result.level).toBe('low');
    expect(result.freshness).toBe(false);
  });

  it('handles undefined filters gracefully', () => {
    const result = analyzeQueryComplexity();
    expect(result.dimensionCount).toBe(0);
    expect(result.level).toBe('low');
  });

  it('returns low for a single dimension', () => {
    const result = analyzeQueryComplexity({ modality: ['fMRI'] });
    expect(result.dimensionCount).toBe(1);
    expect(result.level).toBe('low');
  });

  it('returns medium for two dimensions', () => {
    const result = analyzeQueryComplexity({
      modality: ['fMRI'],
      species: ['human'],
    });
    expect(result.dimensionCount).toBe(2);
    expect(result.level).toBe('medium');
  });

  it('returns high for three or four dimensions', () => {
    const result = analyzeQueryComplexity({
      modality: ['fMRI'],
      species: ['human'],
      condition: ['ADHD'],
      task: 'resting-state',
    });
    expect(result.dimensionCount).toBe(4);
    expect(result.level).toBe('high');
  });

  it('returns very_high for five or more dimensions', () => {
    const result = analyzeQueryComplexity({
      modality: ['fMRI'],
      species: ['human'],
      condition: ['ADHD'],
      task: 'resting-state',
      region: 'hippocampus',
      age_range: 'adult',
    });
    expect(result.dimensionCount).toBe(6);
    expect(result.level).toBe('very_high');
  });

  it('counts age_group as a dimension', () => {
    const result = analyzeQueryComplexity({ age_group: 'children' });
    expect(result.dimensionCount).toBe(1);
    expect(result.level).toBe('low');
  });

  it('ignores empty arrays when counting dimensions', () => {
    const result = analyzeQueryComplexity({
      modality: [],
      species: [],
      condition: [],
      format: [],
    });
    expect(result.dimensionCount).toBe(0);
  });

  it('caps the complexity score at 1.0', () => {
    const result = analyzeQueryComplexity({
      modality: ['fMRI'],
      species: ['human'],
      condition: ['ADHD'],
      task: 'resting-state',
      region: 'hippocampus',
      age_range: 'adult',
      format: ['NIfTI'],
      keywords: ['resting'],
    });
    // age_range + age_group count as a single dimension (8 is the max)
    expect(result.score).toBe(1.0);
    expect(result.dimensionCount).toBe(8);
  });

  it('detects freshness keywords in raw_query', () => {
    expect(analyzeQueryComplexity({ raw_query: 'latest Alzheimer datasets' }).freshness).toBe(true);
    expect(analyzeQueryComplexity({ raw_query: 'recent EEG data' }).freshness).toBe(true);
    expect(analyzeQueryComplexity({ raw_query: 'newest DTI study' }).freshness).toBe(true);
    expect(analyzeQueryComplexity({ raw_query: 'updated structural MRI' }).freshness).toBe(true);
    expect(analyzeQueryComplexity({ raw_query: 'current connectivity' }).freshness).toBe(true);
  });

  it('does not flag freshness when no keyword is present', () => {
    expect(analyzeQueryComplexity({ raw_query: 'structural MRI' }).freshness).toBe(false);
    expect(analyzeQueryComplexity({ raw_query: 'resting-state fMRI' }).freshness).toBe(false);
  });

  it('freshness detection is case-insensitive', () => {
    expect(analyzeQueryComplexity({ raw_query: 'LATEST Alzheimer' }).freshness).toBe(true);
    expect(analyzeQueryComplexity({ raw_query: 'Recent EEG' }).freshness).toBe(true);
  });

  it('exports the freshness keyword list', () => {
    expect(Array.isArray(FRESHNESS_KEYWORDS)).toBe(true);
    expect(FRESHNESS_KEYWORDS).toContain('latest');
    expect(FRESHNESS_KEYWORDS).toContain('recent');
    expect(FRESHNESS_KEYWORDS).toContain('new');
    expect(FRESHNESS_KEYWORDS).toContain('updated');
  });
});
