const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/config/db.config', () => jest.fn().mockResolvedValue());

const app = require('../src/app');
const DatasetReaction = require('../src/modules/dataset/datasetReaction.model');

jest.mock('../src/modules/dataset/datasetReaction.model');

describe('Dataset Reaction API', () => {
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

  describe('POST /api/v1/datasets/reactions', () => {
    it('allows a registered user to set a like reaction for a dataset ID', async () => {
      DatasetReaction.findOne.mockReturnValue(makeQueryObj(null));
      DatasetReaction.create.mockResolvedValue({ datasetId: 'ds_001', userId, reaction: 'like' });
      DatasetReaction.countDocuments.mockImplementation((filter) => {
        if (filter.reaction === 'like') return Promise.resolve(1);
        if (filter.reaction === 'dislike') return Promise.resolve(0);
        return Promise.resolve(0);
      });

      const res = await request(app)
        .post('/api/v1/datasets/reactions')
        .set('Authorization', `Bearer ${token}`)
        .send({ datasetId: 'ds_001', reaction: 'like' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.datasetId).toBe('ds_001');
      expect(res.body.data.likes).toBe(1);
      expect(res.body.data.dislikes).toBe(0);
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

    it('allows anonymous users to react using an anonKey', async () => {
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
    });
  });

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
      expect(res.body.success).toBe(true);
      expect(res.body.data.ds_001).toEqual({
        datasetId: 'ds_001',
        likes: 5,
        dislikes: 1,
        userReaction: 'like',
      });
      expect(res.body.data.ds_002).toEqual({
        datasetId: 'ds_002',
        likes: 0,
        dislikes: 3,
        userReaction: null,
      });
    });
  });
});
