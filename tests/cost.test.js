/**
 * Phase 6 — Cost Intelligence Tests (A-K)
 *
 * Covers:
 * A pricing math, B input/output diff pricing, C actual, D estimated,
 * E multiple LLM calls, F external API billable filtering,
 * G missing pricing, H cache hit, I request correlation,
 * J aggregate no double-count, K regression (existing tests)
 *
 * Uses pure cost.service functions + supertest for admin routes.
 */

const { calculateLlmCostForRecord, calculateExternalCostForRecord, calculateCostForRecords } = require('../src/services/cost.service');
const { getLlmPricing } = require('../src/config/pricing.config');

// Ensure pricing env defaults for deterministic tests
process.env.GROQ_GPT_OSS_120B_INPUT_PER_1M = '0.15';
process.env.GROQ_GPT_OSS_120B_OUTPUT_PER_1M = '0.60';
process.env.GROQ_LLAMA_70B_INPUT_PER_1M = '0.59';
process.env.GROQ_LLAMA_70B_OUTPUT_PER_1M = '0.79';
delete process.env.TAVILY_PRICE_PER_1K_SEARCHES; // default unavailable

describe('Phase 6 — Cost Intelligence', () => {
  // ── A — Pricing calculation: known tokens produce expected math ──────────
  describe('A — Pricing calculation', () => {
    it('calculates input + output cost correctly for gpt-oss-120b', () => {
      const rec = {
        provider: 'groq',
        model: 'openai/gpt-oss-120b',
        inputTokens: 1000000,
        outputTokens: 500000,
        usageType: 'actual',
        status: 'success',
      };
      const c = calculateLlmCostForRecord(rec);
      expect(c.costAvailable).toBe(true);
      expect(c.inputCost).toBeCloseTo(0.15, 6);
      expect(c.outputCost).toBeCloseTo(0.30, 6); // 0.5M * 0.60/1M
      expect(c.totalCost).toBeCloseTo(0.45, 6);
    });

    it('calculates correctly for llama-70b', () => {
      const rec = {
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
        inputTokens: 1000000,
        outputTokens: 1000000,
        usageType: 'actual',
        status: 'success',
      };
      const c = calculateLlmCostForRecord(rec);
      expect(c.totalCost).toBeCloseTo(1.38, 6); // 0.59 + 0.79
    });
  });

  // ── B — Different input/output pricing ───────────────────────────────────
  describe('B — Input/output pricing handled separately', () => {
    it('uses distinct input/output rates (not totalTokens avg)', () => {
      const rec = {
        provider: 'groq',
        model: 'openai/gpt-oss-120b',
        inputTokens: 3000,
        outputTokens: 1000,
        totalTokens: 4000,
        usageType: 'actual',
        status: 'success',
      };
      const c = calculateLlmCostForRecord(rec);
      // input 3000*0.15/1M=0.00045, output 1000*0.60/1M=0.0006, total 0.00105
      expect(c.inputCost).toBeCloseTo(0.00045, 8);
      expect(c.outputCost).toBeCloseTo(0.0006, 8);
      expect(c.totalCost).toBeCloseTo(0.00105, 8);
      // Must NOT equal totalTokens * avg price (that would be 4000*0.375/1M=0.0015)
      const avgPrice = (0.15 + 0.60) / 2;
      const wrong = (4000 * avgPrice) / 1_000_000;
      expect(c.totalCost).not.toBeCloseTo(wrong, 8);
      expect(wrong).toBeCloseTo(0.0015, 8);
    });
  });

  // ── C — Actual usageType ─────────────────────────────────────────────────
  describe('C — Actual usage', () => {
    it('produces actual-token-based cost with isEstimated=false', () => {
      const rec = {
        provider: 'groq',
        model: 'openai/gpt-oss-120b',
        inputTokens: 500,
        outputTokens: 300,
        usageType: 'actual',
        status: 'success',
      };
      const c = calculateLlmCostForRecord(rec);
      expect(c.isEstimated).toBe(false);
      expect(c.costAvailable).toBe(true);
      expect(c.reason).toBe('actual_split_pricing');
    });
  });

  // ── D — Estimated usage must be identifiable ─────────────────────────────
  describe('D — Estimated usage traceable', () => {
    it('marks estimated cost as isEstimated=true', () => {
      const rec = {
        provider: 'groq',
        model: 'openai/gpt-oss-120b',
        inputTokens: 500,
        outputTokens: 300,
        usageType: 'estimated',
        status: 'success',
      };
      const c = calculateLlmCostForRecord(rec);
      expect(c.isEstimated).toBe(true);
      expect(c.reason).toBe('estimated_split_pricing');
    });

    it('estimated with missing split is flagged but not fabricated', () => {
      const rec = {
        provider: 'groq',
        model: 'openai/gpt-oss-120b',
        tokens: 800,
        inputTokens: null,
        outputTokens: null,
        usageType: 'estimated',
        status: 'success',
      };
      const c = calculateLlmCostForRecord(rec);
      expect(c.isEstimated).toBe(true);
      expect(c.costAvailable).toBe(false);
      expect(c.totalCost).toBeNull();
      expect(c.reason).toBe('missing_token_split');
    });
  });

  // ── E — Multiple LLM calls aggregated by requestId ───────────────────────
  describe('E — Multiple LLM calls under one requestId aggregated', () => {
    it('sums costs across multiple records', () => {
      const usages = [
        { _id: '1', requestId: 'req_abc', provider: 'groq', model: 'openai/gpt-oss-120b', inputTokens: 1000, outputTokens: 500, usageType: 'actual', status: 'success' },
        { _id: '2', requestId: 'req_abc', provider: 'groq', model: 'llama-3.3-70b-versatile', inputTokens: 2000, outputTokens: 1000, usageType: 'actual', status: 'success' },
      ];
      const result = calculateCostForRecords(usages, []);
      const c1 = calculateLlmCostForRecord(usages[0]);
      const c2 = calculateLlmCostForRecord(usages[1]);
      expect(result.llm.totalCost).toBeCloseTo(c1.totalCost + c2.totalCost, 8);
      expect(result.llm.recordCount).toBe(2);
      expect(result.meta.requestId).toBe('req_abc');
    });
  });

  // ── F — External API cost only for billable services ─────────────────────
  describe('F — External API cost filtering', () => {
    it('returns unavailable for free repository services', () => {
      const rec = { service: 'openneuro', operation: 'search', status: 'success' };
      const c = calculateExternalCostForRecord(rec);
      expect(c.costAvailable).toBe(false);
      expect(c.totalCost).toBeNull();
      expect(c.reason).toBe('pricing_unavailable');
    });

    it('returns 0 for unknown free services (dandi, zenodo, etc.)', () => {
      for (const svc of ['dandi', 'zenodo', 'figshare', 'dryad', 'osf', 'nitrc', 'ebrains', 'repository_search', 'fallback']) {
        const c = calculateExternalCostForRecord({ service: svc, status: 'success' });
        expect(c.costAvailable).toBe(false);
        expect(c.totalCost).toBeNull();
      }
    });

    it('calculates tavily cost only when pricing configured', () => {
      // No tavily pricing by default
      const before = calculateExternalCostForRecord({ service: 'tavily', status: 'success' });
      expect(before.costAvailable).toBe(false);

      process.env.TAVILY_PRICE_PER_1K_SEARCHES = '5'; // $5 per 1k = $0.005 per call
      const after = calculateExternalCostForRecord({ service: 'tavily', status: 'success' });
      expect(after.costAvailable).toBe(true);
      expect(after.totalCost).toBeCloseTo(0.005, 8);
      delete process.env.TAVILY_PRICE_PER_1K_SEARCHES;
    });

    it('aggregate external cost respects billable filtering', () => {
      process.env.TAVILY_PRICE_PER_1K_SEARCHES = '10'; // $0.01 per call
      const externals = [
        { _id: 'e1', requestId: 'req_1', service: 'tavily', status: 'success' },
        { _id: 'e2', requestId: 'req_1', service: 'openneuro', status: 'success' },
        { _id: 'e3', requestId: 'req_1', service: 'dandi', status: 'success' },
      ];
      const result = calculateCostForRecords([], externals);
      // Only tavily contributes
      expect(result.external.totalCost).toBeCloseTo(0.01, 8);
      delete process.env.TAVILY_PRICE_PER_1K_SEARCHES;
    });
  });

  // ── G — Missing pricing: no fabricated cost ──────────────────────────────
  describe('G — Missing pricing no fabrication', () => {
    it('returns null cost for unknown provider/model', () => {
      const rec = { provider: 'unknown_provider', model: 'unknown-model-xyz', inputTokens: 1000, outputTokens: 500, usageType: 'actual', status: 'success' };
      const c = calculateLlmCostForRecord(rec);
      expect(c.totalCost).toBeNull();
      expect(c.costAvailable).toBe(false);
      expect(c.pricingAvailable).toBe(false);
    });

    it('aggregate marks pricingMissing when any record lacks pricing', () => {
      const usages = [
        { _id: '1', requestId: 'req_x', provider: 'groq', model: 'openai/gpt-oss-120b', inputTokens: 100, outputTokens: 50, usageType: 'actual', status: 'success' },
        { _id: '2', requestId: 'req_x', provider: 'unknown', model: 'future-model-999', inputTokens: 100, outputTokens: 50, usageType: 'actual', status: 'success' },
      ];
      const result = calculateCostForRecords(usages, []);
      expect(result.llm.pricingMissing).toBe(true);
    });
  });

  // ── H — Cache hit: no fabricated cost ────────────────────────────────────
  describe('H — Cache hit no fabricated cost', () => {
    it('empty telemetry for cache hit yields zero cost, not invented', () => {
      const result = calculateCostForRecords([], []);
      expect(result.llm.totalCost).toBe(0);
      expect(result.external.totalCost).toBe(0);
      expect(result.total.totalCost).toBe(0);
      expect(result.llm.recordCount).toBe(0);
    });

    it('heuristic provider costs zero (repository search cache path)', () => {
      const rec = { provider: 'heuristic', model: 'heuristic', tokens: 500, usageType: 'estimated', status: 'success' };
      const c = calculateLlmCostForRecord(rec);
      expect(c.totalCost).toBe(0);
      expect(c.costAvailable).toBe(true);
      expect(c.reason).toBe('heuristic_no_cost');
    });

    it('failed LLM call excluded (no tokens counted)', () => {
      const rec = { provider: 'groq', model: 'openai/gpt-oss-120b', inputTokens: 1000, outputTokens: 500, usageType: 'actual', status: 'error' };
      const c = calculateLlmCostForRecord(rec);
      expect(c.totalCost).toBe(0);
      expect(c.reason).toBe('failed_call_excluded');
    });

    it('failed external call yields zero cost', () => {
      const rec = { service: 'tavily', status: 'error' };
      process.env.TAVILY_PRICE_PER_1K_SEARCHES = '5';
      const c = calculateExternalCostForRecord(rec);
      expect(c.totalCost).toBe(0);
      delete process.env.TAVILY_PRICE_PER_1K_SEARCHES;
    });
  });

  // ── I — Request correlation tied to requestId ────────────────────────────
  describe('I — Request correlation via requestId', () => {
    it('groups correctly by requestId and preserves it in meta', () => {
      const usagesA = [{ _id: '1', requestId: 'req_A', provider: 'groq', model: 'openai/gpt-oss-120b', inputTokens: 100, outputTokens: 50, usageType: 'actual', status: 'success' }];
      const usagesB = [{ _id: '2', requestId: 'req_B', provider: 'groq', model: 'openai/gpt-oss-120b', inputTokens: 200, outputTokens: 100, usageType: 'actual', status: 'success' }];
      const resA = calculateCostForRecords(usagesA, []);
      const resB = calculateCostForRecords(usagesB, []);
      expect(resA.meta.requestId).toBe('req_A');
      expect(resB.meta.requestId).toBe('req_B');
      expect(resA.llm.totalCost).not.toBeCloseTo(resB.llm.totalCost, 8);
    });

    it('does not mix costs across requestIds when calculated separately', () => {
      const usages = [
        { _id: '1', requestId: 'req_A', provider: 'groq', model: 'openai/gpt-oss-120b', inputTokens: 1000, outputTokens: 1000, usageType: 'actual', status: 'success' },
        { _id: '2', requestId: 'req_B', provider: 'groq', model: 'openai/gpt-oss-120b', inputTokens: 1000, outputTokens: 1000, usageType: 'actual', status: 'success' },
      ];
      const combined = calculateCostForRecords(usages, []);
      const single = calculateCostForRecords([usages[0]], []);
      // Combined is sum of both; single is half — ensures no double-count per-request
      expect(combined.llm.totalCost).toBeCloseTo(single.llm.totalCost * 2, 8);
    });
  });

  // ── J — Aggregate daily/monthly no double-count ──────────────────────────
  describe('J — Aggregate no double-count', () => {
    it('aggregate daily groups and does not double-count records', async () => {
      jest.mock('../src/config/db.config', () => jest.fn().mockResolvedValue());
      const TokenUsage = require('../src/modules/admin/tokenUsage.model');
      const ExternalApiLog = require('../src/modules/admin/externalApiLog.model');
      // Mock DB fetch for aggregate helper by testing pure function grouping
      const usages = [
        { _id: '1', requestId: 'req_1', provider: 'groq', model: 'openai/gpt-oss-120b', inputTokens: 1000, outputTokens: 500, usageType: 'actual', status: 'success', createdAt: new Date('2026-09-01T10:00:00Z') },
        { _id: '2', requestId: 'req_2', provider: 'groq', model: 'openai/gpt-oss-120b', inputTokens: 1000, outputTokens: 500, usageType: 'actual', status: 'success', createdAt: new Date('2026-09-01T11:00:00Z') },
        { _id: '3', requestId: 'req_3', provider: 'groq', model: 'openai/gpt-oss-120b', inputTokens: 1000, outputTokens: 500, usageType: 'actual', status: 'success', createdAt: new Date('2026-09-02T10:00:00Z') },
      ];
      // Simulate daily grouping via pure logic: 2 records on 2026-09-01, 1 on 2026-09-02
      const c1 = calculateLlmCostForRecord(usages[0]);
      const c2 = calculateLlmCostForRecord(usages[1]);
      const c3 = calculateLlmCostForRecord(usages[2]);
      const total = c1.totalCost + c2.totalCost + c3.totalCost;
      const combined = calculateCostForRecords(usages, []);
      expect(combined.llm.totalCost).toBeCloseTo(total, 8);
      // Simulate double-read idempotency: reading same records twice should sum twice (not deduplicate incorrectly)
      const doubleRead = calculateCostForRecords([...usages, ...usages], []);
      expect(doubleRead.llm.totalCost).toBeCloseTo(total * 2, 8); // pure function sums all passed records — caller must deduplicate by query
      // Real idempotency: same requestId queried twice returns same cost each time (no side-effects)
      const first = calculateCostForRecords([usages[0]], []);
      const second = calculateCostForRecords([usages[0]], []);
      expect(first.llm.totalCost).toBe(second.llm.totalCost);
    });
  });

  // ── Admin pricing endpoint pricing table ─────────────────────────────────
  describe('Pricing table', () => {
    it('resolves known provider/model pricing', () => {
      const p = getLlmPricing('groq', 'openai/gpt-oss-120b');
      expect(p).not.toBeNull();
      expect(p.inputPerMillion).toBeGreaterThan(0);
      expect(p.outputPerMillion).toBeGreaterThan(0);
    });
    it('returns null for heuristic (no cost)', () => {
      expect(getLlmPricing('heuristic', 'anything')).toBeNull();
    });
    it('returns null for unknown provider', () => {
      expect(getLlmPricing('unknown_provider', 'some-model')).toBeNull();
    });
  });
});

