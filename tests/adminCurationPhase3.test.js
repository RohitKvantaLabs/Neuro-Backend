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
      deleteOne: jest.fn(),
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
    },
    POPULAR_STATUSES: actual.POPULAR_STATUSES,
  };
});
jest.mock('../src/modules/admin/auditLog.model', () => ({
  create: jest.fn().mockResolvedValue({}),
}));

describe('Admin Curation & Metadata Overrides — Phase 3', () => {
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
    select: jest.fn().mockReturnThis(),
    then: (resolve) => resolve(val),
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── 1. Metadata Overrides (PATCH & DELETE) ────────────────────────────────

  describe('PATCH & DELETE /api/v1/admin/datasets/:datasetId/override', () => {
    it('rejects unauthorized access for non-admin', async () => {
      const res = await request(app)
        .patch('/api/v1/admin/datasets/ds_300/override')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ title: 'New Title' });
      expect(res.status).toBe(403);
    });

    it('rejects invalid editable fields like _id, source, url', async () => {
      Dataset.findOne.mockReturnValue(makeQueryObj({ _id: 'ds_300', title: 'Canonical Title' }));

      const res = await request(app)
        .patch('/api/v1/admin/datasets/ds_300/override')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'New Title', source: 'hacked_source' });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Invalid override fields: source');
      expect(AdminDatasetOverride.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('creates/updates override for valid fields and logs admin audit action', async () => {
      const mockDataset = { _id: 'ds_300', title: 'Canonical Title', source: 'openneuro' };
      Dataset.findOne.mockReturnValue(makeQueryObj(mockDataset));

      const updatedOverride = {
        datasetId: 'ds_300',
        title: 'Corrected Title',
        disease: 'Alzheimer',
        updatedBy: adminId,
      };
      AdminDatasetOverride.findOneAndUpdate.mockResolvedValue(updatedOverride);

      const res = await request(app)
        .patch('/api/v1/admin/datasets/ds_300/override')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'Corrected Title', disease: 'Alzheimer' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.title).toBe('Corrected Title');
      expect(AuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          adminId,
          action: 'dataset.override.update',
          targetId: 'ds_300',
        })
      );
    });

    it('reverts metadata override via DELETE /override', async () => {
      AdminDatasetOverride.deleteOne.mockResolvedValue({ deletedCount: 1 });

      const res = await request(app)
        .delete('/api/v1/admin/datasets/ds_300/override')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(AdminDatasetOverride.deleteOne).toHaveBeenCalledWith({ datasetId: 'ds_300' });
      expect(AuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          adminId,
          action: 'dataset.override.revert',
          targetId: 'ds_300',
        })
      );
    });
  });

  // ─── 2. Popular Curation (Publish, Unpublish, Reorder) ────────────────────

  describe('Popular Curation APIs', () => {
    it('publishes a dataset to PopularDataset and logs audit entry', async () => {
      Dataset.findOne.mockReturnValue(makeQueryObj({ _id: 'ds_301', title: 'EEG Dataset', is_active: true }));
      PopularDataset.findOneAndUpdate.mockResolvedValue({
        datasetId: 'ds_301',
        status: 'published',
        displayOrder: 1,
        featuredTitleOverride: 'Featured EEG',
      });

      const res = await request(app)
        .post('/api/v1/admin/moderation/popular/ds_301/publish')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ displayOrder: 1, featuredTitleOverride: 'Featured EEG' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('published');
      expect(AuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          adminId,
          action: 'dataset.publish',
          targetId: 'ds_301',
        })
      );
    });

    it('unpublishes a dataset by setting status = unpublished', async () => {
      const mockPopular = { datasetId: 'ds_301', status: 'published', save: jest.fn().mockResolvedValue({}) };
      PopularDataset.findOne.mockResolvedValue(mockPopular);

      const res = await request(app)
        .post('/api/v1/admin/moderation/popular/ds_301/unpublish')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(mockPopular.status).toBe('unpublished');
      expect(mockPopular.save).toHaveBeenCalled();
      expect(AuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          adminId,
          action: 'dataset.unpublish',
          targetId: 'ds_301',
        })
      );
    });

    it('reorders popular datasets via bulkWrite', async () => {
      PopularDataset.bulkWrite.mockResolvedValue({ modifiedCount: 2 });

      const res = await request(app)
        .put('/api/v1/admin/moderation/popular/reorder')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          items: [
            { datasetId: 'ds_301', displayOrder: 1 },
            { datasetId: 'ds_302', displayOrder: 2 },
          ],
        });

      expect(res.status).toBe(200);
      expect(PopularDataset.bulkWrite).toHaveBeenCalledWith([
        { updateOne: { filter: { datasetId: 'ds_301' }, update: { $set: { displayOrder: 1 } } } },
        { updateOne: { filter: { datasetId: 'ds_302' }, update: { $set: { displayOrder: 2 } } } },
      ]);
    });
  });

  // ─── 3. Archive & Restore ──────────────────────────────────────────────────

  describe('Archive & Restore APIs', () => {
    it('archives dataset (is_active = false) and sets PopularDataset status = archived', async () => {
      const mockDataset = { _id: 'ds_303', title: 'Study to Archive', is_active: true, save: jest.fn().mockResolvedValue({}) };
      Dataset.findOne.mockReturnValue({ then: (r) => r(mockDataset), lean: () => Promise.resolve(mockDataset) });
      PopularDataset.findOneAndUpdate.mockResolvedValue({});

      const res = await request(app)
        .post('/api/v1/admin/datasets/ds_303/archive')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(mockDataset.is_active).toBe(false);
      expect(mockDataset.save).toHaveBeenCalled();
      expect(PopularDataset.findOneAndUpdate).toHaveBeenCalledWith(
        { datasetId: 'ds_303' },
        { $set: { status: 'archived' } }
      );
      expect(AuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'dataset.archive', targetId: 'ds_303' })
      );
    });

    it('restores archived dataset (is_active = true) without auto-republishing PopularDataset', async () => {
      const mockDataset = { _id: 'ds_303', title: 'Archived Study', is_active: false, save: jest.fn().mockResolvedValue({}) };
      Dataset.findOne.mockReturnValue({ then: (r) => r(mockDataset), lean: () => Promise.resolve(mockDataset) });

      const res = await request(app)
        .post('/api/v1/admin/datasets/ds_303/restore')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(mockDataset.is_active).toBe(true);
      expect(mockDataset.save).toHaveBeenCalled();
      expect(AuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'dataset.restore', targetId: 'ds_303' })
      );
    });
  });

  // ─── 4. Safe Hard Delete ────────────────────────────────────────────────────

  describe('DELETE /api/v1/admin/datasets/:datasetId (Hard Delete)', () => {
    it('rejects hard delete if confirmationId does not match target datasetId exactly', async () => {
      const res = await request(app)
        .delete('/api/v1/admin/datasets/ds_999')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ confirmationId: 'wrong_id' });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('confirmationId must match target datasetId exactly');
      expect(Dataset.deleteOne).not.toHaveBeenCalled();
    });

    it('permanently purges dataset, reactions, overrides, popular curation, resolves feedback, and audits action', async () => {
      Dataset.findOne.mockReturnValue(makeQueryObj({ _id: 'ds_999', title: 'Target Purge Dataset', source: 'dandi' }));
      Dataset.deleteOne.mockResolvedValue({ deletedCount: 1 });
      DatasetReaction.deleteMany.mockResolvedValue({ deletedCount: 5 });
      AdminDatasetOverride.deleteOne.mockResolvedValue({ deletedCount: 1 });
      PopularDataset.deleteOne.mockResolvedValue({ deletedCount: 1 });

      const res = await request(app)
        .delete('/api/v1/admin/datasets/ds_999')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ confirmationId: 'ds_999' });

      expect(res.status).toBe(200);
      expect(DatasetReaction.deleteMany).toHaveBeenCalledWith({ datasetId: 'ds_999' }, expect.anything());
      expect(DatasetDislikeFeedback.updateMany).toHaveBeenCalledWith(
        { datasetId: 'ds_999' },
        { $set: expect.objectContaining({ status: 'resolved', adminNotes: 'Dataset permanently deleted' }) },
        expect.anything()
      );
      expect(AdminDatasetOverride.deleteOne).toHaveBeenCalledWith({ datasetId: 'ds_999' }, expect.anything());
      expect(PopularDataset.deleteOne).toHaveBeenCalledWith({ datasetId: 'ds_999' }, expect.anything());
      expect(AuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'dataset.delete_hard', targetId: 'ds_999' })
      );
    });
  });
});
