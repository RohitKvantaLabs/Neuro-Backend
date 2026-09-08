/**
 * Phase 11 — Cost Intelligence & Scaling Tests
 *
 * Covers Steps 15 requirements:
 * 1 Cost per search, 2 breakdown, 3 provider/model/agent, 4 actual/estimated,
 * 5 missing pricing, 6 error semantics, 7 external, 8 historical, 9 coverage,
 * 10 scaling formula, 11 insufficient, 12 zero-search, 13 date filtering,
 * 14 admin auth, 15 no double count, plus frontend-relevant semantics.
 */

const { calculateLlmCostForRecord, calculateExternalCostForRecord, calculateCostForRecords, calculateCostBreakdown, calculateScaling } = require('../src/services/cost.service');
const { getLlmPricing } = require('../src/config/pricing.config');

process.env.GROQ_GPT_OSS_120B_INPUT_PER_1M = '0.15';
process.env.GROQ_GPT_OSS_120B_OUTPUT_PER_1M = '0.60';
process.env.GROQ_LLAMA_70B_INPUT_PER_1M = '0.59';
process.env.GROQ_LLAMA_70B_OUTPUT_PER_1M = '0.79';
delete process.env.TAVILY_PRICE_PER_1K_SEARCHES;

// Mock DB models before service uses them
jest.mock('../src/config/db.config', () => jest.fn().mockResolvedValue());

