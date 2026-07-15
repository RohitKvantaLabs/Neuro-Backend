const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const { parseQuery } = require('../src/modules/agent/agent.client');
const { searchDatasets } = require('../src/modules/dataset/dataset.service');
const QueryLog = require('../src/modules/queryLog/queryLog.model');

jest.mock('../src/modules/agent/agent.client', () => ({
  parseQuery: jest.fn(),
  triggerFallbackSearch: jest.fn(),
}));

jest.mock('../src/modules/dataset/dataset.service', () => ({
  searchDatasets: jest.fn(),
}));

jest.mock('../src/modules/queryLog/queryLog.model', () => ({
  create: jest.fn(),
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
  ROLES: ['student', 'researcher', 'scientist', 'working_professional'],
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
});
