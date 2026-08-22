const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/config/db.config', () => jest.fn().mockResolvedValue());

const app = require('../src/app');
const DatasetReaction = require('../src/modules/dataset/datasetReaction.model');
const { DatasetDislikeFeedback } = require('../src/modules/dataset/datasetDislikeFeedback.model');

jest.mock('../src/modules/dataset/datasetReaction.model');
jest.mock('../src/modules/dataset/datasetDislikeFeedback.model', () => {
  const findOneAndUpdateMock = jest.fn().mockResolvedValue({});
  const MockModel = {
    findOneAndUpdate: findOneAndUpdateMock,
  };
  return { DatasetDislikeFeedback: MockModel, VALID_REASONS: [
    'metadata_incorrect', 'data_incomplete', 'quality_concern', 'duplicate',
    'broken_link', 'wrong_modality_disease', 'irrelevant', 'other',
  ]};
});

describe('Dataset Reaction API — Phase 1 (Reactions + Dislike Feedback)', () => {
  const userId = '507f1f77bcf86cd799439011';
  const token = jwt.sign({ id: userId, role: 'user' }, process.env.JWT_ACCESS_SECRET || 'test_secret', {
    expiresIn: '15m',
  });

  const makeQueryObj = (val) => ({
    lean: jest.fn().mockResolvedValue(val),
    then: (resolve) => resolve(val),
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── Existing Reaction Behaviour (must remain unchanged) ─────────────────

  describe('POST /api/v1/datasets/reactions — existing behaviour', () => {
    it('allows a registered user to set a like reaction', async () => {
      const createdDoc = { datasetId: 'ds_001', userId, reaction: 'like' };
      // First findOne: existing=null (new reaction). Second findOne (in getReactionSummary): returns created doc.
      DatasetReaction.findOne
        .mockReturnValueOnce(makeQueryObj(null))
        .mockReturnValueOnce(makeQueryObj(createdDoc));
      DatasetReaction.create.mockResolvedValue(createdDoc);
      DatasetReaction.countDocuments.mockImplementation((filter) => {
        if (filter.reaction === 'like') return Promise.resolve(1);
        return Promise.resolve(0);
      });

      const res = await request(app)
        .post('/api/v1/datasets/reactions')
        .set('Authorization', `Bearer ${token}`)
        .send({ datasetId: 'ds_001', reaction: 'like' });

      expect(res.status).toBe(200);
      expect(res.body.data.likes).toBe(1);
      expect(res.body.data.dislikes).toBe(0);
      expect(res.body.data.userReaction).toBe('like');
      // No feedback upsert on like
      expect(DatasetDislikeFeedback.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('toggles reaction off when user submits the same reaction twice', async () => {
      const mockDoc = { _id: 'reaction_1', datasetId: 'ds_001', userId, reaction: 'like' };
      DatasetReaction.findOne
        .mockReturnValueOnce(makeQueryObj(mockDoc))
        .mockReturnValueOnce(makeQueryObj(null));
      DatasetReaction.deleteOne.mockResolvedValue({ deletedCount: 1 });
      DatasetReaction.countDocuments.mockResolvedValue(0);

      const res = await request(app)
        .post('/api/v1/datasets/reactions')
        .set('Authorization', `Bearer ${token}`)
        .send({ datasetId: 'ds_001', reaction: 'like' });

      expect(res.status).toBe(200);
      expect(DatasetReaction.deleteOne).toHaveBeenCalledWith({ _id: 'reaction_1' });
      expect(res.body.data.userReaction).toBe(null);
    });

    it('allows anonymous users to react using an anonKey (no feedback)', async () => {
      const mockCreated = { datasetId: 'ds_002', anonKey: 'anon_123', reaction: 'dislike' };
      DatasetReaction.findOne
        .mockReturnValueOnce(makeQueryObj(null))
        .mockReturnValueOnce(makeQueryObj(mockCreated));
      DatasetReaction.create.mockResolvedValue(mockCreated);
      DatasetReaction.countDocuments.mockImplementation((filter) => {
        if (filter.reaction === 'dislike') return Promise.resolve(1);
        return Promise.resolve(0);
      });

      const res = await request(app)
        .post('/api/v1/datasets/reactions')
        .send({ datasetId: 'ds_002', reaction: 'dislike', anonKey: 'anon_123' });

      expect(res.status).toBe(200);
      expect(res.body.data.dislikes).toBe(1);
      // No feedback payload sent → no upsert
      expect(DatasetDislikeFeedback.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('removes reaction when reaction is none', async () => {
      const mockDoc = { _id: 'reaction_2', datasetId: 'ds_001', userId, reaction: 'dislike' };
      DatasetReaction.findOne.mockReturnValue(makeQueryObj(mockDoc));
      DatasetReaction.deleteOne.mockResolvedValue({ deletedCount: 1 });
      DatasetReaction.countDocuments.mockResolvedValue(0);

      const res = await request(app)
        .post('/api/v1/datasets/reactions')
        .set('Authorization', `Bearer ${token}`)
        .send({ datasetId: 'ds_001', reaction: 'none' });

      expect(res.status).toBe(200);
      expect(DatasetReaction.deleteOne).toHaveBeenCalledWith({ _id: 'reaction_2' });
    });
  });

  // ─── Phase 1: Dislike Feedback ────────────────────────────────────────────

  describe('POST /api/v1/datasets/reactions — dislike with feedback', () => {
    it('creates reaction and upserts feedback on valid dislike with reason', async () => {
      DatasetReaction.findOne.mockReturnValue(makeQueryObj(null));
      DatasetReaction.create.mockResolvedValue({ datasetId: 'ds_010', userId, reaction: 'dislike' });
      DatasetReaction.countDocuments.mockImplementation((filter) => {
        if (filter.reaction === 'dislike') return Promise.resolve(1);
        return Promise.resolve(0);
      });

      const res = await request(app)
        .post('/api/v1/datasets/reactions')
        .set('Authorization', `Bearer ${token}`)
        .send({ datasetId: 'ds_010', reaction: 'dislike', reason: 'metadata_incorrect' });

      expect(res.status).toBe(200);
      expect(res.body.data.dislikes).toBe(1);
      expect(DatasetDislikeFeedback.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ datasetId: 'ds_010' }),
        expect.objectContaining({ $set: expect.objectContaining({ reason: 'metadata_incorrect', status: 'pending' }) }),
        { upsert: true, new: true }
      );
    });

    it('accepts optional comment with valid reason', async () => {
      DatasetReaction.findOne.mockReturnValue(makeQueryObj(null));
      DatasetReaction.create.mockResolvedValue({});
      DatasetReaction.countDocuments.mockResolvedValue(0);

      const res = await request(app)
        .post('/api/v1/datasets/reactions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          datasetId: 'ds_011',
          reaction: 'dislike',
          reason: 'quality_concern',
          comment: 'Missing hemisphere data in files 3–7.',
        });

      expect(res.status).toBe(200);
      expect(DatasetDislikeFeedback.findOneAndUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          $set: expect.objectContaining({ comment: 'Missing hemisphere data in files 3–7.' }),
        }),
        expect.anything()
      );
    });

    it('rejects dislike with invalid reason id', async () => {
      const res = await request(app)
        .post('/api/v1/datasets/reactions')
        .set('Authorization', `Bearer ${token}`)
        .send({ datasetId: 'ds_012', reaction: 'dislike', reason: 'bad_category' });

      expect(res.status).toBe(400);
      // Reaction should NOT have been written
      expect(DatasetReaction.create).not.toHaveBeenCalled();
    });

    it('rejects "other" reason with no comment', async () => {
      const res = await request(app)
        .post('/api/v1/datasets/reactions')
        .set('Authorization', `Bearer ${token}`)
        .send({ datasetId: 'ds_013', reaction: 'dislike', reason: 'other' });

      expect(res.status).toBe(400);
      expect(DatasetReaction.create).not.toHaveBeenCalled();
    });

    it('accepts "other" reason when comment is provided', async () => {
      DatasetReaction.findOne.mockReturnValue(makeQueryObj(null));
      DatasetReaction.create.mockResolvedValue({});
      DatasetReaction.countDocuments.mockResolvedValue(0);

      const res = await request(app)
        .post('/api/v1/datasets/reactions')
        .set('Authorization', `Bearer ${token}`)
        .send({ datasetId: 'ds_013', reaction: 'dislike', reason: 'other', comment: 'Data description is in Dutch only.' });

      expect(res.status).toBe(200);
    });

    it('rejects comment exceeding 1000 characters', async () => {
      const res = await request(app)
        .post('/api/v1/datasets/reactions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          datasetId: 'ds_014',
          reaction: 'dislike',
          reason: 'data_incomplete',
          comment: 'x'.repeat(1001),
        });

      expect(res.status).toBe(400);
    });

    it('does not require feedback when reason is omitted on dislike', async () => {
      // Backward-compatible path: existing clients send dislike with no reason
      DatasetReaction.findOne.mockReturnValue(makeQueryObj(null));
      DatasetReaction.create.mockResolvedValue({});
      DatasetReaction.countDocuments.mockResolvedValue(0);

      const res = await request(app)
        .post('/api/v1/datasets/reactions')
        .set('Authorization', `Bearer ${token}`)
        .send({ datasetId: 'ds_015', reaction: 'dislike' });

      expect(res.status).toBe(200);
      expect(DatasetDislikeFeedback.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  // ─── Phase 1: Feedback State Transitions ─────────────────────────────────

  describe('Feedback status on reaction change', () => {
    it('marks pending feedback as dismissed_by_user when dislike switches to like', async () => {
      // Existing doc has reaction: 'dislike' — user now sends reaction: 'like'
      const existingDislike = {
        _id: 'rxn_3',
        datasetId: 'ds_020',
        userId,
        reaction: 'dislike',
        save: jest.fn().mockResolvedValue({}),
      };
      // First findOne call (existence check) → returns existing dislike doc
      // Second findOne call (getReactionSummary) → returns updated doc with reaction: 'like'
      DatasetReaction.findOne
        .mockReturnValueOnce({ then: (resolve) => resolve(existingDislike), lean: () => Promise.resolve(existingDislike) })
        .mockReturnValueOnce(makeQueryObj({ ...existingDislike, reaction: 'like' }));
      DatasetReaction.countDocuments.mockResolvedValue(0);

      await request(app)
        .post('/api/v1/datasets/reactions')
        .set('Authorization', `Bearer ${token}`)
        .send({ datasetId: 'ds_020', reaction: 'like' });

      expect(DatasetDislikeFeedback.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ datasetId: 'ds_020', status: 'pending' }),
        { $set: { status: 'dismissed_by_user' } }
      );
    });
  });

  // ─── Batch API unchanged ─────────────────────────────────────────────────

  describe('POST /api/v1/datasets/reactions/batch', () => {
    it('returns reaction map for requested dataset IDs', async () => {
      DatasetReaction.aggregate.mockResolvedValue([
        { _id: { datasetId: 'ds_001', reaction: 'like' }, count: 5 },
        { _id: { datasetId: 'ds_001', reaction: 'dislike' }, count: 1 },
        { _id: { datasetId: 'ds_002', reaction: 'dislike' }, count: 3 },
      ]);

      DatasetReaction.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { datasetId: 'ds_001', reaction: 'like' },
        ]),
      });

      const res = await request(app)
        .post('/api/v1/datasets/reactions/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({ datasetIds: ['ds_001', 'ds_002'] });

      expect(res.status).toBe(200);
      expect(res.body.data.ds_001).toEqual({ datasetId: 'ds_001', likes: 5, dislikes: 1, userReaction: 'like' });
      expect(res.body.data.ds_002).toEqual({ datasetId: 'ds_002', likes: 0, dislikes: 3, userReaction: null });
    });
  });
});
