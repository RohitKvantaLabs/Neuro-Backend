/**
 * Phase 4 (§4.11) — repository layer unit tests.
 *
 * Covers:
 *   - discoveryPolicy.evaluateAfterRepositories (post-repo web gate, raised bar)
 *   - rankingEngine rank/deduplicate with THREE pools (dedup precedence,
 *     _source labels, weights unchanged)
 *   - agent.client.runRepositorySearch (in-process cache + circuit breaker)
 *
 * Pure modules except agent.client — its HTTP client is mocked.
 */
jest.mock('../src/config/env.config', () => ({
  discoveryPolicy: {
    minResults: 3,
    fieldCoverageThreshold: 0.3,
    qualityThreshold: 0.4,
    freshnessDays: 180,
    decisionThreshold: 0.5,
  },
  rankingEngine: {
    matchWeight: 0.5,
    qualityWeight: 0.2,
    freshnessWeight: 0.15,
    trustWeight: 0.1,
    diversityWeight: 0.05,
  },
  featureFlags: {
    useNewOrchestrator: true,
    useRepositoryLayer: true,
    useWebDiscovery: true,
  },
  repositoryRetrieval: {
    enabledSources: ['openneuro', 'dandi'],
    limitPerSource: 10,
    cacheTtlMs: 5 * 60 * 1000,
  },
  pythonAgent: {
    baseUrl: 'http://python.test',
    internalSecret: 'test-secret',
    timeoutMs: 5000,
    model: 'test-model',
  },
}));

