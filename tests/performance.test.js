/**
 * Phase 7 — Search & Performance Observability tests A-J
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/config/db.config', () => jest.fn().mockResolvedValue());

const app = require('../src/app');

jest.mock('../src/modules/agent/agent.client', () => ({
  parseQuery: jest.fn().mockResolvedValue({raw_query:'default', in_domain:true}),
  runRepositorySearch: jest.fn().mockResolvedValue({datasets:[]}),
  runFallbackSearch: jest.fn().mockResolvedValue({datasets_found:0}),
}));
jest.mock('../src/modules/dataset/candidateGenerator', () => ({
  generateCandidates: jest.fn().mockResolvedValue({candidates:[], levelsUsed:[], droppedWeak:0, coverageDistribution:{}}),
  extractHardConstraints: jest.fn(() => ({})),
}));
jest.mock('../src/modules/dataset/catalogSearch.service', () => ({
  catalogSearch: jest.fn().mockResolvedValue([]),
}));
jest.mock('../src/modules/dataset/dataset.service', () => ({
  searchMongoDB: jest.fn().mockResolvedValue([]),
}));
jest.mock('../src/modules/dataset/queryComplexityAnalyzer', () => ({
  analyzeQueryComplexity: jest.fn(() => ({ level: 'high', freshness: 'recent' })),
}));
jest.mock('../src/modules/dataset/discoveryPolicy', () => ({
  computeRetrievalQuality: jest.fn(() => ({ avgMetadataCompleteness: 0.5 })),
  evaluate: jest.fn(() => ({ shouldDiscover: true, reason: 'test', signals: [] })),
  evaluateAfterRepositories: jest.fn(() => ({ shouldDiscoverWeb: true, reason: 'test', signals: [] })),
}));
jest.mock('../src/modules/dataset/rankingEngine', () => ({
  rank: jest.fn((a,b,c,d) => [...a, ...b, ...c, ...d].map(x=> ({...x, _provenance: x._provenance||'mongodb_dataset'}))),
}));
jest.mock('../src/modules/queryLog/queryLog.model', () => ({
  create: jest.fn().mockResolvedValue({}),
  findOne: jest.fn(),
}));
jest.mock('../src/modules/user/searchHistory.model', () => ({
  create: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/modules/user/user.model', () => ({
  User: {
    findById: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ email:'test@example.com', isOnboarded:true }) }) }),
  },
  ROLES: ['academic_researcher'],
}));
jest.mock('../src/modules/admin/tokenUsage.model', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/modules/admin/agentLog.model', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/modules/admin/externalApiLog.model', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/modules/dataset/dataset.model', () => ({ find: jest.fn() }));

const QueryLog = require('../src/modules/queryLog/queryLog.model');
const { parseQuery, runRepositorySearch, runFallbackSearch } = require('../src/modules/agent/agent.client');
const { generateCandidates } = require('../src/modules/dataset/candidateGenerator');
const { catalogSearch } = require('../src/modules/dataset/catalogSearch.service');
const { rank } = require('../src/modules/dataset/rankingEngine');
const disc = require('../src/modules/dataset/discoveryPolicy');

function makeToken(userId='507f1f77bcf86cd799439011'){
  return jwt.sign({id:userId, role:'user'}, process.env.JWT_ACCESS_SECRET||'test_secret', {expiresIn:'15m'});
}
const delay = (ms) => new Promise(r=>setTimeout(r, ms));

describe('Phase 7 — Observability', () => {
  beforeEach(()=> {
    jest.clearAllMocks();
    // reset defaults
    parseQuery.mockResolvedValue({raw_query:'default', in_domain:true});
    generateCandidates.mockResolvedValue({candidates:[], levelsUsed:[], droppedWeak:0, coverageDistribution:{}});
    catalogSearch.mockResolvedValue([]);
    runRepositorySearch.mockResolvedValue({datasets:[]});
    runFallbackSearch.mockResolvedValue({datasets_found:0});
    rank.mockImplementation((a,b,c,d) => [...a, ...b, ...c, ...d].map(x=> ({...x, _provenance: x._provenance||'mongodb_dataset'})));
    disc.evaluate.mockReturnValue({ shouldDiscover: true, reason: 'test', signals: [] });
    disc.evaluateAfterRepositories.mockReturnValue({ shouldDiscoverWeb: true, reason: 'test', signals: [] });
    QueryLog.create.mockResolvedValue({});
  });

  test('A — request correlation: QueryLog.timings uses same requestId', async () => {
    parseQuery.mockImplementation(async ()=> { await delay(10); return {raw_query:'test', modality:['fMRI'], in_domain:true}; });
    generateCandidates.mockImplementation(async()=>{ await delay(15); return {candidates:[{_id:'1', source:'openneuro', source_id:'1'}], levelsUsed:['L1'], droppedWeak:0, coverageDistribution:{}}; });
    catalogSearch.mockImplementation(async()=>{ await delay(10); return []; });
    runRepositorySearch.mockImplementation(async()=>{ await delay(20); return {datasets:[], sources_queried:['openneuro']}; });
    runFallbackSearch.mockImplementation(async()=>{ await delay(25); return {datasets_found:0, published:true}; });

    const res = await request(app).post('/api/v1/datasets/search')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({query:'hippocampus fMRI'});
    expect(res.status).toBe(200);
    const qlogCall = QueryLog.create.mock.calls[0][0];
    expect(qlogCall.requestId).toBeTruthy();
    expect(qlogCall.timings).toBeDefined();
    expect(typeof qlogCall.timings.totalMs).toBe('number');
    expect(res.headers['x-request-id']).toBe(qlogCall.requestId);
  });

  test('B — total duration captured correctly', async () => {
    parseQuery.mockImplementation(async()=> { await delay(10); return {raw_query:'test', in_domain:true}; });
    const res = await request(app).post('/api/v1/datasets/search')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({query:'test total'});
    const timings = QueryLog.create.mock.calls[0][0].timings;
    expect(timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(timings.totalMs).toBeLessThan(5000);
  });

  test('C — stage durations measured', async () => {
    parseQuery.mockImplementation(async()=>{ await delay(12); return {raw_query:'q', in_domain:true}; });
    generateCandidates.mockImplementation(async()=>{ await delay(18); return {candidates:[{_id:'1', source:'x', source_id:'1'}], levelsUsed:[], droppedWeak:0, coverageDistribution:{}}; });
    catalogSearch.mockImplementation(async()=>{ await delay(14); return [{source:'c', source_id:'1'}]; });
    runRepositorySearch.mockImplementation(async()=>{ await delay(22); return {datasets:[{source:'r', source_id:'1'}]}; });
    runFallbackSearch.mockImplementation(async()=>{ await delay(30); return {datasets_found:1}; });
    rank.mockImplementation((a,b,c,d)=>{ const s=Date.now(); while(Date.now()-s<10){}; return [...a,...b,...c,...d]; });

    await request(app).post('/api/v1/datasets/search').set('Authorization', `Bearer ${makeToken()}`).send({query:'stage test'});
    const t = QueryLog.create.mock.calls[0][0].timings;
    expect(t.parseMs).toBeGreaterThanOrEqual(10);
    expect(t.datasetMs).toBeGreaterThanOrEqual(15);
    expect(t.catalogMs).toBeGreaterThanOrEqual(10);
    expect(t.repositoryMs).toBeGreaterThanOrEqual(18);
    expect(t.discoveryMs).toBeGreaterThanOrEqual(25);
    expect(t.rankingMs).toBeGreaterThanOrEqual(0);
  });

  test('D — parallel repo wall-clock not sum', async () => {
    runRepositorySearch.mockImplementation(async()=>{ await delay(30); return {datasets:[]}; });
    disc.evaluateAfterRepositories.mockReturnValueOnce({shouldDiscoverWeb:false});
    await request(app).post('/api/v1/datasets/search').set('Authorization', `Bearer ${makeToken()}`).send({query:'parallel'});
    const t = QueryLog.create.mock.calls[0][0].timings;
    expect(t.repositoryMs).toBeLessThan(100);
    expect(t.repositoryMs).toBeGreaterThanOrEqual(20);
  });

  test('E — cache hit does not fabricate skipped stages', async () => {
    disc.evaluate.mockReturnValueOnce({shouldDiscover:false, reason:'high_quality', signals:[]});
    await request(app).post('/api/v1/datasets/search').set('Authorization', `Bearer ${makeToken()}`).send({query:'cache-hit'});
    const t = QueryLog.create.mock.calls[0][0].timings;
    expect(t.parseMs).toBeDefined();
    expect(t.repositoryMs).toBeNull();
    expect(t.discoveryMs).toBeNull();
  });

  test('F — error stage still retains duration', async () => {
    generateCandidates.mockRejectedValue(new Error('mongo down'));
    runRepositorySearch.mockImplementation(async()=>{ await delay(15); throw new Error('repo timeout'); });
    runFallbackSearch.mockImplementation(async()=>{ await delay(20); throw new Error('tavily down'); });
    const res = await request(app).post('/api/v1/datasets/search').set('Authorization', `Bearer ${makeToken()}`).send({query:'error stage'});
    expect(res.status).toBe(200);
    const t = QueryLog.create.mock.calls[0][0].timings;
    expect(t.datasetMs).toBeGreaterThanOrEqual(0);
    expect(t.repositoryMs).toBeGreaterThanOrEqual(10);
    expect(t.discoveryMs).toBeGreaterThanOrEqual(10);
  });

  test('G — multiple stages distinguishable', async () => {
    await request(app).post('/api/v1/datasets/search').set('Authorization', `Bearer ${makeToken()}`).send({query:'G'});
    const t = QueryLog.create.mock.calls[0][0].timings;
    expect(Object.keys(t).sort()).toEqual(['catalogMs','datasetMs','discoveryMs','parseMs','rankingMs','repositoryMs','totalMs'].sort());
  });

  test('H — telemetry failure does not fail search', async () => {
    generateCandidates.mockResolvedValue({candidates:[{source:'a', source_id:'1'}], levelsUsed:[], droppedWeak:0, coverageDistribution:{}});
    rank.mockReturnValue([{source:'a', source_id:'1'}]);
    QueryLog.create.mockRejectedValueOnce(new Error('mongo write fail'));
    const res = await request(app).post('/api/v1/datasets/search').set('Authorization', `Bearer ${makeToken()}`).send({query:'telemetry fail'});
    expect(res.status).toBe(200);
    expect(res.body.data.results.length).toBe(1);
  });

  test('I — existing behavior unchanged', async () => {
    parseQuery.mockResolvedValue({raw_query:'hippocampus fMRI', modality:['fMRI'], in_domain:true});
    generateCandidates.mockResolvedValue({candidates:[{_id:'id1', source:'openneuro', source_id:'1', title:'A'}, {_id:'id2', source:'dandi', source_id:'2', title:'B'}], levelsUsed:[], droppedWeak:0, coverageDistribution:{}});
    disc.evaluate.mockReturnValueOnce({shouldDiscover:false, reason:'test', signals:[]});
    const res = await request(app).post('/api/v1/datasets/search').set('Authorization', `Bearer ${makeToken()}`).send({query:'hippocampus fMRI'});
    expect(res.body.data.results.map(r=>r.source_id)).toEqual(['1','2']);
    expect(res.body.data.filters).toBeDefined();
  });

});
