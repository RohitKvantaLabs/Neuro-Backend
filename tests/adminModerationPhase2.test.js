const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/config/db.config', () => jest.fn().mockResolvedValue());

const app = require('../src/app');
const Dataset = require('../src/modules/dataset/dataset.model');
const DatasetReaction = require('../src/modules/dataset/datasetReaction.model');
const { DatasetDislikeFeedback, VALID_REASONS } = require('../src/modules/dataset/datasetDislikeFeedback.model');

jest.mock('../src/modules/dataset/dataset.model');
jest.mock('../src/modules/dataset/datasetReaction.model');
jest.mock('../src/modules/dataset/datasetDislikeFeedback.model', () => {
  const actual = jest.requireActual('../src/modules/dataset/datasetDislikeFeedback.model');
  return {
    DatasetDislikeFeedback: {
      distinct: jest.fn(),
      aggregate: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      countDocuments: jest.fn(),
    },
    VALID_REASONS: actual.VALID_REASONS,
  };
});

jest.mock('../src/modules/dataset/popularDataset.model', () => ({
  PopularDataset: {
    distinct: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../src/modules/dataset/adminDatasetOverride.model', () => ({
  AdminDatasetOverride: {
    findOne: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
  },
}));

describe('Admin Moderation APIs — Phase 2', () => {
  const adminId = '507f1f77bcf86cd799439099';
  const userId = '507f1f77bcf86cd799439011';

  const adminToken = jwt.sign(
    { id: adminId, role: 'admin' },
    process.env.JWT_ACCESS_SECRET || 'test_secret',
    { expiresIn: '15m' }
  );

  const userToken = jwt.sign(
    { id: userId, role: 'user' },
    process.env.JWT_ACCESS_SECRET || 'test_secret',
    { expiresIn: '15m' }
  );

  const makeQueryObj = (val) => ({
    lean: jest.fn().mockResolvedValue(val),
    sort: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    then: (resolve) => resolve(val),
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── Authorization ─────────────────────────────────────────────────────────

  describe('Authorization checks', () => {
    it('rejects unauthenticated request with 401', async () => {
      const res = await request(app).get('/api/v1/admin/moderation/popular-candidates');
      expect(res.status).toBe(401);
    });

    it('rejects non-admin authenticated user with 403', async () => {
      const res = await request(app)
        .get('/api/v1/admin/moderation/popular-candidates')
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(403);
    });
  });

  // ─── 1. Popular Candidates ─────────────────────────────────────────────────

  describe('GET /api/v1/admin/moderation/popular-candidates', () => {
    it('aggregates candidates matching formula: likes >= 3 AND netScore > 0', async () => {
      DatasetReaction.aggregate.mockResolvedValue([
        {
          totalCount: [{ count: 2 }],
          paginatedResults: [
            { _id: 'ds_001', likes: 10, dislikes: 2, netScore: 8 },
            { _id: 'ds_002', likes: 4, dislikes: 1, netScore: 3 },
          ],
        },
      ]);

      Dataset.find.mockReturnValue(
        makeQueryObj([
          { _id: 'ds_001', title: 'Brain EEG Study', source: 'openneuro', modality: ['EEG'] },
          { _id: 'ds_002', title: 'fMRI Connectivity', source: 'dandi', modality: ['fMRI'] },
        ])
      );

      const res = await request(app)
        .get('/api/v1/admin/moderation/popular-candidates?page=1&limit=30')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(2);
      expect(res.body.data.items[0]).toEqual(
        expect.objectContaining({
          datasetId: 'ds_001',
          canonicalTitle: 'Brain EEG Study',
          repository: 'openneuro',
          likes: 10,
          dislikes: 2,
          netScore: 8,
        })
      );
      expect(res.body.data.pagination).toEqual({
        page: 1,
        limit: 30,
        total: 2,
        totalPages: 1,
      });
    });

    it('returns empty items array when no candidates match formula', async () => {
      DatasetReaction.aggregate.mockResolvedValue([
        {
          totalCount: [],
          paginatedResults: [],
        },
      ]);

      Dataset.find.mockReturnValue(makeQueryObj([]));

      const res = await request(app)
        .get('/api/v1/admin/moderation/popular-candidates')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
      expect(res.body.data.pagination.total).toBe(0);
    });
  });

  // ─── 2. Dislike Review Queue ───────────────────────────────────────────────

  describe('GET /api/v1/admin/moderation/dislike-queue', () => {
    it('aggregates dislike queue items, dislikeRatio, topReasons, and pendingFeedbackCount', async () => {
      DatasetReaction.aggregate.mockResolvedValue([
        {
          totalCount: [{ count: 1 }],
          paginatedResults: [
            { _id: 'ds_100', likes: 2, dislikes: 8, totalReactions: 10, netScore: -6 },
          ],
        },
      ]);

      Dataset.find.mockReturnValue(
        makeQueryObj([{ _id: 'ds_100', title: 'Corrupted Sleep Study', source: 'web_search' }])
      );

      DatasetDislikeFeedback.aggregate.mockResolvedValue([{ _id: 'ds_100', count: 5 }]);

      DatasetDislikeFeedback.find.mockReturnValue(
        makeQueryObj([
          { datasetId: 'ds_100', reason: 'metadata_incorrect', status: 'pending' },
          { datasetId: 'ds_100', reason: 'metadata_incorrect', status: 'pending' },
          { datasetId: 'ds_100', reason: 'broken_link', status: 'pending' },
        ])
      );

      const res = await request(app)
        .get('/api/v1/admin/moderation/dislike-queue?minDislikes=1')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(1);
      const item = res.body.data.items[0];
      expect(item.datasetId).toBe('ds_100');
      expect(item.dislikes).toBe(8);
      expect(item.dislikeRatio).toBe(0.8);
      expect(item.pendingFeedbackCount).toBe(5);
      expect(item.topReasons[0]).toEqual({
        reason: 'metadata_incorrect',
        count: 2,
        percentage: 66.7,
      });
    });

    it('validates reason filter against VALID_REASONS enum', async () => {
      const res = await request(app)
        .get('/api/v1/admin/moderation/dislike-queue?reason=invalid_reason_code')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Invalid reason parameter');
    });

    it('filters dislike queue by specific reason when requested', async () => {
      DatasetDislikeFeedback.distinct.mockResolvedValue(['ds_100']);

      DatasetReaction.aggregate.mockResolvedValue([
        {
          totalCount: [{ count: 1 }],
          paginatedResults: [{ _id: 'ds_100', likes: 0, dislikes: 3, totalReactions: 3, netScore: -3 }],
        },
      ]);

      Dataset.find.mockReturnValue(makeQueryObj([{ _id: 'ds_100', title: 'Duplicate Dataset' }]));
      DatasetDislikeFeedback.aggregate.mockResolvedValue([{ _id: 'ds_100', count: 1 }]);
      DatasetDislikeFeedback.find.mockReturnValue(
        makeQueryObj([{ datasetId: 'ds_100', reason: 'duplicate', status: 'pending' }])
      );

      const res = await request(app)
        .get('/api/v1/admin/moderation/dislike-queue?reason=duplicate')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(DatasetDislikeFeedback.distinct).toHaveBeenCalledWith('datasetId', { reason: 'duplicate' });
      expect(res.body.data.items[0].datasetId).toBe('ds_100');
    });
  });

  // ─── 3. Dislike Detail API ──────────────────────────────────────────────────

  describe('GET /api/v1/admin/moderation/dislike-queue/:datasetId', () => {
    it('returns detail dataset metadata, reaction summary, null override, and safe feedback list', async () => {
      Dataset.find.mockReturnValue(
        makeQueryObj([
          {
            _id: 'ds_200',
            title: 'Spike Sorting Benchmarks',
            source: 'dandi',
            modality: ['ephys'],
            species: ['mouse'],
            description: 'Extracellular recordings.',
          },
        ])
      );

      DatasetReaction.countDocuments.mockImplementation((filter) => {
        if (filter.reaction === 'like') return Promise.resolve(5);
        if (filter.reaction === 'dislike') return Promise.resolve(2);
        return Promise.resolve(0);
      });

      DatasetDislikeFeedback.find.mockReturnValue(
        makeQueryObj([
          {
            _id: '507f1f77bcf86cd799439001',
            datasetId: 'ds_200',
            userId: '507f1f77bcf86cd799439011',
            reason: 'quality_concern',
            comment: 'High noise floor.',
            status: 'pending',
            createdAt: new Date('2026-08-22T10:00:00Z'),
          },
        ])
      );

      const res = await request(app)
        .get('/api/v1/admin/moderation/dislike-queue/ds_200')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.dataset.title).toBe('Spike Sorting Benchmarks');
      expect(res.body.data.override).toBeNull();
      expect(res.body.data.reactionSummary).toEqual({
        likes: 5,
        dislikes: 2,
        totalReactions: 7,
        dislikeRatio: 0.2857,
        netScore: 3,
      });
      expect(res.body.data.feedbackList).toHaveLength(1);
      expect(res.body.data.feedbackList[0]).toEqual({
        id: '507f1f77bcf86cd799439001',
        reason: 'quality_concern',
        comment: 'High noise floor.',
        status: 'pending',
        isAnonymous: false,
        createdAt: expect.any(String),
      });
    });

    it('returns 404 if dataset and all moderation records are absent', async () => {
      Dataset.find.mockReturnValue(makeQueryObj([]));
      DatasetReaction.countDocuments.mockResolvedValue(0);
      DatasetDislikeFeedback.find.mockReturnValue(makeQueryObj([]));

      const res = await request(app)
        .get('/api/v1/admin/moderation/dislike-queue/ds_non_existent')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
      expect(res.body.message).toContain('Dataset moderation record not found.');
    });

    it('handles orphaned records safely when dataset is absent but reactions exist', async () => {
      Dataset.find.mockReturnValue(makeQueryObj([]));
      DatasetReaction.countDocuments.mockImplementation((filter) => {
        if (filter.reaction === 'dislike') return Promise.resolve(3);
        return Promise.resolve(0);
      });
      DatasetDislikeFeedback.find.mockReturnValue(
        makeQueryObj([
          {
            _id: '507f1f77bcf86cd799439002',
            datasetId: 'ds_orphaned',
            reason: 'broken_link',
            comment: null,
            status: 'pending',
            createdAt: new Date(),
          },
        ])
      );

      const res = await request(app)
        .get('/api/v1/admin/moderation/dislike-queue/ds_orphaned')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.dataset.title).toBe('Unavailable dataset');
      expect(res.body.data.reactionSummary.dislikes).toBe(3);
      expect(res.body.data.feedbackList).toHaveLength(1);
    });
  });
});
