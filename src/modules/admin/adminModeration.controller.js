const mongoose = require('mongoose');
const Dataset = require('../dataset/dataset.model');
const DatasetReaction = require('../dataset/datasetReaction.model');
const { DatasetDislikeFeedback, VALID_REASONS } = require('../dataset/datasetDislikeFeedback.model');
const { PopularDataset } = require('../dataset/popularDataset.model');
const { AdminDatasetOverride } = require('../dataset/adminDatasetOverride.model');
const ApiError = require('../../utils/ApiError');
const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');

/**
 * Helper to build dataset lookup dictionary for a list of string datasetIds.
 * Supports matching Mongo ObjectId string as well as custom source_id string.
 */
async function fetchDatasetMap(datasetIds) {
  if (!datasetIds || datasetIds.length === 0) return {};

  const objectIds = [];
  const stringIds = [];

  for (const id of datasetIds) {
    if (typeof id === 'string' && id.trim()) {
      const cleanId = id.trim();
      stringIds.push(cleanId);
      if (mongoose.Types.ObjectId.isValid(cleanId)) {
        objectIds.push(new mongoose.Types.ObjectId(cleanId));
      }
    }
  }

  const query = {
    $or: [
      { _id: { $in: objectIds } },
      { source_id: { $in: stringIds } },
    ],
  };

  const docs = await Dataset.find(query).lean();
  const map = {};

  docs.forEach((doc) => {
    const mongoIdStr = doc._id ? doc._id.toString() : null;
    if (mongoIdStr) map[mongoIdStr] = doc;
    if (doc.source_id) map[doc.source_id] = doc;
  });

  return map;
}

/**
 * GET /api/admin/moderation/popular-candidates
 * Aggregate datasets eligible for Popular Datasets curation.
 *
 * Rules:
 *   - Formula: Net Score = Likes - Dislikes
 *   - Eligibility: likes >= 3 AND netScore > 0
 *   - Excludes already-published datasets (PopularDataset status = published) and inactive/archived datasets.
 *   - Order: netScore DESC, likes DESC, datasetId ASC
 *   - Pagination: page (default 1), limit (default 30, max 50)
 */
const getPopularCandidates = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 30));
  const skip = (page - 1) * limit;

  // Fetch set of already published datasetIds and inactive datasetIds
  const [publishedDatasetIds, inactiveDatasetDocs] = await Promise.all([
    PopularDataset.distinct('datasetId', { status: 'published' }),
    Dataset.find({ is_active: false }).select('_id source_id').lean(),
  ]);

  const excludedIds = new Set(publishedDatasetIds);
  inactiveDatasetDocs.forEach((doc) => {
    if (doc._id) excludedIds.add(doc._id.toString());
    if (doc.source_id) excludedIds.add(doc.source_id);
  });

  const initialMatch = { reaction: { $in: ['like', 'dislike'] } };
  if (excludedIds.size > 0) {
    initialMatch.datasetId = { $nin: Array.from(excludedIds) };
  }

  // MongoDB Aggregation on datasetreactions
  const pipeline = [
    {
      $match: initialMatch,
    },
    {
      $group: {
        _id: '$datasetId',
        likes: {
          $sum: { $cond: [{ $eq: ['$reaction', 'like'] }, 1, 0] },
        },
        dislikes: {
          $sum: { $cond: [{ $eq: ['$reaction', 'dislike'] }, 1, 0] },
        },
      },
    },
    {
      $addFields: {
        netScore: { $subtract: ['$likes', '$dislikes'] },
      },
    },
    {
      $match: {
        likes: { $gte: 3 },
        netScore: { $gt: 0 },
      },
    },
    {
      $sort: { netScore: -1, likes: -1, _id: 1 },
    },
    {
      $facet: {
        totalCount: [{ $count: 'count' }],
        paginatedResults: [{ $skip: skip }, { $limit: limit }],
      },
    },
  ];

  const [aggResult] = await DatasetReaction.aggregate(pipeline);
  const total = aggResult.totalCount[0]?.count || 0;
  const rawItems = aggResult.paginatedResults || [];

  const datasetIds = rawItems.map((item) => item._id);
  const datasetMap = await fetchDatasetMap(datasetIds);

  const items = rawItems.map((item) => {
    const dId = item._id;
    const dataset = datasetMap[dId] || null;

    return {
      datasetId: dId,
      canonicalTitle: dataset?.title || 'Untitled dataset',
      repository: dataset?.source || 'unknown',
      modality: Array.isArray(dataset?.modality) ? dataset.modality : (dataset?.modality ? [dataset.modality] : []),
      likes: item.likes,
      dislikes: item.dislikes,
      netScore: item.netScore,
      description: dataset?.description || null,
      subjects: typeof dataset?.subject_count === 'number' ? dataset.subject_count : null,
      region: dataset?.region || null,
      species: Array.isArray(dataset?.species) ? dataset.species : [],
      ageGroup: dataset?.age_group || null,
      disease: dataset?.disease || null,
    };
  });

  const totalPages = Math.ceil(total / limit) || 1;

  return new ApiResponse(200, {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages,
    },
  }).send(res);
});

