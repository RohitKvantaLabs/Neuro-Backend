/**
 * catalogSearch.service.js — Unit Tests (Phase 12)
 *
 * Tests the new catalog retrieval module in isolation.
 * No database connection required — mongoose model is mocked.
 *
 * Covers:
 *   - expandModality: synonym expansion for all supported modalities
 *   - buildCatalogQuery: filter -> regex query construction
 *   - selectPrimarySource: DOI / URL / repo:id / first-source priority
 *   - projectCatalogDoc: field mapping, disease join, drop-of-malformed
 *   - catalogSearch: integration (mocked model), fallback on error
 *   - Dedup key reconstruction: source:source_id matches pipeline expectation
 */

'use strict';

// Mock mongoose before requiring the service.
// The service calls mongoose.model() exactly once per process; we mock find().lean()
// to control what the "DB" returns.
jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  const mockFind = jest.fn().mockReturnValue({
    limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
  });
  const mockModel = jest.fn().mockReturnValue({ find: mockFind });
  return {
    ...actual,
    Schema: actual.Schema,
    model: mockModel,
    _mockFind: mockFind,
  };
});

const mongoose = require('mongoose');
const {
  expandModality,
  buildCatalogQuery,
  selectPrimarySource,
  projectCatalogDoc,
  catalogSearch,
} = require('../src/modules/dataset/catalogSearch.service');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal valid catalog doc for projection tests. */
function makeCatalogDoc(overrides = {}) {
  return {
    canonicalDatasetId: 'ns-abc123',
    title: 'MEG Study of Working Memory',
    description: 'A multicentre MEG study.',
    doi: '10.18112/openneuro.ds000117.v1.0.0',
    modality: ['meg'],
    species: ['human'],
    disease: ['epilepsy', 'seizure'],
    brainRegions: ['hippocampus', 'prefrontal cortex'],
    ageGroup: ['Adults'],
    participantCount: 50,
    keywords: ['working memory', 'meg'],
    lastUpdated: '2024-01-15T00:00:00Z',
    createdAt: '2023-06-01T00:00:00Z',
    sourceKeys: ['openneuro:ds000117'],
    provenance: {
      identity: {
        primary: 'doi:10.18112/openneuro.ds000117.v1.0.0',
        matchedVia: 'doi',
        doi: '10.18112/openneuro.ds000117.v1.0.0',
        sourceUrlNorm: 'https://openneuro.org/datasets/ds000117',
      },
    },
    sources: [
      {
        repository: 'openneuro',
        sourceDatasetId: 'ds000117',
        sourceUrl: 'https://openneuro.org/datasets/ds000117',
        doi: '10.18112/openneuro.ds000117.v1.0.0',
        isDirectLink: false,
      },
    ],
    ...overrides,
  };
}

// ── expandModality ─────────────────────────────────────────────────────────────

describe('expandModality', () => {
  it('expands MEG to meg and magnetoencephalography', () => {
    const result = expandModality('MEG');
    expect(result).toContain('meg');
    expect(result).toContain('magnetoencephalography');
  });

  it('expands fMRI to catalog vocab (fmri, mri, func, bold)', () => {
    const result = expandModality('fMRI');
    expect(result).toContain('fmri');
    expect(result).toContain('mri');
    expect(result).toContain('func');
    expect(result).toContain('bold');
  });

  it('expands EEG to eeg, electroencephalography, electrophysiology', () => {
    const result = expandModality('eeg');
    expect(result).toContain('eeg');
    expect(result).toContain('electroencephalography');
    expect(result).toContain('electrophysiology');
  });

  it('expands diffusion MRI to dti, dwi, diffusion mri, mri', () => {
    const result = expandModality('diffusion mri');
    expect(result).toContain('dti');
    expect(result).toContain('dwi');
    expect(result).toContain('mri');
  });

  it('expands DTI to include dti and dwi', () => {
    const result = expandModality('dti');
    expect(result).toContain('dti');
    expect(result).toContain('dwi');
  });

  it('returns the original value unchanged for unknown modalities', () => {
    const result = expandModality('custom_modality');
    expect(result).toEqual(['custom_modality']);
  });

  it('returns unique values (no duplicates)', () => {
    const result = expandModality('mri');
    const unique = [...new Set(result)];
    expect(result.length).toBe(unique.length);
  });
});

// ── buildCatalogQuery ─────────────────────────────────────────────────────────

