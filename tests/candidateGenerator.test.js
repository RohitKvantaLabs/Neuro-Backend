/**
 * CandidateGenerator unit tests — Retrieval V2
 *
 * Covers:
 *   1. Level 1 search execution
 *   2. Level 2 concept $or fallback
 *   3. Level 3 raw query fallback
 *   4. Synonym expansion (expandConceptTerms)
 *   5. Hard UI filters (extractHardConstraints)
 *   6. Soft natural-language concepts (buildConcepts)
 *   7. Concept coverage calculation (evaluateCandidateCoverage)
 *   8. UNKNOWN vs MISMATCH handling
 *   9. Task retrieval
 *  10. Minimum coverage gate (passesMinimumCoverage)
 *  11. Candidate deduplication across levels
 *  12. Flagship query execution ("Resting-state fMRI in children with ADHD")
 */

const Dataset = require('../src/modules/dataset/dataset.model');
const {
  generateCandidates,
  buildConcepts,
  extractHardConstraints,
  evaluateCandidateCoverage,
  passesMinimumCoverage,
  expandConceptTerms,
  conceptClause,
  semanticSearchText,
} = require('../src/modules/dataset/candidateGenerator');

jest.mock('../src/modules/dataset/dataset.model');

describe('CandidateGenerator — Retrieval V2', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('1. Synonym expansion (expandConceptTerms)', () => {
    it('expands modality terms onto synonym families', () => {
      const terms = expandConceptTerms('modality', 'fMRI');
      expect(terms).toContain('fmri');
      expect(terms).toContain('mri');
    });

    it('expands age range terms onto synonym families', () => {
      const terms = expandConceptTerms('age_range', 'child');
      expect(terms).toContain('child');
      expect(terms).toContain('children');
      expect(terms).toContain('pediatric');
    });

    it('expands disease terms onto synonym families', () => {
      const terms = expandConceptTerms('condition', 'ADHD');
      expect(terms).toContain('adhd');
      expect(terms).toContain('attention deficit hyperactivity disorder');
    });

    it('expands task terms onto TASK_VOCAB families', () => {
      const terms = expandConceptTerms('task', 'resting-state');
      expect(terms).toContain('resting-state');
      expect(terms).toContain('resting state');
    });
  });

  describe('2. Hard UI filters vs Soft NL concepts', () => {
    it('extracts hard constraints ONLY from explicit UI filters', () => {
      const hard = extractHardConstraints({ ageGroup: 'Child', repository: 'openneuro' });
      expect(hard).not.toBeNull();
      expect(hard.$and).toBeDefined();
      expect(hard.$and.length).toBe(2);
    });

    it('returns null hard constraints when no explicit UI filters are passed', () => {
      const hard = extractHardConstraints(null);
      expect(hard).toBeNull();
    });

    it('builds soft concepts from natural language parsed filters', () => {
      const concepts = buildConcepts({
        modality: ['fMRI'],
        condition: ['ADHD'],
        task: 'resting-state',
        age_range: 'child',
      });
      expect(concepts).toHaveLength(4);
      expect(concepts.map((c) => c.field)).toEqual(['modality', 'condition', 'task', 'age_range']);
    });
  });

  describe('3. Concept coverage & gating (evaluateCandidateCoverage & passesMinimumCoverage)', () => {
    it('evaluates candidate concept coverage correctly', () => {
      const candidate = {
        title: 'Childhood ADHD fMRI study',
        modality: ['fMRI'],
        disease: 'ADHD',
        age_group: 'child',
        task: null,
      };
      const filters = { modality: ['fMRI'], condition: ['ADHD'], age_range: 'child', task: 'resting-state' };
      const cov = evaluateCandidateCoverage(candidate, filters);
      expect(cov.matched).toBe(3);
      expect(cov.unknown).toBe(1);
      expect(cov.mismatched).toBe(0);
    });

    it('passes minimum coverage when matched >= 1 and mismatched <= matched', () => {
      const passCov = { matched: 1, mismatched: 0, unknown: 2 };
      expect(passesMinimumCoverage(passCov)).toBe(true);

      const failCovZero = { matched: 0, mismatched: 0, unknown: 3 };
      expect(passesMinimumCoverage(failCovZero)).toBe(false);

      const failCovContradiction = { matched: 1, mismatched: 2, unknown: 0 };
      expect(passesMinimumCoverage(failCovContradiction)).toBe(false);
    });
  });

  describe('4. Semantic search text & concept clauses', () => {
    it('builds search text string from semantic filter terms', () => {
      const filters = { modality: ['fMRI'], condition: ['ADHD'], task: 'resting-state' };
      const text = semanticSearchText(filters);
      expect(text).toBe('fMRI resting-state ADHD');
    });

    it('builds flat concept clauses array for Level 2', () => {
      const clauses = conceptClause({ field: 'task', value: 'resting-state' });
      expect(Array.isArray(clauses)).toBe(true);
      expect(clauses.length).toBeGreaterThan(0);
      expect(clauses[0]).toHaveProperty('task');
    });
  });

  describe('5. Cascade Execution & Deduplication', () => {
    it('executes Level 1 search when semantic terms exist', async () => {
      Dataset.find.mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([
          { source: 'openneuro', source_id: 'ds1', modality: ['fMRI'], disease: 'ADHD', age_group: 'child' },
        ]),
      });

      const filters = { modality: ['fMRI'], condition: ['ADHD'], age_range: 'child', raw_query: 'fMRI ADHD' };
      const res = await generateCandidates(filters, null, { poolTarget: 10 });

      expect(res.candidates).toHaveLength(1);
      expect(res.levelsUsed).toContain(1);
      expect(res.candidates[0]._retrievalLevel).toBe(1);
    });

    it('falls back to Level 2 when Level 1 returns fewer than target candidates', async () => {
      // Level 1 returns 0 docs; Level 2 returns 2 docs
      Dataset.find
        .mockReturnValueOnce({
          sort: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          lean: jest.fn().mockResolvedValue([]),
        })
        .mockReturnValueOnce({
          limit: jest.fn().mockReturnThis(),
          lean: jest.fn().mockResolvedValue([
            { source: 'openneuro', source_id: 'ds1', modality: ['fMRI'] },
            { source: 'zenodo', source_id: 'z1', disease: 'ADHD' },
          ]),
        });

      const filters = { modality: ['fMRI'], condition: ['ADHD'], raw_query: 'fMRI ADHD' };
      const res = await generateCandidates(filters, null, { poolTarget: 10 });

      expect(res.candidates).toHaveLength(2);
      expect(res.levelsUsed).toContain(2);
    });

    it('deduplicates candidates across cascade levels', async () => {
      const sharedDoc = { source: 'openneuro', source_id: 'ds1', modality: ['fMRI'] };

      Dataset.find
        .mockReturnValueOnce({
          sort: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          lean: jest.fn().mockResolvedValue([sharedDoc]),
        })
        .mockReturnValueOnce({
          limit: jest.fn().mockReturnThis(),
          lean: jest.fn().mockResolvedValue([sharedDoc]),
        });

      const filters = { modality: ['fMRI'], raw_query: 'fMRI' };
      const res = await generateCandidates(filters, null, { poolTarget: 10 });

      expect(res.candidates).toHaveLength(1);
      expect(res.candidates[0]._retrievalLevel).toBe(1);
    });

    it('executes flagship query candidate generation end-to-end', async () => {
      const flagshipCandidate = {
        source: 'openneuro',
        source_id: 'ds003500',
        title: 'Response inhibition and selective attention in children with ADHD',
        modality: ['fMRI'],
        species: ['human'],
        disease: 'ADHD',
        age_group: 'child',
        task: 'resting-state',
      };

      Dataset.find.mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([flagshipCandidate]),
      });

      const filters = {
        modality: ['fMRI'],
        species: ['human'],
        condition: ['ADHD'],
        task: 'resting-state',
        age_range: 'child',
        raw_query: 'Resting-state fMRI in children with ADHD',
      };

      const res = await generateCandidates(filters, null);
      expect(res.candidates.length).toBeGreaterThan(0);
      expect(res.candidates[0]._coverage.matched).toBeGreaterThanOrEqual(1);
    });
  });
});
