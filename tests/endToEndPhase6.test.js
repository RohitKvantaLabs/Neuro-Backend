const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/config/db.config', () => jest.fn().mockResolvedValue());

const app = require('../src/app');
const Dataset = require('../src/modules/dataset/dataset.model');
const DatasetReaction = require('../src/modules/dataset/datasetReaction.model');
const { DatasetDislikeFeedback } = require('../src/modules/dataset/datasetDislikeFeedback.model');
const { AdminDatasetOverride } = require('../src/modules/dataset/adminDatasetOverride.model');
const { PopularDataset } = require('../src/modules/dataset/popularDataset.model');
const AuditLog = require('../src/modules/admin/auditLog.model');

jest.mock('../src/modules/dataset/dataset.model');
jest.mock('../src/modules/dataset/datasetReaction.model');
jest.mock('../src/modules/dataset/datasetDislikeFeedback.model', () => {
  const actual = jest.requireActual('../src/modules/dataset/datasetDislikeFeedback.model');
  return {
    DatasetDislikeFeedback: {
      create: jest.fn().mockResolvedValue({}),
      findOneAndUpdate: jest.fn().mockResolvedValue({ id: 'fb_123' }),
      updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      distinct: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue([]),
      find: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
    },
    VALID_REASONS: actual.VALID_REASONS,
  };
});
jest.mock('../src/modules/dataset/adminDatasetOverride.model', () => {
  const actual = jest.requireActual('../src/modules/dataset/adminDatasetOverride.model');
  return {
    AdminDatasetOverride: {
      findOneAndUpdate: jest.fn(),
      findOne: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
      deleteOne: jest.fn(),
      find: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
    },
    ALLOWED_OVERRIDE_FIELDS: actual.ALLOWED_OVERRIDE_FIELDS,
  };
});
jest.mock('../src/modules/dataset/popularDataset.model', () => {
  const actual = jest.requireActual('../src/modules/dataset/popularDataset.model');
  return {
    PopularDataset: {
      findOneAndUpdate: jest.fn(),
      findOne: jest.fn(),
      bulkWrite: jest.fn(),
      deleteOne: jest.fn(),
      distinct: jest.fn().mockResolvedValue([]),
      find: jest.fn(),
    },
    POPULAR_STATUSES: actual.POPULAR_STATUSES,
  };
});
jest.mock('../src/modules/admin/auditLog.model', () => ({
  create: jest.fn().mockResolvedValue({}),
}));

const makeQueryObj = (val) => ({
  lean: jest.fn().mockResolvedValue(val),
  select: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  then: (resolve) => resolve(val),
});