describe('buildCatalogQuery', () => {
  it('returns {} for empty filters', () => {
    expect(buildCatalogQuery({})).toEqual({});
    expect(buildCatalogQuery(null)).toEqual({});
    expect(buildCatalogQuery(undefined)).toEqual({});
  });

  it('generates $and with modality OR clause for MEG', () => {
    const q = buildCatalogQuery({ modality: ['MEG'] });
    expect(q).toHaveProperty('$and');
    const andClauses = q.$and;
    const modalityClause = andClauses.find((c) => c.$or && c.$or.some((o) => o.modality));
    expect(modalityClause).toBeDefined();
    // Should include both meg and magnetoencephalography
    const values = modalityClause.$or.map((o) => o.modality.source.toLowerCase());
    expect(values).toContain('meg');
    expect(values).toContain('magnetoencephalography');
  });

  it('generates brainRegions clause for region filter', () => {
    const q = buildCatalogQuery({ region: 'hippocampus' });
    const andClauses = q.$and || [];
    const regionClause = andClauses.find((c) => c.$or && c.$or.some((o) => o.brainRegions));
    expect(regionClause).toBeDefined();
  });

  it('generates ageGroup clause for age_group filter', () => {
    const q = buildCatalogQuery({ age_group: 'Adults' });
    const andClauses = q.$and || [];
    const ageClause = andClauses.find((c) => c.$or && c.$or.some((o) => o.ageGroup));
    expect(ageClause).toBeDefined();
  });

  it('generates disease clause for condition filter (catalog has array field)', () => {
    const q = buildCatalogQuery({ condition: ['epilepsy'] });
    const andClauses = q.$and || [];
    const diseaseClause = andClauses.find((c) => c.$or && c.$or.some((o) => o.disease));
    expect(diseaseClause).toBeDefined();
  });

  it('generates title/description/keywords OR for raw_query', () => {
    const q = buildCatalogQuery({ raw_query: 'meg datasets' });
    const andClauses = q.$and || [];
    const textClause = andClauses.find((c) =>
      c.$or && c.$or.some((o) => o.title || o.description || o.keywords)
    );
    expect(textClause).toBeDefined();
  });

  it('ignores single-character tokens in raw_query', () => {
    const q = buildCatalogQuery({ raw_query: 'a meg' });
    const andClauses = q.$and || [];
    const textClause = andClauses.find((c) =>
      c.$or && c.$or.some((o) => o.title)
    );
    if (textClause) {
      // 'a' should be filtered out (length < 2); 'meg' included
      const titles = textClause.$or.filter((o) => o.title).map((o) => o.title.source);
      expect(titles.some((s) => s === 'a')).toBe(false);
    }
  });
});

// ── selectPrimarySource ───────────────────────────────────────────────────────

describe('selectPrimarySource', () => {
  it('returns null for missing or empty sources', () => {
    expect(selectPrimarySource({})).toBeNull();
    expect(selectPrimarySource({ sources: [] })).toBeNull();
  });

  it('returns the only source when sources has one entry', () => {
    const doc = { sources: [{ repository: 'openneuro', sourceDatasetId: 'ds001' }] };
    expect(selectPrimarySource(doc)).toBe(doc.sources[0]);
  });

  it('selects by DOI when provenance.identity.doi matches', () => {
    const doc = {
      provenance: { identity: { doi: '10.1234/test' } },
      sources: [
        { repository: 'openneuro', sourceDatasetId: 'ds001', doi: '10.1234/test' },
        { repository: 'nemar',     sourceDatasetId: 'nemar001', doi: '10.999/other' },
      ],
    };
    const result = selectPrimarySource(doc);
    expect(result.repository).toBe('openneuro');
  });

  it('selects by sourceUrl when DOI not matched', () => {
    const doc = {
      provenance: { identity: { sourceUrlNorm: 'https://openneuro.org/datasets/ds002' } },
      sources: [
        { repository: 'openneuro', sourceDatasetId: 'ds002', sourceUrl: 'https://openneuro.org/datasets/ds002' },
        { repository: 'nemar',     sourceDatasetId: 'nemar002', sourceUrl: 'https://nemar.org/ds002' },
      ],
    };
    const result = selectPrimarySource(doc);
    expect(result.repository).toBe('openneuro');
  });

  it('falls back to first source when no match found', () => {
    const doc = {
      provenance: { identity: {} },
      sources: [
        { repository: 'dandi', sourceDatasetId: '000001' },
        { repository: 'nemar', sourceDatasetId: 'n001' },
      ],
    };
    const result = selectPrimarySource(doc);
    expect(result.repository).toBe('dandi');
  });
});

