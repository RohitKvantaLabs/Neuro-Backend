const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/config/db.config', () => jest.fn().mockResolvedValue());

const app = require('../src/app');
const { parseQuery, runFallbackSearch } = require('../src/modules/agent/agent.client');
const { searchDatasets } = require('../src/modules/dataset/dataset.service');
const QueryLog = require('../src/modules/queryLog/queryLog.model');

jest.mock('../src/modules/agent/agent.client', () => ({
  parseQuery: jest.fn(),
  runFallbackSearch: jest.fn(),
}));

jest.mock('../src/modules/dataset/dataset.service', () => ({
  searchDatasets: jest.fn(),
}));

jest.mock('../src/modules/queryLog/queryLog.model', () => ({
  create: jest.fn(),
}));

jest.mock('../src/modules/user/searchHistory.model', () => ({
  create: jest.fn().mockResolvedValue({}),
}));

jest.mock('../src/modules/user/user.model', () => ({
  User: {
    findById: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: '507f1f77bcf86cd799439011',
          isOnboarded: true,
        }),
      }),
    }),
  },
  ROLES: ['academic_researcher', 'industry_researcher', 'healthcare_professional', 'data_ai_engineer', 'other'],
}));

describe('POST /api/v1/datasets/search', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('falls back to a plain-text search when the Python parser is unavailable', async () => {
    parseQuery.mockRejectedValue(new Error('agent down'));
    searchDatasets.mockResolvedValue([{ title: 'Example dataset' }]);
    QueryLog.create.mockResolvedValue({});

    const token = jwt.sign(
      { id: '507f1f77bcf86cd799439011', role: 'user' },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: '15m' }
    );

    const res = await request(app)
      .post('/api/v1/datasets/search')
      .set('Authorization', `Bearer ${token}`)
      .send({ query: 'brain MRI' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.source).toBe('cache');
    expect(searchDatasets).toHaveBeenCalledWith(expect.objectContaining({ raw_query: 'brain MRI' }));
  });

  it('returns verified fallback datasets directly to the frontend', async () => {
    const token = jwt.sign(
      { id: '507f1f77bcf86cd799439011', role: 'user' },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: '15m' }
    );
    const fallbackDataset = { title: 'Pediatric fMRI', source: 'openneuro', source_id: 'ds001' };

    parseQuery.mockResolvedValue({ raw_query: 'pediatric fMRI', modality: [], species: [], condition: [], task: null, format: [] });
    searchDatasets.mockResolvedValue([]);
    runFallbackSearch.mockResolvedValue({ datasets_found: 1, datasets: [fallbackDataset] });
    QueryLog.create.mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/datasets/search')
      .set('Authorization', `Bearer ${token}`)
      .send({ query: 'pediatric fMRI' });

    expect(res.status).toBe(200);
    expect(res.body.data.source).toBe('agent');
    expect(res.body.data.results).toEqual([fallbackDataset]);
    expect(runFallbackSearch).toHaveBeenCalledWith(expect.objectContaining({ query: 'pediatric fMRI' }));
  });
});