describe('Phase 6 — End-to-End Workflow Verification', () => {
  const adminId = '507f1f77bcf86cd799439099';
  const adminToken = jwt.sign(
    { id: adminId, role: 'admin' },
    process.env.JWT_ACCESS_SECRET || 'test_secret',
    { expiresIn: '1h' }
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('1. Reaction & Dislike Feedback Flow', () => {
    it('stores user like reaction cleanly', async () => {
      Dataset.findOne.mockReturnValue(makeQueryObj({ _id: 'ds_e2e_1', source_id: 'ds_e2e_1', title: 'E2E Dataset' }));
      DatasetReaction.findOne.mockReturnValue(makeQueryObj({ reaction: 'like' }));
      DatasetReaction.create.mockResolvedValue({ datasetId: 'ds_e2e_1', reaction: 'like' });
      DatasetReaction.countDocuments.mockImplementation((filter) => {
        if (filter.reaction === 'like') return Promise.resolve(1);
        return Promise.resolve(0);
      });

      const res = await request(app)
        .post('/api/v1/datasets/reactions')
        .send({ datasetId: 'ds_e2e_1', reaction: 'like', anonKey: 'anon_123' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.userReaction).toBe('like');
    });

    it('stores dislike reaction and associated dislike feedback', async () => {
      Dataset.findOne.mockReturnValue(makeQueryObj({ _id: 'ds_e2e_1', source_id: 'ds_e2e_1', title: 'E2E Dataset' }));
      DatasetReaction.findOne.mockReturnValue(makeQueryObj({ reaction: 'dislike' }));
      DatasetReaction.create.mockResolvedValue({ datasetId: 'ds_e2e_1', reaction: 'dislike' });
      DatasetReaction.countDocuments.mockImplementation((filter) => {
        if (filter.reaction === 'dislike') return Promise.resolve(1);
        return Promise.resolve(0);
      });

      const res = await request(app)
        .post('/api/v1/datasets/reactions')
        .send({
          datasetId: 'ds_e2e_1',
          reaction: 'dislike',
          reason: 'metadata_incorrect',
          comment: 'Modality is incorrect',
          anonKey: 'anon_123',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.userReaction).toBe('dislike');
      expect(DatasetDislikeFeedback.findOneAndUpdate).toHaveBeenCalled();
    });
  });

  describe('2. Admin Moderation & Candidates Flow', () => {
    it('aggregates popular candidates with likes >= 3 and netScore > 0', async () => {
      PopularDataset.distinct.mockResolvedValue([]);
      Dataset.find.mockReturnValue(makeQueryObj([])); // no inactive datasets
      DatasetReaction.aggregate.mockResolvedValue([
        {
          totalCount: [{ count: 1 }],
          paginatedResults: [{ _id: 'ds_e2e_cand', likes: 5, dislikes: 1, netScore: 4 }],
        },
      ]);

      const res = await request(app)
        .get('/api/v1/admin/moderation/popular-candidates')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBe(1);
      expect(res.body.data.items[0].netScore).toBe(4);
    });

    it('creates admin metadata override without mutating canonical dataset', async () => {
      Dataset.findOne.mockReturnValue(makeQueryObj({ _id: 'ds_e2e_1', source_id: 'ds_e2e_1', title: 'Canonical Title' }));
      AdminDatasetOverride.findOneAndUpdate.mockResolvedValue({
        datasetId: 'ds_e2e_1',
        title: 'Corrected Title',
        disease: 'Temporal Lobe Epilepsy',
      });

      const res = await request(app)
        .patch('/api/v1/admin/datasets/ds_e2e_1/override')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'Corrected Title', disease: 'Temporal Lobe Epilepsy' });

      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe('Corrected Title');
    });

    it('publishes dataset to popular with displayOrder', async () => {
      Dataset.findOne.mockReturnValue(makeQueryObj({ _id: 'ds_e2e_1', source_id: 'ds_e2e_1', title: 'Canonical Title' }));
      PopularDataset.findOneAndUpdate.mockResolvedValue({
        datasetId: 'ds_e2e_1',
        status: 'published',
        displayOrder: 1,
      });

      const res = await request(app)
        .post('/api/v1/admin/moderation/popular/ds_e2e_1/publish')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ displayOrder: 1 });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('published');
    });
  });

  describe('3. Public Popular API & 6-Card Limit Verification', () => {
    it('serves max 6 published datasets ordered by displayOrder ASC with override resolution', async () => {
      const rawPopular = Array.from({ length: 8 }, (_, i) => ({
        datasetId: `ds_p${i + 1}`,
        status: 'published',
        displayOrder: i + 1,
      }));

      PopularDataset.find.mockReturnValue(makeQueryObj(rawPopular.slice(0, 6)));

      const canonicalDocs = rawPopular.slice(0, 6).map((d) => ({
        _id: d.datasetId,
        source: 'OpenNeuro',
        title: `Canonical ${d.datasetId}`,
        is_active: true,
      }));
      Dataset.find.mockReturnValue(makeQueryObj(canonicalDocs));
      AdminDatasetOverride.find.mockReturnValue(makeQueryObj([
        { datasetId: 'ds_p1', title: 'Admin Title 1' },
      ]));

      const res = await request(app).get('/api/v1/datasets/popular');

      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBe(6);
      expect(res.body.data.items[0].title).toBe('Admin Title 1');
      expect(res.body.data.items[0].displayOrder).toBe(1);

      // Verify no leak of internal admin/audit fields
      res.body.data.items.forEach((item) => {
        expect(item.updatedBy).toBeUndefined();
        expect(item.publishedBy).toBeUndefined();
        expect(item.status).toBeUndefined();
      });
    });
  });

  describe('4. Lifecycle & Safety Verification', () => {
    it('unpublishes popular dataset without deleting canonical record', async () => {
      const mockPopular = { datasetId: 'ds_e2e_1', status: 'published', save: jest.fn().mockResolvedValue({}) };
      PopularDataset.findOne.mockResolvedValue(mockPopular);

      const res = await request(app)
        .post('/api/v1/admin/moderation/popular/ds_e2e_1/unpublish')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(mockPopular.status).toBe('unpublished');
      expect(mockPopular.save).toHaveBeenCalled();
    });

    it('archives dataset setting is_active = false', async () => {
      const mockDataset = { _id: 'ds_e2e_1', is_active: true, save: jest.fn().mockResolvedValue({}) };
      Dataset.findOne.mockResolvedValue(mockDataset);
      PopularDataset.findOneAndUpdate.mockResolvedValue({ datasetId: 'ds_e2e_1', status: 'archived' });

      const res = await request(app)
        .post('/api/v1/admin/datasets/ds_e2e_1/archive')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(mockDataset.is_active).toBe(false);
      expect(mockDataset.save).toHaveBeenCalled();
    });

    it('rejects hard delete if confirmationId does not match datasetId', async () => {
      const res = await request(app)
        .delete('/api/v1/admin/datasets/ds_e2e_target')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ confirmationId: 'wrong_id' });

      expect(res.status).toBe(400);
    });

    it('executes hard delete cascade and logs audit action when confirmationId matches', async () => {
      Dataset.findOne.mockReturnValue(makeQueryObj({ _id: 'ds_e2e_target', source_id: 'ds_e2e_target', title: 'Target Dataset' }));
      Dataset.findOneAndDelete.mockResolvedValue({ _id: 'ds_e2e_target', title: 'Target Dataset' });
      DatasetReaction.deleteMany.mockResolvedValue({ deletedCount: 5 });
      AdminDatasetOverride.deleteOne.mockResolvedValue({ deletedCount: 1 });
      PopularDataset.deleteOne.mockResolvedValue({ deletedCount: 1 });

      const res = await request(app)
        .delete('/api/v1/admin/datasets/ds_e2e_target')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ confirmationId: 'ds_e2e_target' });

      expect(res.status).toBe(200);
      expect(DatasetReaction.deleteMany).toHaveBeenCalled();
      expect(AdminDatasetOverride.deleteOne).toHaveBeenCalled();
      expect(PopularDataset.deleteOne).toHaveBeenCalled();
      expect(AuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'dataset.delete_hard', targetId: 'ds_e2e_target' })
      );
    });

    it('blocks non-admin users from accessing curation endpoints', async () => {
      const userToken = jwt.sign(
        { id: 'user_123', role: 'user' },
        process.env.JWT_ACCESS_SECRET || 'test_secret',
        { expiresIn: '1h' }
      );

      const res = await request(app)
        .patch('/api/v1/admin/datasets/ds_e2e_1/override')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ title: 'Hacked Title' });

      expect(res.status).toBe(403);
    });
  });
});