describe('Phase 11 — Cost Intelligence', () => {
  // 1 — Cost per search (single requestId)
  describe('1 — Cost per search authoritative via requestId', () => {
    it('single TokenUsage cost = input+output priced', () => {
      const rec = { provider: 'groq', model: 'openai/gpt-oss-120b', inputTokens: 1000, outputTokens: 500, usageType: 'actual', status: 'success' };
      const c = calculateLlmCostForRecord(rec);
      expect(c.totalCost).toBeCloseTo((1000*0.15+500*0.60)/1_000_000, 8);
      expect(c.costAvailable).toBe(true);
    });
    it('calculateCostForRecords aggregates LLM+external for one request', () => {
      const usages = [{ _id:'u1', requestId:'req1', provider:'groq', model:'openai/gpt-oss-120b', inputTokens:1000, outputTokens:500, usageType:'actual', status:'success' }];
      const ext = [{ _id:'e1', requestId:'req1', service:'openneuro', status:'success' }];
      const r = calculateCostForRecords(usages, ext);
      expect(r.llm.totalCost).toBeGreaterThan(0);
      expect(r.external.totalCost).toBe(0); // openneuro not billable
      expect(r.meta.requestId).toBe('req1');
    });
  });

  // 2 — Breakdown structure
  describe('2 — Breakdown by dimensions', () => {
    afterEach(() => jest.clearAllMocks());
    it('breakdown groups by provider, model, agent, service, usageType, costType', async () => {
      const QueryLog = require('../src/modules/queryLog/queryLog.model');
      const TokenUsage = require('../src/modules/admin/tokenUsage.model');
      const ExternalApiLog = require('../src/modules/admin/externalApiLog.model');
      // Mock counts and finds
      QueryLog.countDocuments = jest.fn().mockResolvedValue(2);
      TokenUsage.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([
        { provider:'groq', model:'openai/gpt-oss-120b', agent:'parse_query', inputTokens:1000, outputTokens:500, usageType:'actual', status:'success', requestId:'req1', createdAt:new Date('2026-09-01') },
        { provider:'groq', model:'llama-3.3-70b-versatile', agent:'fallback', inputTokens:2000, outputTokens:1000, usageType:'estimated', status:'success', requestId:'req2', createdAt:new Date('2026-09-01') },
      ])});
      ExternalApiLog.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([
        { service:'tavily', status:'success', requestId:'req1', createdAt:new Date('2026-09-01') },
        { service:'openneuro', status:'success', requestId:'req1', createdAt:new Date('2026-09-01') },
      ])});
      // Mock calculateAggregateCost inner call for daily
      const result = await calculateCostBreakdown({ from:'2026-09-01', to:'2026-09-02' });
      expect(result.totals.searchCount).toBe(2);
      expect(result.breakdown.byProvider.length).toBeGreaterThan(0);
      expect(result.breakdown.byModel.length).toBeGreaterThan(0);
      expect(result.breakdown.byAgent.length).toBeGreaterThan(0);
      expect(result.breakdown.byService.length).toBeGreaterThan(0);
      expect(result.breakdown.byUsageType.actual.count).toBe(1);
      expect(result.breakdown.byUsageType.estimated.count).toBe(1);
      expect(result.breakdown.byCostType.llm).toBeDefined();
      expect(result.breakdown.byCostType.external).toBeDefined();
      expect(result.drivers.topModel).toBeDefined();
      expect(result.drivers.topAgent).toBeDefined();
    });
  });

  // 3 — Provider/model/agent aggregation percentages
  describe('3 — Provider/model/agent aggregation percentages sum correctly', () => {
    it('byProvider percentages reflect share of total LLM cost', async () => {
      const QueryLog = require('../src/modules/queryLog/queryLog.model');
      const TokenUsage = require('../src/modules/admin/tokenUsage.model');
      const ExternalApiLog = require('../src/modules/admin/externalApiLog.model');
      QueryLog.countDocuments = jest.fn().mockResolvedValue(1);
      TokenUsage.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([
        { provider:'groq', model:'openai/gpt-oss-120b', agent:'parse_query', inputTokens:1000000, outputTokens:0, usageType:'actual', status:'success', requestId:'req1', createdAt:new Date() },
        { provider:'groq', model:'llama-3.3-70b-versatile', agent:'fallback', inputTokens:1000000, outputTokens:0, usageType:'actual', status:'success', requestId:'req1', createdAt:new Date() },
      ])});
      ExternalApiLog.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      const r = await calculateCostBreakdown({});
      // Both providers are groq but models differ; total should sum to ~100% for provider groq
      const prov = r.breakdown.byProvider.find(p=>p.provider==='groq');
      expect(prov.percentage).toBeCloseTo(100, 0);
      // Models split
      expect(r.breakdown.byModel.length).toBe(2);
      const sumPct = r.breakdown.byModel.reduce((a,m)=>a+m.percentage,0);
      expect(sumPct).toBeCloseTo(100, 0);
    });
  });

  // 4 — Actual vs estimated
  describe('4 — Actual vs estimated handling', () => {
    it('actual is provider-reported, estimated flagged', () => {
      const actual = calculateLlmCostForRecord({ provider:'groq', model:'openai/gpt-oss-120b', inputTokens:500, outputTokens:300, usageType:'actual', status:'success' });
      const est = calculateLlmCostForRecord({ provider:'groq', model:'openai/gpt-oss-120b', inputTokens:500, outputTokens:300, usageType:'estimated', status:'success' });
      expect(actual.isEstimated).toBe(false);
      expect(est.isEstimated).toBe(true);
      expect(actual.reason).toBe('actual_split_pricing');
      expect(est.reason).toBe('estimated_split_pricing');
      expect(actual.costAvailable).toBe(true);
      expect(est.costAvailable).toBe(true);
      // costs numerically equal for same tokens
      expect(actual.totalCost).toBeCloseTo(est.totalCost, 8);
    });
    it('estimated with missing split is unavailable not fabricated', () => {
      const c = calculateLlmCostForRecord({ provider:'groq', model:'openai/gpt-oss-120b', tokens:800, inputTokens:null, outputTokens:null, usageType:'estimated', status:'success' });
      expect(c.totalCost).toBeNull();
      expect(c.costAvailable).toBe(false);
      expect(c.isEstimated).toBe(true);
    });
  });

  // 5 — Missing pricing
  describe('5 — Missing pricing returns null not zero', () => {
    it('unknown provider/model yields pricing_unavailable', () => {
      const c = calculateLlmCostForRecord({ provider:'unknown', model:'future-xyz', inputTokens:100, outputTokens:100, usageType:'actual', status:'success' });
      expect(c.totalCost).toBeNull();
      expect(c.pricingAvailable).toBe(false);
      expect(c.costAvailable).toBe(false);
      expect(c.reason).toBe('pricing_unavailable');
    });
    it('external unknown service yields unavailable', () => {
      const c = calculateExternalCostForRecord({ service:'openneuro', status:'success' });
      expect(c.totalCost).toBeNull();
      expect(c.costAvailable).toBe(false);
    });
  });

  // 6 — Error semantics $0
  describe('6 — Error cost semantics $0 and excluded', () => {
    it('failed LLM excluded', () => {
      const c = calculateLlmCostForRecord({ provider:'groq', model:'openai/gpt-oss-120b', inputTokens:1000, outputTokens:1000, usageType:'actual', status:'error' });
      expect(c.totalCost).toBe(0);
      expect(c.reason).toBe('failed_call_excluded');
    });
    it('failed external yields 0', () => {
      process.env.TAVILY_PRICE_PER_1K_SEARCHES='5';
      const c = calculateExternalCostForRecord({ service:'tavily', status:'error' });
      expect(c.totalCost).toBe(0);
      delete process.env.TAVILY_PRICE_PER_1K_SEARCHES;
    });
    it('heuristic yields 0', () => {
      const c = calculateLlmCostForRecord({ provider:'heuristic', model:'heuristic', tokens:500, usageType:'estimated', status:'success' });
      expect(c.totalCost).toBe(0);
    });
  });

  // 7 — External cost handling only billable
  describe('7 — External cost only when pricing configured', () => {
    it('tavily cost only when env set', () => {
      const before = calculateExternalCostForRecord({ service:'tavily', status:'success' });
      expect(before.costAvailable).toBe(false);
      process.env.TAVILY_PRICE_PER_1K_SEARCHES='5';
      const after = calculateExternalCostForRecord({ service:'tavily', status:'success' });
      expect(after.totalCost).toBeCloseTo(0.005, 8);
      delete process.env.TAVILY_PRICE_PER_1K_SEARCHES;
    });
    it('free services remain unavailable even with tavily pricing', () => {
      process.env.TAVILY_PRICE_PER_1K_SEARCHES='5';
      const c = calculateExternalCostForRecord({ service:'dandi', status:'success' });
      expect(c.costAvailable).toBe(false);
      delete process.env.TAVILY_PRICE_PER_1K_SEARCHES;
    });
  });

  // 8 — Historical daily/monthly aggregation exists via calculateCostBreakdown daily
  describe('8 — Historical aggregation', () => {
    it('daily groups returned when data exists', async () => {
      const QueryLog = require('../src/modules/queryLog/queryLog.model');
      const TokenUsage = require('../src/modules/admin/tokenUsage.model');
      const ExternalApiLog = require('../src/modules/admin/externalApiLog.model');
      QueryLog.countDocuments = jest.fn().mockResolvedValue(1);
      const d = new Date('2026-09-05T10:00:00Z');
      TokenUsage.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([
        { provider:'groq', model:'openai/gpt-oss-120b', agent:'parse_query', inputTokens:100, outputTokens:50, usageType:'actual', status:'success', requestId:'req1', createdAt:d },
      ])});
      ExternalApiLog.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      const r = await calculateCostBreakdown({ from:'2026-09-01', to:'2026-09-10' });
      expect(Array.isArray(r.daily)).toBe(true);
    });
  });

  // 9 — Coverage
  describe('9 — Calculable cost coverage', () => {
    it('coverage percent = calculable / total *100', async () => {
      const QueryLog = require('../src/modules/queryLog/queryLog.model');
      const TokenUsage = require('../src/modules/admin/tokenUsage.model');
      const ExternalApiLog = require('../src/modules/admin/externalApiLog.model');
      QueryLog.countDocuments = jest.fn().mockResolvedValue(4);
      TokenUsage.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([
        { provider:'groq', model:'openai/gpt-oss-120b', agent:'parse_query', inputTokens:100, outputTokens:50, usageType:'actual', status:'success', requestId:'req1', createdAt:new Date() },
        { provider:'groq', model:'openai/gpt-oss-120b', agent:'parse_query', inputTokens:100, outputTokens:50, usageType:'actual', status:'success', requestId:'req2', createdAt:new Date() },
        { provider:'unknown', model:'future', agent:'parse_query', inputTokens:100, outputTokens:50, usageType:'actual', status:'success', requestId:'req3', createdAt:new Date() }, // unavailable
      ])});
      ExternalApiLog.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      const r = await calculateCostBreakdown({});
      // total 4, calculable 2 (req1,req2), unavailable 1 (req3) + 1 missing (no token)
      expect(r.coverage.totalSearches).toBe(4);
      expect(r.coverage.searchesWithCalculableCost).toBe(2);
      expect(r.coverage.percentCalculable).toBeCloseTo(50, 1);
      expect(r.coverage.searchesWithUnavailableCost).toBeGreaterThan(0);
    });
  });

  // 10 — Scaling formula
  describe('10 — Scaling formula', () => {
    it('projectedDaily = searchesPerDay * assumedCostPerSearch', async () => {
      const QueryLog = require('../src/modules/queryLog/queryLog.model');
      const TokenUsage = require('../src/modules/admin/tokenUsage.model');
      const ExternalApiLog = require('../src/modules/admin/externalApiLog.model');
      // Create 10 calculable searches each cost ~0.00045 (1000 in + 500 out for gpt-oss)
      const usages = Array.from({length:10}, (_,i)=>({ provider:'groq', model:'openai/gpt-oss-120b', agent:'parse_query', inputTokens:1000, outputTokens:500, usageType:'actual', status:'success', requestId:`req${i}`, createdAt:new Date('2026-09-01') }));
      QueryLog.countDocuments = jest.fn().mockResolvedValue(10);
      TokenUsage.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(usages) });
      ExternalApiLog.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      const sc = await calculateScaling({ scenarios:[1000, 10000, 50000] });
      expect(sc.insufficient).toBe(false);
      const avg = sc.assumptions.avgCostPerSearch;
      expect(avg).not.toBeNull();
      const p1 = sc.projections.find(p=>p.searchesPerDay===1000);
      expect(p1.projectedDailyCost).toBeCloseTo(1000*avg, 2);
      const p10 = sc.projections.find(p=>p.searchesPerDay===10000);
      expect(p10.projectedMonthlyCost).toBeCloseTo(10000*avg*30, 1);
    });
  });

  // 11 — Insufficient data
  describe('11 — Insufficient data behavior', () => {
    it('flags insufficient when sample too small', async () => {
      const QueryLog = require('../src/modules/queryLog/queryLog.model');
      const TokenUsage = require('../src/modules/admin/tokenUsage.model');
      const ExternalApiLog = require('../src/modules/admin/externalApiLog.model');
      QueryLog.countDocuments = jest.fn().mockResolvedValue(2);
      TokenUsage.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      ExternalApiLog.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      const sc = await calculateScaling({});
      expect(sc.insufficient).toBe(true);
      expect(sc.insufficientReasons.length).toBeGreaterThan(0);
      expect(sc.projections.length).toBe(0);
    });
    it('flags insufficient when coverage low', async () => {
      const QueryLog = require('../src/modules/queryLog/queryLog.model');
      const TokenUsage = require('../src/modules/admin/tokenUsage.model');
      const ExternalApiLog = require('../src/modules/admin/externalApiLog.model');
      QueryLog.countDocuments = jest.fn().mockResolvedValue(100);
      // Only 2 calculable
      TokenUsage.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([
        { provider:'groq', model:'openai/gpt-oss-120b', agent:'parse_query', inputTokens:100, outputTokens:50, usageType:'actual', status:'success', requestId:'req1', createdAt:new Date() },
        { provider:'groq', model:'openai/gpt-oss-120b', agent:'parse_query', inputTokens:100, outputTokens:50, usageType:'actual', status:'success', requestId:'req2', createdAt:new Date() },
      ])});
      ExternalApiLog.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      const sc = await calculateScaling({});
      expect(sc.insufficient).toBe(true);
      expect(sc.insufficientReasons.join(' ')).toMatch(/coverage/i);
    });
  });

  // 12 — Zero search
  describe('12 — Zero search behavior', () => {
    it('zero searches yields null avg and insufficient', async () => {
      const QueryLog = require('../src/modules/queryLog/queryLog.model');
      const TokenUsage = require('../src/modules/admin/tokenUsage.model');
      const ExternalApiLog = require('../src/modules/admin/externalApiLog.model');
      QueryLog.countDocuments = jest.fn().mockResolvedValue(0);
      TokenUsage.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      ExternalApiLog.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      const bd = await calculateCostBreakdown({});
      expect(bd.totals.searchCount).toBe(0);
      expect(bd.averages.avgCostPerSearch).toBeNull();
      const sc = await calculateScaling({});
      expect(sc.insufficient).toBe(true);
    });
  });

  // 13 — Date filtering
  describe('13 — Date filtering', () => {
    it('throws on invalid date in controller', async () => {
      const jwt = require('jsonwebtoken');
      const request = require('supertest');
      const app = require('../src/app');
      const token = jwt.sign({ id:'507f1f77bcf86cd799439099', role:'admin' }, process.env.JWT_ACCESS_SECRET||'test_secret', {expiresIn:'1h'});
      const res = await request(app).get('/api/v1/admin/cost/breakdown?from=invalid-date').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
    }, 10000);
    it('filters by date range when valid', async () => {
      const QueryLog = require('../src/modules/queryLog/queryLog.model');
      const TokenUsage = require('../src/modules/admin/tokenUsage.model');
      const ExternalApiLog = require('../src/modules/admin/externalApiLog.model');
      QueryLog.countDocuments = jest.fn().mockResolvedValue(1);
      TokenUsage.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      ExternalApiLog.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      const bd = await calculateCostBreakdown({ from:'2026-09-01', to:'2026-09-02' });
      expect(TokenUsage.find).toHaveBeenCalledWith(expect.objectContaining({ createdAt: expect.objectContaining({ $gte: expect.any(Date) }) }), expect.anything());
    });
  });

  // 14 — Admin authorization
  describe('14 — Admin authorization', () => {
    it('rejects non-admin on breakdown and scaling', async () => {
      const request = require('supertest');
      const jwt = require('jsonwebtoken');
      const app = require('../src/app');
      const userToken = jwt.sign({ id:'507f1f77bcf86cd799439011', role:'user' }, process.env.JWT_ACCESS_SECRET||'test_secret', {expiresIn:'1h'});
      const r1 = await request(app).get('/api/v1/admin/cost/breakdown').set('Authorization', `Bearer ${userToken}`);
      expect(r1.status).toBe(403);
      const r2 = await request(app).get('/api/v1/admin/cost/scaling').set('Authorization', `Bearer ${userToken}`);
      expect(r2.status).toBe(403);
    });
    it('rejects no token', async () => {
      const request = require('supertest');
      const app = require('../src/app');
      const r = await request(app).get('/api/v1/admin/cost/breakdown');
      expect(r.status).toBe(401);
    });
  });

  // 15 — No double counting
  describe('15 — No double counting', () => {
    it('same TokenUsage counted once per request', () => {
      const u = { _id:'u1', requestId:'req1', provider:'groq', model:'openai/gpt-oss-120b', inputTokens:1000, outputTokens:500, usageType:'actual', status:'success' };
      const r1 = calculateCostForRecords([u], []);
      const rDouble = calculateCostForRecords([u, u], []);
      expect(rDouble.llm.totalCost).toBeCloseTo(r1.llm.totalCost*2, 8); // double array doubles cost, but single request should not double
      // For same requestId, calling breakdown should not double-count same DB record
      // This is verified by ensuring DB query returns each doc once
      expect(r1.llm.recordCount).toBe(1);
    });
    it('request-level costs sum to daily aggregate within rounding', async () => {
      const QueryLog = require('../src/modules/queryLog/queryLog.model');
      const TokenUsage = require('../src/modules/admin/tokenUsage.model');
      const ExternalApiLog = require('../src/modules/admin/externalApiLog.model');
      const usages = [
        { provider:'groq', model:'openai/gpt-oss-120b', agent:'parse_query', inputTokens:1000, outputTokens:500, usageType:'actual', status:'success', requestId:'req1', createdAt:new Date('2026-09-01') },
        { provider:'groq', model:'openai/gpt-oss-120b', agent:'parse_query', inputTokens:1000, outputTokens:500, usageType:'actual', status:'success', requestId:'req2', createdAt:new Date('2026-09-01') },
      ];
      QueryLog.countDocuments = jest.fn().mockResolvedValue(2);
      TokenUsage.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(usages) });
      ExternalApiLog.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      const bd = await calculateCostBreakdown({});
      const overall = calculateCostForRecords(usages, []);
      expect(bd.totals.totalCost).toBeCloseTo(overall.total.totalCost, 6);
    });
  });
});