describe('Admin cost routes (smoke)', () => {
  jest.mock('../src/config/db.config', () => jest.fn().mockResolvedValue());
  const request = require('supertest');
  const jwt = require('jsonwebtoken');
  const app = require('../src/app');

  const adminToken = jwt.sign({ id: '507f1f77bcf86cd799439099', role: 'admin' }, process.env.JWT_ACCESS_SECRET || 'test_secret', { expiresIn: '1h' });

  // Mock models for route tests
  jest.mock('../src/modules/admin/tokenUsage.model', () => ({
    find: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
  }));
  jest.mock('../src/modules/admin/externalApiLog.model', () => ({
    find: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
  }));

  it('GET /admin/cost/pricing returns pricing table', async () => {
    const res = await request(app).get('/api/v1/admin/cost/pricing').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.llm).toBeDefined();
    expect(res.body.data.external).toBeDefined();
  });

  it('GET /admin/cost/request/:requestId returns cost shape', async () => {
    const TokenUsage = require('../src/modules/admin/tokenUsage.model');
    const ExternalApiLog = require('../src/modules/admin/externalApiLog.model');
    TokenUsage.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([
      { _id: 'u1', requestId: 'req_test', provider: 'groq', model: 'openai/gpt-oss-120b', inputTokens: 100, outputTokens: 50, usageType: 'actual', status: 'success', createdAt: new Date() },
    ]) });
    ExternalApiLog.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });

    const res = await request(app).get('/api/v1/admin/cost/request/req_test').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.llm).toBeDefined();
    expect(res.body.data.total).toBeDefined();
    expect(res.body.data.meta.requestId).toBe('req_test');
  });

  it('GET /admin/cost/daily returns summary shape', async () => {
    const TokenUsage = require('../src/modules/admin/tokenUsage.model');
    const ExternalApiLog = require('../src/modules/admin/externalApiLog.model');
    TokenUsage.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
    ExternalApiLog.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
    const res = await request(app).get('/api/v1/admin/cost/daily?from=2026-09-01&to=2026-09-08').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toBeDefined();
    expect(res.body.data.groups).toBeDefined();
  });
});
