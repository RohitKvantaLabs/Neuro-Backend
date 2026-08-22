const request = require('supertest');

jest.mock('../src/config/db.config', () => jest.fn().mockResolvedValue());

const app = require('../src/app');
const Dataset = require('../src/modules/dataset/dataset.model');
const { AdminDatasetOverride } = require('../src/modules/dataset/adminDatasetOverride.model');
const { PopularDataset } = require('../src/modules/dataset/popularDataset.model');

jest.mock('../src/modules/dataset/dataset.model');
jest.mock('../src/modules/dataset/adminDatasetOverride.model', () => ({
  AdminDatasetOverride: {
    find: jest.fn(),
  },
}));
jest.mock('../src/modules/dataset/popularDataset.model', () => {
  const actual = jest.requireActual('../src/modules/dataset/popularDataset.model');
  return {
    PopularDataset: {
      find: jest.fn(),
    },
    POPULAR_STATUSES: actual.POPULAR_STATUSES,
  };
});

function makeChain(result) {
  return {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(result),
  };
}

describe('Public Popular Datasets API — Phase 5', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/v1/datasets/popular returns published active datasets ordered by displayOrder ASC with max limit of 6', async () => {
    // 7 published popular dataset records in database
    const rawPopular = Array.from({ length: 7 }, (_, i) => ({
      datasetId: `ds_00${i + 1}`,
      status: 'published',
      displayOrder: i + 1,
      featuredTitleOverride: i === 0 ? 'Custom Headline' : null,
    }));

    // Mock PopularDataset query (our controller calls .limit(6))
    PopularDataset.find.mockReturnValue(makeChain(rawPopular.slice(0, 6)));

    // Mock canonical datasets (ds_002 is inactive)
    const canonicalDocs = [
      { _id: 'ds_001', source: 'OpenNeuro', title: 'Canonical Title 1', modality: ['fMRI'], is_active: true },
      { _id: 'ds_002', source: 'ADNI', title: 'Canonical Title 2', is_active: false },
      { _id: 'ds_003', source: 'NEMAR', title: 'Canonical Title 3', is_active: true },
      { _id: 'ds_004', source: 'EBRAINS', title: 'Canonical Title 4', is_active: true },
      { _id: 'ds_005', source: 'UKBiobank', title: 'Canonical Title 5', is_active: true },
      { _id: 'ds_006', source: 'DANDI', title: 'Canonical Title 6', is_active: true },
    ];
    Dataset.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue(canonicalDocs.filter((d) => d.is_active !== false)),
    });

    // Mock admin overrides
    const overrideDocs = [
      { datasetId: 'ds_003', title: 'Overridden Title 3', disease: 'Epilepsy' },
    ];
    AdminDatasetOverride.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(overrideDocs) });

    const res = await request(app).get('/api/v1/datasets/popular');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.items)).toBe(true);

    // Maximum 6 items returned (ds_002 is inactive so 5 active items returned)
    expect(res.body.data.items.length).toBeLessThanOrEqual(6);

    const items = res.body.data.items;

    // First item has featuredTitleOverride
    expect(items[0].datasetId).toBe('ds_001');
    expect(items[0].title).toBe('Custom Headline');

    // Third item has admin metadata override
    const item3 = items.find((x) => x.datasetId === 'ds_003');
    expect(item3).toBeDefined();
    expect(item3.title).toBe('Overridden Title 3');
    expect(item3.disease).toBe('Epilepsy');

    // Inactive ds_002 must be excluded
    const item2 = items.find((x) => x.datasetId === 'ds_002');
    expect(item2).toBeUndefined();

    // Verify ordering by displayOrder ASC
    for (let i = 0; i < items.length - 1; i++) {
      expect(items[i].displayOrder).toBeLessThanOrEqual(items[i + 1].displayOrder);
    }

    // Verify NO admin internal fields exposed
    items.forEach((item) => {
      expect(item.updatedBy).toBeUndefined();
      expect(item.publishedBy).toBeUndefined();
      expect(item.auditLog).toBeUndefined();
      expect(item.status).toBeUndefined();
    });
  });

  it('GET /api/v1/datasets/popular returns empty items array when 0 popular datasets are published', async () => {
    PopularDataset.find.mockReturnValue(makeChain([]));

    const res = await request(app).get('/api/v1/datasets/popular');

    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });

  it('GET /api/v1/datasets/popular safely skips missing canonical datasets without crashing', async () => {
    PopularDataset.find.mockReturnValue(makeChain([
      { datasetId: 'ds_missing', status: 'published', displayOrder: 1 },
    ]));
    Dataset.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
    AdminDatasetOverride.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });

    const res = await request(app).get('/api/v1/datasets/popular');

    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });
});
