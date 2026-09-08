/**
 * Phase 8 — Admin Analytics API layer tests
 */
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/config/db.config', () => jest.fn().mockResolvedValue());

const app = require('../src/app');

jest.mock('../src/modules/admin/admin.model', () => ({ findOne: jest.fn() }));
// Mock all models used by analytics
jest.mock('../src/modules/queryLog/queryLog.model', () => ({
  aggregate: jest.fn(),
  countDocuments: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  countDocuments: jest.fn(),
}));
jest.mock('../src/modules/dataset/dataset.model', () => ({
  aggregate: jest.fn(),
  countDocuments: jest.fn(),
}));
jest.mock('../src/modules/user/user.model', () => ({
  User: { countDocuments: jest.fn() },
  ROLES: [],
}));
jest.mock('../src/modules/user/savedDataset.model', () => ({ countDocuments: jest.fn() }));
jest.mock('../src/modules/user/collection.model', () => ({ countDocuments: jest.fn() }));
jest.mock('../src/modules/admin/repository.model', () => ({ find: jest.fn() }));
jest.mock('../src/modules/admin/auditLog.model', () => ({ find: jest.fn() }));
jest.mock('../src/modules/admin/agentLog.model', () => ({
  aggregate: jest.fn(),
  countDocuments: jest.fn(),
  find: jest.fn(),
}));
jest.mock('../src/modules/admin/tokenUsage.model', () => ({
  find: jest.fn(),
  countDocuments: jest.fn(),
  aggregate: jest.fn(),
}));
jest.mock('../src/modules/admin/externalApiLog.model', () => ({
  aggregate: jest.fn(),
  find: jest.fn(),
  countDocuments: jest.fn(),
}));
jest.mock('../src/utils/auditLog.util', () => ({ logAdminAction: jest.fn() }));
jest.mock('../../src/services/cost.service', () => ({}), {virtual:true});

let adminToken;
beforeAll(()=>{
  adminToken = jwt.sign({id:'507f1f77bcf86cd799439099', role:'admin'}, process.env.JWT_ACCESS_SECRET||'test_secret', {expiresIn:'1h'});
});
function userToken(){
  return jwt.sign({id:'507f1f77bcf86cd799439011', role:'user'}, process.env.JWT_ACCESS_SECRET||'test_secret', {expiresIn:'1h'});
}