// ── projectCatalogDoc ─────────────────────────────────────────────────────────

describe('projectCatalogDoc', () => {
  it('returns null for null input', () => {
    expect(projectCatalogDoc(null)).toBeNull();
    expect(projectCatalogDoc(undefined)).toBeNull();
  });

  it('returns null for doc missing title', () => {
    const doc = makeCatalogDoc({ title: undefined });
    // title also absent from sources[].title
    doc.sources[0].title = undefined;
    expect(projectCatalogDoc(doc)).toBeNull();
  });

  it('returns null for doc with no sources (no source/source_id)', () => {
    const doc = makeCatalogDoc({ sources: [] });
    expect(projectCatalogDoc(doc)).toBeNull();
  });

  it('projects title correctly', () => {
    const result = projectCatalogDoc(makeCatalogDoc());
    expect(result.title).toBe('MEG Study of Working Memory');
  });

  it('reconstructs source and source_id from primary source (dedup key)', () => {
    const result = projectCatalogDoc(makeCatalogDoc());
    // Dedup key must be source:source_id = openneuro:ds000117
    expect(result.source).toBe('openneuro');
    expect(result.source_id).toBe('ds000117');
    expect(`${result.source}:${result.source_id}`).toBe('openneuro:ds000117');
  });

  it('joins disease array into a string (approved Q1)', () => {
    const result = projectCatalogDoc(makeCatalogDoc({ disease: ['epilepsy', 'seizure'] }));
    expect(result.disease).toBe('epilepsy seizure');
  });

  it('handles disease as a string directly', () => {
    const result = projectCatalogDoc(makeCatalogDoc({ disease: 'parkinson' }));
    expect(result.disease).toBe('parkinson');
  });

  it('projects brainRegions[] as space-joined region string', () => {
    const result = projectCatalogDoc(makeCatalogDoc({ brainRegions: ['hippocampus', 'amygdala'] }));
    expect(result.region).toBe('hippocampus amygdala');
  });

  it('projects ageGroup[] as space-joined age_group string', () => {
    const result = projectCatalogDoc(makeCatalogDoc({ ageGroup: ['Adults', 'Older Adults'] }));
    expect(result.age_group).toBe('Adults Older Adults');
  });

  it('maps participantCount to subject_count', () => {
    const result = projectCatalogDoc(makeCatalogDoc({ participantCount: 150 }));
    expect(result.subject_count).toBe(150);
  });

  it('maps lastUpdated to updated_at and createdAt to ingested_at', () => {
    const result = projectCatalogDoc(makeCatalogDoc());
    expect(result.updated_at).toBe('2024-01-15T00:00:00Z');
    expect(result.ingested_at).toBe('2023-06-01T00:00:00Z');
  });

  it('does NOT set quality_score (null → existing fallback)', () => {
    const result = projectCatalogDoc(makeCatalogDoc());
    expect(result.quality_score).toBeNull();
  });

  it('does NOT set trust_tier (null → 0.5 default in ranker)', () => {
    const result = projectCatalogDoc(makeCatalogDoc());
    expect(result.trust_tier).toBeNull();
  });

  it('sets _source to "catalog"', () => {
    const result = projectCatalogDoc(makeCatalogDoc());
    expect(result._source).toBe('catalog');
  });

  it('preserves _canonicalId from canonicalDatasetId', () => {
    const result = projectCatalogDoc(makeCatalogDoc());
    expect(result._canonicalId).toBe('ns-abc123');
  });

  it('preserves _sourceKeys array', () => {
    const result = projectCatalogDoc(makeCatalogDoc());
    expect(result._sourceKeys).toEqual(['openneuro:ds000117']);
  });

  it('does not expose _ prefixed fields that change API contract (all _ keys are internal)', () => {
    const result = projectCatalogDoc(makeCatalogDoc());
    // The public API contract fields should all be present
    expect(result).toHaveProperty('title');
    expect(result).toHaveProperty('source');
    expect(result).toHaveProperty('source_id');
    // Internal fields are _ prefixed — they don't appear in existing datasets docs
    expect(Object.keys(result).filter((k) => k.startsWith('_'))).toEqual(
      expect.arrayContaining(['_source', '_canonicalId', '_sourceKeys', '_catalogDoi', '_matchedVia'])
    );
  });

  it('two-source doc: selects openneuro as primary when DOI matches openneuro source', () => {
    const doc = makeCatalogDoc({
      sources: [
        {
          repository: 'openneuro',
          sourceDatasetId: 'ds000117',
          sourceUrl: 'https://openneuro.org/datasets/ds000117',
          doi: '10.18112/openneuro.ds000117.v1.0.0',
        },
        {
          repository: 'nemar',
          sourceDatasetId: 'n000117',
          sourceUrl: 'https://nemar.org/n000117',
          doi: null,
        },
      ],
    });
    const result = projectCatalogDoc(doc);
    expect(result.source).toBe('openneuro');
    expect(result.source_id).toBe('ds000117');
  });
});

