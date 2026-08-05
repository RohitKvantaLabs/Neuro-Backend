/**
 * Phase 4 (§4.11) — orchestrator integration tests for the two-tier discovery
 * flow (repositories first, web second).
 *
 * Covers:
 *   - repo-tier-then-web-tier ordering (web only when post-repo quality is low)
 *   - repo-only path when the combined pool clears the raised bar
 *   - web-only path when the repository layer is disabled
 *   - failure degradation (repo fail → web; web fail → mongo only)
 *
 * agent.client and dataset.service are mocked; discoveryPolicy, rankingEngine,
 * and queryComplexityAnalyzer are the real pure modules.
 */

jest.mock('../src/modules/agent/agent.client', () => ({
  parseQuery: jest.fn(),
  runFallbackSearch: jest.fn(),
  runRepositorySearch: jest.fn(),
}));

jest.mock('../src/modules/dataset/dataset.service', () => ({
  searchMongoDB: jest.fn(),
  filterDatasetsByMetadata: jest.fn((datasets) => datasets),
}));

// Pin the orchestrator on; repository layer + web discovery on by default.
process.env.FF_USE_NEW_ORCHESTRATOR = 'true';
process.env.FF_USE_REPOSITORY_LAYER = 'true';
process.env.FF_USE_WEB_DISCOVERY = 'true';

const {
  parseQuery,
  runFallbackSearch,
  runRepositorySearch,
} = require('../src/modules/agent/agent.client');
const { searchMongoDB } = require('../src/modules/dataset/dataset.service');
const { orchestrateSearch } = require('../src/modules/dataset/retrievalOrchestrator');

// ── Fixtures ────────────────────────────────────────────────────────────────

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
  quality_score: 0.9,
  trust_tier: 'verified',
  updated_at: daysAgo(10),
  ingested_at: daysAgo(12),
  ...overrides,
});

const filters = {
  raw_query: 'fmri adhd',
  modality: ['fMRI'],
  species: ['human'],
  condition: ['ADHD'],
};

beforeEach(() => {
  jest.clearAllMocks();
  parseQuery.mockResolvedValue(filters);
  runFallbackSearch.mockResolvedValue({ datasets_found: 0, published: false });
  runRepositorySearch.mockResolvedValue({ datasets: [], sources_queried: ['openneuro'], total_found: 0 });
  searchMongoDB.mockResolvedValue([]);
});

afterAll(() => {
  // Restore the process-level flags we pinned at module top so they can't
  // leak into other test files in the same --runInBand process.
  delete process.env.FF_USE_NEW_ORCHESTRATOR;
  delete process.env.FF_USE_REPOSITORY_LAYER;
  delete process.env.FF_USE_WEB_DISCOVERY;
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('orchestrateSearch — two-tier discovery (§4.4)', () => {
  it('runs the repository tier first, then web only when post-repo quality is low', async () => {
    // Mongo empty → shouldDiscover. Repo tier returns few results (below the
    // raised minResults bar of 6) → web tier must still run.
    runRepositorySearch.mockResolvedValue({
      datasets: [makeDataset({ source_id: 'repo1' })],
      sources_queried: ['openneuro'],
      total_found: 1,
    });
    searchMongoDB.mockResolvedValueOnce([]) // initial mongo query
      .mockResolvedValueOnce([makeDataset({ source_id: 'web1' })]); // after web write

    const result = await orchestrateSearch('fmri adhd', null, { userId: 'u1', userEmail: 'u@x.io' });

    expect(runRepositorySearch).toHaveBeenCalledTimes(1);
    expect(runFallbackSearch).toHaveBeenCalledTimes(1); // web ran because repo pool was insufficient
    expect(result.metrics.fromRepository).toBe(1);
    expect(result.metrics.fromDiscovery).toBe(1);
    expect(result.source).toBe('merged');
  });

  it('skips the web tier when the combined Mongo+repo pool clears the raised bar', async () => {
    // Repo tier returns 6+ high-quality results — above the raised minResults.
    runRepositorySearch.mockResolvedValue({
      datasets: Array.from({ length: 6 }, (_, i) => makeDataset({ source_id: `repo${i}` })),
      sources_queried: ['openneuro', 'dandi'],
      total_found: 6,
    });

    const result = await orchestrateSearch('fmri adhd', null, { userId: 'u1', userEmail: 'u@x.io' });

    expect(runRepositorySearch).toHaveBeenCalledTimes(1);
    expect(runFallbackSearch).not.toHaveBeenCalled(); // web skipped
    expect(result.metrics.fromRepository).toBe(6);
    expect(result.metrics.fromDiscovery).toBe(0);
  });

  it('runs only the web tier when the repository layer is disabled', async () => {
    const env = require('../src/config/env.config');
    const original = env.featureFlags.useRepositoryLayer;
    env.featureFlags.useRepositoryLayer = false;
    try {
      searchMongoDB.mockResolvedValueOnce([])
        .mockResolvedValueOnce([makeDataset({ source_id: 'web1' })]);

      const result = await orchestrateSearch('fmri adhd', null, { userId: 'u1', userEmail: 'u@x.io' });

      expect(runRepositorySearch).not.toHaveBeenCalled();
      expect(runFallbackSearch).toHaveBeenCalledTimes(1);
      expect(result.metrics.fromDiscovery).toBe(1);
      expect(result.source).toBe('merged');
    } finally {
      env.featureFlags.useRepositoryLayer = original;
    }
  });

  it('degrades gracefully: repo failure still allows the web tier', async () => {
    runRepositorySearch.mockRejectedValue(new Error('python repo tier down'));
    searchMongoDB.mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeDataset({ source_id: 'web1' })]);

    const result = await orchestrateSearch('fmri adhd', null, { userId: 'u1', userEmail: 'u@x.io' });

    expect(runFallbackSearch).toHaveBeenCalledTimes(1);
    expect(result.metrics.fromRepository).toBe(0);
    expect(result.metrics.fromDiscovery).toBe(1);
  });

  it('degrades gracefully: web failure returns Mongo+repo results only', async () => {
    runRepositorySearch.mockResolvedValue({
      datasets: [makeDataset({ source_id: 'repo1' })],
      sources_queried: ['openneuro'],
      total_found: 1,
    });
    runFallbackSearch.mockRejectedValue(new Error('python web tier down'));

    const result = await orchestrateSearch('fmri adhd', null, { userId: 'u1', userEmail: 'u@x.io' });

    expect(result.metrics.fromRepository).toBe(1);
    expect(result.metrics.fromDiscovery).toBe(0);
    expect(result.metrics.totalFound).toBe(1);
  });

  it('returns cache source when nothing was added by either tier', async () => {
    // Mongo has results, repo/web both return nothing new.
    searchMongoDB.mockResolvedValue([makeDataset({ source_id: 'mongo1' })]);

    const result = await orchestrateSearch('fmri adhd', null, { userId: 'u1', userEmail: 'u@x.io' });

    expect(result.source).toBe('cache');
    expect(result.metrics.fromRepository).toBe(0);
    expect(result.metrics.fromDiscovery).toBe(0);
  });
});