describe('Phase 8 — Admin Observability', ()=>{
  beforeEach(()=> jest.clearAllMocks());

  describe('Authorization', ()=>{
    it('rejects non-admin', async ()=>{
      const res = await request(app).get('/api/v1/admin/searches').set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(403);
    });
    it('rejects no token', async ()=>{
      const res = await request(app).get('/api/v1/admin/searches');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /admin/searches', ()=>{
    it('returns paginated items with timings and provenance', async ()=>{
      const QueryLog = require('../src/modules/queryLog/queryLog.model');
      QueryLog.find.mockReturnValue({ sort: jest.fn().mockReturnValue({ skip: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([
        {requestId:'req1', rawQuery:'q', resultSource:'merged', resultCount:5, provenance:{mongodb_dataset:1, repository:1}, timings:{totalMs:1000, parseMs:100}, createdAt:new Date()}
      ]) }) }) }) });
      QueryLog.countDocuments.mockResolvedValue(1);
      const res = await request(app).get('/api/v1/admin/searches?limit=10&offset=0').set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.items[0].requestId).toBe('req1');
      expect(res.body.data.items[0].timings.totalMs).toBe(1000);
      expect(res.body.data.total).toBe(1);
    });
    it('filters by resultSource and date', async ()=>{
      const QueryLog = require('../src/modules/queryLog/queryLog.model');
      QueryLog.find.mockReturnValue({ sort: jest.fn().mockReturnValue({ skip: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }) }) });
      QueryLog.countDocuments.mockResolvedValue(0);
      const res = await request(app).get('/api/v1/admin/searches?resultSource=merged&from=2026-09-01&to=2026-09-30').set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(QueryLog.find).toHaveBeenCalledWith(expect.objectContaining({resultSource:'merged'}));
    });
    it('empty data returns empty items', async ()=>{
      const QueryLog = require('../src/modules/queryLog/queryLog.model');
      QueryLog.find.mockReturnValue({ sort: jest.fn().mockReturnValue({ skip: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }) }) });
      QueryLog.countDocuments.mockResolvedValue(0);
      const res = await request(app).get('/api/v1/admin/searches').set('Authorization', `Bearer ${adminToken}`);
      expect(res.body.data.items.length).toBe(0);
    });
  });

  describe('GET /admin/searches/:requestId', ()=>{
    it('correlates QueryLog+AgentLog+TokenUsage+ExternalApiLog+cost', async ()=>{
      const QueryLog = require('../src/modules/queryLog/queryLog.model');
      const AgentLog = require('../src/modules/admin/agentLog.model');
      const TokenUsage = require('../src/modules/admin/tokenUsage.model');
      const ExternalApiLog = require('../src/modules/admin/externalApiLog.model');
      QueryLog.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({requestId:'req1', rawQuery:'q', timings:{totalMs:100}} ) });
      AgentLog.find.mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{agent:'parse_query', requestId:'req1'}]) }) });
      TokenUsage.find.mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{provider:'groq', model:'openai/gpt-oss-120b', usageType:'actual', requestId:'req1', inputTokens:100, outputTokens:50}]) }) });
      ExternalApiLog.find.mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{service:'openneuro', requestId:'req1'}]) }) });
      const res = await request(app).get('/api/v1/admin/searches/req1').set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.requestId).toBe('req1');
      expect(res.body.data.agentLogs[0].requestId).toBe('req1');
      expect(res.body.data.tokenUsages[0].requestId).toBe('req1');
      expect(res.body.data.externalLogs[0].requestId).toBe('req1');
      expect(res.body.data.cost).toBeDefined();
      expect(res.body.data.tokenUsages[0].cost).toBeDefined(); // actual vs estimated cost
    });
    it('404 when not found', async ()=>{
      const QueryLog = require('../src/modules/queryLog/queryLog.model');
      const AgentLog = require('../src/modules/admin/agentLog.model');
      const TokenUsage = require('../src/modules/admin/tokenUsage.model');
      const ExternalApiLog = require('../src/modules/admin/externalApiLog.model');
      QueryLog.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
      AgentLog.find.mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) });
      TokenUsage.find.mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) });
      ExternalApiLog.find.mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) });
      const res = await request(app).get('/api/v1/admin/searches/notfound').set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /admin/external-logs', ()=>{
    it('returns paginated external logs with summary', async ()=>{
      const ExternalApiLog = require('../src/modules/admin/externalApiLog.model');
      ExternalApiLog.find.mockReturnValue({ sort: jest.fn().mockReturnValue({ skip: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{service:'openneuro', durationMs:100}]) }) }) }) });
      ExternalApiLog.countDocuments.mockResolvedValue(1);
      ExternalApiLog.aggregate.mockResolvedValue([{count:1, avgMs:100, maxMs:100, minMs:100, errors:0}]);
      const res = await request(app).get('/api/v1/admin/external-logs?service=openneuro&limit=10').set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.items[0].service).toBe('openneuro');
      expect(res.body.data.summary.count).toBe(1);
    });
  });

  describe('GET /admin/tokens filtering (actual vs estimated, requestId)', ()=>{
    it('filters by usageType and requestId', async ()=>{
      const TokenUsage = require('../src/modules/admin/tokenUsage.model');
      TokenUsage.find.mockReturnValue({ sort: jest.fn().mockReturnValue({ skip: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{provider:'groq', usageType:'actual', requestId:'req1'}]) }) }) }) });
      TokenUsage.countDocuments.mockResolvedValue(1);
      const res = await request(app).get('/api/v1/admin/tokens?usageType=actual&requestId=req1').set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.items[0].usageType).toBe('actual');
    });
    it('backward compat: no params returns array', async ()=>{
      const TokenUsage = require('../src/modules/admin/tokenUsage.model');
      TokenUsage.find.mockReturnValue({ sort: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{provider:'groq'}]) }) }) });
      const res = await request(app).get('/api/v1/admin/tokens').set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  describe('GET /admin/agents filtering', ()=>{
    it('filters by agent and requestId', async ()=>{
      const AgentLog = require('../src/modules/admin/agentLog.model');
      AgentLog.find.mockReturnValue({ sort: jest.fn().mockReturnValue({ skip: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{agent:'parse_query', requestId:'req1'}]) }) }) }) });
      AgentLog.countDocuments.mockResolvedValue(1);
      const res = await request(app).get('/api/v1/admin/agents?agent=parse_query&requestId=req1').set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.items[0].agent).toBe('parse_query');
    });
  });

  describe('GET /admin/analytics additive fields', ()=>{
    it('includes queryLogTimings, provenanceSummary, costOverview', async ()=>{
      const QueryLog = require('../src/modules/queryLog/queryLog.model');
      const Dataset = require('../src/modules/dataset/dataset.model');
      const User = require('../src/modules/user/user.model');
      const Saved = require('../src/modules/user/savedDataset.model');
      const Coll = require('../src/modules/user/collection.model');
      const Repo = require('../src/modules/admin/repository.model');
      const AgentLog = require('../src/modules/admin/agentLog.model');
      // minimal mocks for analytics Promise.all
      QueryLog.aggregate.mockImplementation((pipeline)=>{
        const str = JSON.stringify(pipeline);
        if(str.includes('series') || str.includes('$dateToString')) return Promise.resolve([]);
        if(str.includes('provenance')) return Promise.resolve([]);
        if(str.includes('timings')) return Promise.resolve([]);
        return Promise.resolve([]);
      });
      // Actually QueryLog.aggregate is called multiple times; mock to return appropriate shapes
      QueryLog.aggregate.mockResolvedValue([]);
      QueryLog.countDocuments.mockResolvedValue(0);
      Dataset.aggregate.mockResolvedValue([]);
      User.User.countDocuments = jest.fn().mockResolvedValue(0);
      // Need to handle User import: admin.controller uses User.countDocuments directly
      const UserMod = require('../src/modules/user/user.model');
      UserMod.User.countDocuments = jest.fn().mockResolvedValue(0);
      Saved.countDocuments = jest.fn().mockResolvedValue(0);
      Coll.countDocuments = jest.fn().mockResolvedValue(0);
      Repo.find.mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) });
      AgentLog.aggregate.mockResolvedValue([]);
      AgentLog.countDocuments.mockResolvedValue(0);
      // Mock QueryLog timings agg to return sample
      // First call series, second repoCounts etc — we need to allow multiple aggregate calls
      // Simplify: make aggregate return [] for all, analytics will still produce fields (null/empty)
      const res = await request(app).get('/api/v1/admin/analytics').set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      // Additive fields exist (may be null when no data)
      expect(res.body.data).toHaveProperty('queryLogTimings');
      expect(res.body.data).toHaveProperty('provenanceSummary');
      expect(res.body.data).toHaveProperty('costOverview');
      // Existing fields preserved
      expect(res.body.data).toHaveProperty('series');
      expect(res.body.data).toHaveProperty('searchPerformance');
    });
  });
});