/**
 * GET /api/admin/moderation/dislike-queue
 * Dislike Review queue aggregation with filtering, top reasons, and pending count.
 *
 * Query Params:
 *   - reason: optional filter by dislike reason (validated against VALID_REASONS)
 *   - minDislikes: optional minimum dislikes count (default 1)
 *   - page: default 1
 *   - limit: default 30, max 50
 */
const getDislikeQueue = asyncHandler(async (req, res) => {
  const { reason } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 30));
  const minDislikes = Math.max(1, parseInt(req.query.minDislikes, 10) || 1);
  const skip = (page - 1) * limit;

  if (reason && !VALID_REASONS.includes(reason)) {
    throw new ApiError(400, `Invalid reason parameter. Allowed values: ${VALID_REASONS.join(', ')}`);
  }

  // If reason filter is supplied, get set of datasetIds that have feedback with this reason
  let targetDatasetIds = null;
  if (reason) {
    targetDatasetIds = await DatasetDislikeFeedback.distinct('datasetId', { reason });
    if (targetDatasetIds.length === 0) {
      return new ApiResponse(200, {
        items: [],
        pagination: { page, limit, total: 0, totalPages: 1 },
      }).send(res);
    }
  }

  const matchStage = { reaction: { $in: ['like', 'dislike'] } };
  if (targetDatasetIds) {
    matchStage.datasetId = { $in: targetDatasetIds };
  }

  const pipeline = [
    { $match: matchStage },
    {
      $group: {
        _id: '$datasetId',
        likes: { $sum: { $cond: [{ $eq: ['$reaction', 'like'] }, 1, 0] } },
        dislikes: { $sum: { $cond: [{ $eq: ['$reaction', 'dislike'] }, 1, 0] } },
      },
    },
    {
      $match: {
        dislikes: { $gte: minDislikes },
      },
    },
    {
      $addFields: {
        totalReactions: { $add: ['$likes', '$dislikes'] },
        netScore: { $subtract: ['$likes', '$dislikes'] },
      },
    },
    {
      $sort: { dislikes: -1, netScore: 1, _id: 1 },
    },
    {
      $facet: {
        totalCount: [{ $count: 'count' }],
        paginatedResults: [{ $skip: skip }, { $limit: limit }],
      },
    },
  ];

  const [aggResult] = await DatasetReaction.aggregate(pipeline);
  const total = aggResult.totalCount[0]?.count || 0;
  const rawItems = aggResult.paginatedResults || [];

  const datasetIds = rawItems.map((item) => item._id);
  const datasetMap = await fetchDatasetMap(datasetIds);

  // Fetch pending feedback counts & feedback reasons for these datasetIds
  const [pendingCounts, feedbackDocs] = await Promise.all([
    datasetIds.length > 0
      ? DatasetDislikeFeedback.aggregate([
          { $match: { datasetId: { $in: datasetIds }, status: 'pending' } },
          { $group: { _id: '$datasetId', count: { $sum: 1 } } },
        ])
      : [],
    datasetIds.length > 0
      ? DatasetDislikeFeedback.find({ datasetId: { $in: datasetIds } }).lean()
      : [],
  ]);

  const pendingMap = {};
  pendingCounts.forEach((p) => {
    pendingMap[p._id] = p.count;
  });

  const feedbackByDataset = {};
  feedbackDocs.forEach((f) => {
    if (!feedbackByDataset[f.datasetId]) feedbackByDataset[f.datasetId] = [];
    feedbackByDataset[f.datasetId].push(f);
  });

  const items = rawItems.map((item) => {
    const dId = item._id;
    const dataset = datasetMap[dId] || null;
    const totalRxn = item.totalReactions || 0;
    const dislikeRatio = totalRxn > 0 ? Number((item.dislikes / totalRxn).toFixed(4)) : 0;

    const feedbacks = feedbackByDataset[dId] || [];
    const reasonCounts = {};
    feedbacks.forEach((f) => {
      if (f.reason) {
        reasonCounts[f.reason] = (reasonCounts[f.reason] || 0) + 1;
      }
    });

    const totalFeedback = feedbacks.length;
    const topReasons = Object.entries(reasonCounts)
      .map(([r, count]) => ({
        reason: r,
        count,
        percentage: totalFeedback > 0 ? Number(((count / totalFeedback) * 100).toFixed(1)) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      datasetId: dId,
      canonicalTitle: dataset?.title || 'Unavailable dataset',
      likes: item.likes,
      dislikes: item.dislikes,
      totalReactions: totalRxn,
      dislikeRatio,
      netScore: item.netScore,
      topReasons,
      pendingFeedbackCount: pendingMap[dId] || 0,
    };
  });

  const totalPages = Math.ceil(total / limit) || 1;

  return new ApiResponse(200, {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages,
    },
  }).send(res);
});