// ─────────────────────────────────────────────────────────────────────────────
// evaluateAfterRepositories
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluateAfterRepositories', () => {
  const { evaluateAfterRepositories } = require('../src/modules/dataset/discoveryPolicy');

  const combinedPoolQuality = (resultCount, coverage = {}) => ({
    resultCount,
    fieldCoverage: coverage,
    avgMetadataCompleteness: 0.9,
    avgTrustTier: 1.0,
    averageAgeDays: 10,
  });

  it('never triggers web discovery when the feature flag is off', () => {
    const envMock = require('../src/config/env.config');
    envMock.featureFlags.useWebDiscovery = false;
    try {
      const decision = evaluateAfterRepositories(
        combinedPoolQuality(0), // even zero results must NOT trigger web
        { modality: ['fMRI'] }
      );
      expect(decision.shouldDiscoverWeb).toBe(false);
      expect(decision.reason).toBe('web_discovery_disabled');
      expect(decision.signals).toEqual([]);
    } finally {
      envMock.featureFlags.useWebDiscovery = true;
    }
  });

  it('triggers web discovery on zero results', () => {
    const decision = evaluateAfterRepositories(
      combinedPoolQuality(0),
      { modality: ['fMRI'] }
    );
    expect(decision.shouldDiscoverWeb).toBe(true);
    expect(decision.confidence).toBe(1.0);
    expect(decision.signals).toEqual(['zero_results']);
  });

  it('raises the effective minResults bar against the combined pool', () => {
    // Base evaluate() minResults=3 would NOT trigger at 4 results, but the
    // post-repo bar is raised to 6 (§4.4) — 4 results must still trigger web.
    const decision = evaluateAfterRepositories(
      combinedPoolQuality(4),
      { modality: ['fMRI'] }
    );
    expect(decision.shouldDiscoverWeb).toBe(true);
    expect(decision.signals).toContain('low_result_count');
  });

  it('accepts a combined pool that clears the raised bar', () => {
    const decision = evaluateAfterRepositories(
      combinedPoolQuality(6),
      { modality: ['fMRI'] }
    );
    expect(decision.shouldDiscoverWeb).toBe(false);
    expect(decision.reason).toBeNull();
  });

  it('raises the effective field-coverage bar', () => {
    // Base fieldCoverageThreshold=0.3 — 0.4 coverage would pass evaluate(),
    // but the raised bar (0.5) fails it (strict <). Correct demonstration of §4.4.
    const decision = evaluateAfterRepositories(
      combinedPoolQuality(6, {
        condition: { requested: true, matchedRatio: 0.4, matchCount: 2, totalResults: 6 },
      }),
      { condition: ['ADHD'] }
    );
    expect(decision.shouldDiscoverWeb).toBe(true);
    expect(decision.signals).toContain('poor_field_coverage');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rank() with three pools (§4.5)
// ─────────────────────────────────────────────────────────────────────────────

describe('rank with three pools', () => {
  const { rank, deduplicate } = require('../src/modules/dataset/rankingEngine');

  const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const makeDataset = (overrides = {}) => ({
    title: 'Adult resting-state fMRI in ADHD',
    description: 'A comprehensive resting-state fMRI dataset.',
    source: 'openneuro',
    source_id: 'ds001',
    modality: ['fMRI'],
    species: ['human'],
    disease: 'ADHD',
    keywords: ['resting-state'],
    quality_score: 0.85,
    trust_tier: 'verified',
    updated_at: daysAgo(10),
    ...overrides,
  });
  const filters = { modality: ['fMRI'], species: ['human'], condition: ['ADHD'] };

  it('annotates _source per pool: mongodb → repository → discovery', () => {
    const merged = deduplicate(
      [makeDataset({ source_id: 'a' })],
      [makeDataset({ source_id: 'b' })],
      [makeDataset({ source_id: 'c' })]
    );
    expect(merged.map((ds) => ds._source)).toEqual(['mongodb', 'repository', 'discovery']);
  });

  it('gives Mongo priority over repository over discovery on duplicate keys', () => {
    const merged = deduplicate(
      [makeDataset({ source_id: 'x', title: 'Mongo version' })],
      [makeDataset({ source_id: 'x', title: 'Repo version' })],
      [makeDataset({ source_id: 'x', title: 'Web version' })]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe('Mongo version');
    expect(merged[0]._source).toBe('mongodb');
  });

  it('repository beats discovery on a duplicate key', () => {
    const merged = deduplicate(
      [],
      [makeDataset({ source_id: 'x', title: 'Repo version' })],
      [makeDataset({ source_id: 'x', title: 'Web version' })]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe('Repo version');
    expect(merged[0]._source).toBe('repository');
  });

  it('rank() merges three pools, dedups, scores, and ranks', () => {
    const ranked = rank(
      [makeDataset({ source_id: 'a' })],
      [makeDataset({ source_id: 'b' })],
      [makeDataset({ source_id: 'a' }), makeDataset({ source_id: 'c' })],
      filters
    );
    expect(ranked).toHaveLength(3);
    const sources = ranked.map((ds) => ds._source).sort();
    expect(sources).toEqual(['discovery', 'mongodb', 'repository']); // sorted lexicographically
    expect(ranked.every((ds) => typeof ds._rankingScore === 'number')).toBe(true);
  });

  it('rank() still supports the legacy 2-pool call signature', () => {
    // Legacy: rank(mongodbResults, discoveryResults, filters)
    const ranked = rank(
      [makeDataset({ source_id: 'a' })],
      [makeDataset({ source_id: 'b' })],
      filters
    );
    expect(ranked).toHaveLength(2);
    expect(ranked.map((ds) => ds._source).sort()).toEqual(['discovery', 'mongodb']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// agent.client.runRepositorySearch — cache + circuit breaker (§4.7)
// ─────────────────────────────────────────────────────────────────────────────

describe('runRepositorySearch', () => {
  const mockPost = jest.fn();
  jest.mock('axios', () => ({ create: jest.fn(() => ({ post: mockPost })) }));
  jest.mock('../src/modules/admin/tokenUsage.model', () => ({ create: jest.fn().mockResolvedValue({}) }));
  jest.mock('../src/modules/admin/agentLog.model', () => ({ create: jest.fn().mockResolvedValue({}) }));

  let runRepositorySearch;
  let CircuitBreakerOpenError;
  beforeEach(() => {
    // Fresh module registry per test: _repoSearchCache and the shared
    // _pythonAgentCB are module-level singletons — without a reset, earlier
    // tests pollute later ones (warm cache hits / breaker left open).
    // NB: re-require circuitBreaker here too — after resetModules its class
    // identity changes, so instanceof checks against a stale reference fail.
    jest.resetModules();
    mockPost.mockReset();
    ({ runRepositorySearch } = require('../src/modules/agent/agent.client'));
    ({ CircuitBreakerOpenError } = require('../src/utils/circuitBreaker'));
  });

  const successPayload = {
    query_id: 'abc',
    sources_queried: ['openneuro', 'dandi'],
    total_found: 2,
    elapsed_ms: 350,
    datasets: [
      { source: 'openneuro', source_id: 'ds001', title: 'D1' },
      { source: 'dandi', source_id: 'd000001', title: 'D2' },
    ],
  };

  it('POSTs to /agents/repository-search with query + filters', async () => {
    mockPost.mockResolvedValueOnce({ data: successPayload });
    const res = await runRepositorySearch({ query: 'fmri adhd', filters: { modality: ['fMRI'] } });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost.mock.calls[0][0]).toBe('/agents/repository-search');
    expect(mockPost.mock.calls[0][1]).toMatchObject({ query: 'fmri adhd', filters: { modality: ['fMRI'] } });
    expect(res.total_found).toBe(2);
    expect(res.datasets).toHaveLength(2);
  });

  it('serves identical filters from the 5-minute cache without a second POST', async () => {
    mockPost.mockResolvedValue({ data: successPayload });
    const args = { query: 'fmri adhd', filters: { modality: ['fMRI'] } };
    await runRepositorySearch(args);
    await runRepositorySearch(args);
    expect(mockPost).toHaveBeenCalledTimes(1); // cache hit on second call
  });

  it('misses the cache when filters differ', async () => {
    mockPost.mockResolvedValue({ data: successPayload });
    await runRepositorySearch({ query: 'fmri adhd', filters: { modality: ['fMRI'] } });
    await runRepositorySearch({ query: 'eeg children', filters: { modality: ['EEG'] } });
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it('throws through the circuit breaker after repeated failures', async () => {
    mockPost.mockRejectedValue(new Error('python down'));
    const args = { query: 'broken', filters: {} };

    // 5 consecutive failures open the shared breaker.
    for (let i = 0; i < 5; i += 1) {
      await expect(runRepositorySearch(args)).rejects.toThrow('python down');
    }
    // 6th call fails fast with CircuitBreakerOpenError — no HTTP attempt.
    await expect(runRepositorySearch(args)).rejects.toBeInstanceOf(CircuitBreakerOpenError);
    expect(mockPost).toHaveBeenCalledTimes(5);
  });
});
