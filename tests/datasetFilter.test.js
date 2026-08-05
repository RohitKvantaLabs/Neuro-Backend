jest.mock('../src/modules/dataset/dataset.model', () => ({ find: jest.fn() }));

const Dataset = require('../src/modules/dataset/dataset.model');
const { buildMongoQuery, filterDatasetsByMetadata, searchDatasets } = require('../src/modules/dataset/dataset.service');

const sortedQuery = (results) => ({
  sort: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(results) }) }),
});
const plainQuery = (results) => ({
  limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(results) }),
});

describe('dataset metadata filters', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses only exact metadata fields and keeps MRI distinct from fMRI', () => {
    const query = buildMongoQuery({
      raw_query: 'brain',
      modality: ['MRI'],
      species: ['Human'],
      disease: ["Alzheimer's"],
    });

    expect(query.$text).toEqual({ $search: 'brain' });
    expect(query.$and).toHaveLength(3);
    expect(query.$and[0].modality.$in[0].test('MRI')).toBe(true);
    expect(query.$and[0].modality.$in[0].test('fMRI')).toBe(false);
    expect(query.$and[1]).toHaveProperty('species');
    expect(query.$and[2]).toHaveProperty('disease');
    expect(JSON.stringify(query.$and)).not.toContain('description');
    expect(JSON.stringify(query.$and)).not.toContain('title');
  });

  it('does not run a text-only fallback when active filters found no result', async () => {
    Dataset.find
      .mockReturnValueOnce(sortedQuery([]))
      .mockReturnValueOnce(plainQuery([]));

    const results = await searchDatasets({ raw_query: 'brain', modality: ['MRI'] });

    expect(results).toEqual([]);
    expect(Dataset.find).toHaveBeenCalledTimes(2);
    expect(Dataset.find.mock.calls.every(([query]) => query.$and)).toBe(true);
  });

  it('supports filter-only and multi-filter AND queries', () => {
    const query = buildMongoQuery({ modality: ['MRI'], species: ['Human'], ageGroup: ['Adult'] });
    expect(query.$text).toBeUndefined();
    expect(query.$and).toHaveLength(3);
  });

  it('removes discovery results whose metadata does not satisfy active filters', () => {
    const results = filterDatasetsByMetadata([
      { title: 'MRI brain', modality: ['MRI'], species: ['Human'], disease: "Alzheimer's" },
      { title: 'fMRI brain', modality: ['fMRI'], species: ['Human'], disease: "Alzheimer's" },
    ], { modality: ['MRI'], species: ['Human'], disease: ["Alzheimer's"] });

    expect(results).toHaveLength(1);
    expect(results[0].modality).toEqual(['MRI']);
  });
});
