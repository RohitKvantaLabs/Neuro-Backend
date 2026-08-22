const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/config/db.config', () => jest.fn().mockResolvedValue());

const app = require('../src/app');
const Dataset = require('../src/modules/dataset/dataset.model');
const { AdminDatasetOverride } = require('../src/modules/dataset/adminDatasetOverride.model');
const { PopularDataset } = require('../src/modules/dataset/popularDataset.model');
const AuditLog = require('../src/modules/admin/auditLog.model');

jest.mock('../src/modules/admin/auditLog.model', () => ({
  create: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/modules/dataset/dataset.model');
jest.mock('../src/modules/dataset/adminDatasetOverride.model', () => {
  const actual = jest.requireActual('../src/modules/dataset/adminDatasetOverride.model');
  return {
    AdminDatasetOverride: {
      findOneAndUpdate: jest.fn(),
      find: jest.fn(),
    },
    ALLOWED_OVERRIDE_FIELDS: actual.ALLOWED_OVERRIDE_FIELDS,
  };
});
jest.mock('../src/modules/dataset/popularDataset.model', () => {
  const actual = jest.requireActual('../src/modules/dataset/popularDataset.model');
  return {
    PopularDataset: {
      find: jest.fn(),
      findOneAndUpdate: jest.fn(),
    },
    POPULAR_STATUSES: actual.POPULAR_STATUSES,
  };
});

function makeQueryObj(val) {
  return {
    lean: jest.fn().mockResolvedValue(val),
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    then: (resolve) => resolve(val),
  };
}

describe('Manual Featured Dataset Selection Workflow — Phase 6 Addition', () => {
  const adminId = '507f1f77bcf86cd799439099';
  const userId = '507f1f77bcf86cd799439011';

  const adminToken = jwt.sign(
    { id: adminId, role: 'admin' },
    process.env.JWT_ACCESS_SECRET || 'test_secret',
    { expiresIn: '1h' }
  );

  const userToken = jwt.sign(
    { id: userId, role: 'user' },
    process.env.JWT_ACCESS_SECRET || 'test_secret',
    { expiresIn: '1h' }
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('Test 1 — Admin dataset lookup: Admin can search active canonical datasets', async () => {
    const canonicalDocs = [
      { _id: 'ds_man_1', source: 'OpenNeuro', source_id: 'ds_man_1', title: 'Resting fMRI ADHD', is_active: true },
      { _id: 'ds_man_2', source: 'ADNI', source_id: 'ds_man_2', title: 'Alzheimer MRI Cohort', is_active: true },
    ];
    Dataset.countDocuments.mockResolvedValue(2);
    Dataset.find.mockReturnValue(makeQueryObj(canonicalDocs));
    PopularDataset.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([{ datasetId: 'ds_man_2', status: 'published' }]) });

    const res = await request(app)
      .get('/api/v1/admin/moderation/datasets/search?q=fMRI')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.items.length).toBe(2);
    expect(res.body.data.items[0].datasetId).toBe('ds_man_1');
    expect(res.body.data.items[0].isPublished).toBe(false);
    expect(res.body.data.items[1].isPublished).toBe(true);
  });

  it('Test 2 — Authorization: Non-admin cannot use the admin selector API', async () => {
    const res = await request(app)
      .get('/api/v1/admin/moderation/datasets/search?q=fMRI')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(403);
  });

  it('Test 3 & 4 — Zero-reaction dataset can be published as Featured by Admin', async () => {
    const doc = { _id: 'ds_zero_rxn', title: 'Zero Reaction Dataset', is_active: true };
    Dataset.findById.mockReturnValue(makeQueryObj(doc));
    Dataset.findOne.mockReturnValue(makeQueryObj(doc));
    PopularDataset.findOneAndUpdate.mockResolvedValue({
      datasetId: 'ds_zero_rxn',
      status: 'published',
      displayOrder: 1,
    });

    const res = await request(app)
      .post('/api/v1/admin/moderation/popular/ds_zero_rxn/publish')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ displayOrder: 1 });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('published');
    expect(res.body.data.displayOrder).toBe(1);
  });

  it('Test 5 & 6 — Archived / inactive dataset cannot be manually published as Featured', async () => {
    const doc = { _id: 'ds_archived', title: 'Archived Dataset', is_active: false };
    Dataset.findById.mockReturnValue(makeQueryObj(doc));
    Dataset.findOne.mockReturnValue(makeQueryObj(doc));

    const res = await request(app)
      .post('/api/v1/admin/moderation/popular/ds_archived/publish')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ displayOrder: 1 });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Archived datasets cannot be published/i);
  });

  it('Test 7 & 8 — Display order & Metadata Overrides are saved and visible upon publication', async () => {
    const doc = { _id: 'ds_override_test', title: 'Canonical Title', is_active: true };
    Dataset.findById.mockReturnValue(makeQueryObj(doc));
    Dataset.findOne.mockReturnValue(makeQueryObj(doc));
    AdminDatasetOverride.findOneAndUpdate.mockResolvedValue({
      datasetId: 'ds_override_test',
      title: 'Curated Title Headline',
      disease: 'Alzheimers',
    });
    PopularDataset.findOneAndUpdate.mockResolvedValue({
      datasetId: 'ds_override_test',
      status: 'published',
      displayOrder: 3,
      featuredTitleOverride: 'Spotlight Dataset',
    });

    // 1. Save metadata override
    const overrideRes = await request(app)
      .patch('/api/v1/admin/datasets/ds_override_test/override')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Curated Title Headline', disease: 'Alzheimers' });

    expect(overrideRes.status).toBe(200);
    expect(overrideRes.body.data.title).toBe('Curated Title Headline');

    // 2. Publish to popular with displayOrder = 3
    const pubRes = await request(app)
      .post('/api/v1/admin/moderation/popular/ds_override_test/publish')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ displayOrder: 3, featuredTitleOverride: 'Spotlight Dataset' });

    expect(pubRes.status).toBe(200);
    expect(pubRes.body.data.displayOrder).toBe(3);
  });

  it('Test 9 & 10 — Manually published dataset appears in public API and strictly obeys 6-card limit', async () => {
    const rawPopular = Array.from({ length: 7 }, (_, i) => ({
      datasetId: `ds_pub_${i + 1}`,
      status: 'published',
      displayOrder: i + 1,
    }));

    PopularDataset.find.mockReturnValue(makeQueryObj(rawPopular.slice(0, 6)));

    const canonicalDocs = rawPopular.slice(0, 6).map((d) => ({
      _id: d.datasetId,
      source: 'OpenNeuro',
      title: `Dataset ${d.datasetId}`,
      is_active: true,
    }));
    Dataset.find.mockReturnValue(makeQueryObj(canonicalDocs));
    AdminDatasetOverride.find.mockReturnValue(makeQueryObj([]));

    const res = await request(app).get('/api/v1/datasets/popular');

    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBe(6);
    expect(res.body.data.items[0].datasetId).toBe('ds_pub_1');
    expect(res.body.data.items[5].datasetId).toBe('ds_pub_6');
  });
});