/**
 * GET /api/admin/moderation/dislike-queue/:datasetId
 * Detail view for a dataset in the dislike review queue.
 */
const getDislikeDetail = asyncHandler(async (req, res) => {
  const { datasetId } = req.params;

  if (!datasetId || typeof datasetId !== 'string') {
    throw new ApiError(400, 'datasetId parameter is required.');
  }

  const cleanId = datasetId.trim();

  // Fetch dataset metadata, reactions, and feedback list
  const datasetMap = await fetchDatasetMap([cleanId]);
  const datasetDoc = datasetMap[cleanId] || null;

  const [likesCount, dislikesCount, feedbackDocs, overrideDoc] = await Promise.all([
    DatasetReaction.countDocuments({ datasetId: cleanId, reaction: 'like' }),
    DatasetReaction.countDocuments({ datasetId: cleanId, reaction: 'dislike' }),
    DatasetDislikeFeedback.find({ datasetId: cleanId }).sort({ createdAt: -1 }).lean(),
    AdminDatasetOverride.findOne({ datasetId: cleanId }).lean(),
  ]);

  if (!datasetDoc && likesCount === 0 && dislikesCount === 0 && feedbackDocs.length === 0) {
    throw new ApiError(404, 'Dataset moderation record not found.');
  }

  const totalReactions = likesCount + dislikesCount;
  const dislikeRatio = totalReactions > 0 ? Number((dislikesCount / totalReactions).toFixed(4)) : 0;
  const netScore = likesCount - dislikesCount;

  const feedbackList = feedbackDocs.map((f) => ({
    id: f._id.toString(),
    reason: f.reason,
    comment: f.comment || null,
    status: f.status,
    isAnonymous: !f.userId,
    createdAt: f.createdAt,
  }));

  const responseData = {
    dataset: {
      datasetId: cleanId,
      title: datasetDoc?.title || 'Unavailable dataset',
      source: datasetDoc?.source || 'unknown',
      modality: Array.isArray(datasetDoc?.modality) ? datasetDoc.modality : (datasetDoc?.modality ? [datasetDoc.modality] : []),
      species: Array.isArray(datasetDoc?.species) ? datasetDoc.species : [],
      description: datasetDoc?.description || null,
      region: datasetDoc?.region || null,
      disease: datasetDoc?.disease || null,
      ageGroup: datasetDoc?.age_group || null,
      subjectCount: typeof datasetDoc?.subject_count === 'number' ? datasetDoc.subject_count : null,
    },
    override: overrideDoc || null,
    reactionSummary: {
      likes: likesCount,
      dislikes: dislikesCount,
      totalReactions,
      dislikeRatio,
      netScore,
    },
    feedbackList,
  };

  return new ApiResponse(200, responseData).send(res);
});

/**
 * GET /api/admin/moderation/published
 * List currently published Popular datasets.
 */
const getPublishedCatalog = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 30));
  const skip = (page - 1) * limit;

  const [total, popularDocs] = await Promise.all([
    PopularDataset.countDocuments({ status: 'published' }),
    PopularDataset.find({ status: 'published' })
      .sort({ displayOrder: 1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  const datasetIds = popularDocs.map((doc) => doc.datasetId);
  const datasetMap = await fetchDatasetMap(datasetIds);

  const countsPipeline = [
    { $match: { datasetId: { $in: datasetIds } } },
    {
      $group: {
        _id: { datasetId: '$datasetId', reaction: '$reaction' },
        count: { $sum: 1 },
      },
    },
  ];
  const countsResult = datasetIds.length > 0 ? await DatasetReaction.aggregate(countsPipeline) : [];
  const reactionsMap = {};
  countsResult.forEach((item) => {
    const dId = item._id.datasetId;
    if (!reactionsMap[dId]) reactionsMap[dId] = { likes: 0, dislikes: 0 };
    if (item._id.reaction === 'like') reactionsMap[dId].likes = item.count;
    if (item._id.reaction === 'dislike') reactionsMap[dId].dislikes = item.count;
  });

  const items = popularDocs.map((doc) => {
    const dId = doc.datasetId;
    const dataset = datasetMap[dId] || null;
    const rxn = reactionsMap[dId] || { likes: 0, dislikes: 0 };

    return {
      datasetId: dId,
      canonicalTitle: doc.featuredTitleOverride || dataset?.title || 'Untitled dataset',
      featuredTitleOverride: doc.featuredTitleOverride || null,
      repository: dataset?.source || 'unknown',
      status: doc.status,
      displayOrder: doc.displayOrder,
      publishedAt: doc.publishedAt,
      publishedBy: doc.publishedBy,
      likes: rxn.likes,
      dislikes: rxn.dislikes,
      isActive: dataset?.is_active !== false,
    };
  });

  const totalPages = Math.ceil(total / limit) || 1;

  return new ApiResponse(200, {
    items,
    pagination: { page, limit, total, totalPages },
  }).send(res);
});

module.exports = {
  getPopularCandidates,
  getDislikeQueue,
  getDislikeDetail,
  getPublishedCatalog,
};