// ── catalogSearch (mocked DB) ─────────────────────────────────────────────────

describe('catalogSearch', () => {
  beforeEach(() => {
    // Reset the mongoose mock's find chain before each test.
    // The service lazily creates the model; after first call it's cached.
    // We patch find on the instance returned by mongoose.model().
    const instance = mongoose.model.mock.results[0]?.value;
    if (instance) {
      instance.find = mongoose._mockFind;
    }
  });

  it('returns [] when the DB returns no documents', async () => {
    mongoose._mockFind.mockReturnValue({
      limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
    });
    const result = await catalogSearch({ modality: ['meg'] });
    expect(result).toEqual([]);
  });

  it('returns projected docs for valid catalog documents', async () => {
    const fakeDocs = [makeCatalogDoc()];
    mongoose._mockFind.mockReturnValue({
      limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(fakeDocs) }),
    });
    const result = await catalogSearch({ raw_query: 'meg' });
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('openneuro');
    expect(result[0].source_id).toBe('ds000117');
    expect(result[0]._source).toBe('catalog');
  });

  it('drops malformed docs (missing source) and returns the rest', async () => {
    const validDoc   = makeCatalogDoc();
    const invalidDoc = makeCatalogDoc({ sources: [] }); // no source -> null projection
    mongoose._mockFind.mockReturnValue({
      limit: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([validDoc, invalidDoc]),
      }),
    });
    const result = await catalogSearch({ raw_query: 'meg' });
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('openneuro');
  });

  it('throws on DB error (orchestrator will catch and use catalogResults=[])', async () => {
    mongoose._mockFind.mockReturnValue({
      limit: jest.fn().mockReturnValue({
        lean: jest.fn().mockRejectedValue(new Error('Mongo connection lost')),
      }),
    });
    await expect(catalogSearch({ raw_query: 'meg' })).rejects.toThrow('Mongo connection lost');
  });

  it('respects the limit argument', async () => {
    const mockLimit = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
    mongoose._mockFind.mockReturnValue({ limit: mockLimit });
    await catalogSearch({ raw_query: 'test' }, 50);
    expect(mockLimit).toHaveBeenCalledWith(50);
  });

  it('uses CATALOG_CANDIDATE_LIMIT (200) when no limit argument', async () => {
    const mockLimit = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
    mongoose._mockFind.mockReturnValue({ limit: mockLimit });
    await catalogSearch({ raw_query: 'test' });
    expect(mockLimit).toHaveBeenCalledWith(200);
  });
});

// ── Dedup key compatibility (integration sanity) ───────────────────────────────

describe('dedup key compatibility', () => {
  it('projected source:source_id matches the format expected by buildKeySet in orchestrator', () => {
    const result = projectCatalogDoc(makeCatalogDoc());
    // buildKeySet in retrievalOrchestrator.js: `${ds.source}:${ds.source_id}`
    const key = `${result.source}:${result.source_id}`;
    expect(key).toMatch(/^[a-zA-Z0-9_]+:[a-zA-Z0-9_]+/);
    expect(key).toBe('openneuro:ds000117');
  });

  it('_sourceKeys format matches orchestrator/rankingEngine dedup format (repo:id)', () => {
    const result = projectCatalogDoc(makeCatalogDoc());
    // _sourceKeys: ["openneuro:ds000117"] — same format as buildKeySet
    for (const key of result._sourceKeys) {
      expect(key).toMatch(/^[^:]+:[^:]+/);
    }
  });
});
