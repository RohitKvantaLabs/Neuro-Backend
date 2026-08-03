const DatasetReaction = require('./datasetReaction.model');
const ApiError = require('../../utils/ApiError');
const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');

/**
 * Helper to build the user identification filter (userId or anonKey)
 */
function buildUserFilter(req, anonKey) {
  if (req.user?.id) {
    return { userId: req.user.id };
  }
  if (anonKey && typeof anonKey === 'string' && anonKey.trim()) {
    return { anonKey: anonKey.trim() };
  }
  return null;
}

/**
 * Helper to compute likes, dislikes, and current user reaction for a single dataset.
 */
async function getReactionSummary(datasetId, userFilter) {
  const [likesCount, dislikesCount, userDoc] = await Promise.all([
    DatasetReaction.countDocuments({ datasetId, reaction: 'like' }),
    DatasetReaction.countDocuments({ datasetId, reaction: 'dislike' }),
    userFilter ? DatasetReaction.findOne({ datasetId, ...userFilter }).lean() : null,
  ]);

  return {
    datasetId,
    likes: likesCount,
    dislikes: dislikesCount,
    userReaction: userDoc ? userDoc.reaction : null,
  };
}

/**
 * POST /datasets/reactions
 * Toggle or set a like/dislike reaction for a dataset by its serial number / ID.
 */
const toggleReaction = asyncHandler(async (req, res) => {
  const { datasetId, reaction, anonKey } = req.body;

  if (!datasetId || typeof datasetId !== 'string') {
    throw new ApiError(400, 'datasetId string is required.');
  }

  const validReactions = ['like', 'dislike', 'none', null];
  if (reaction !== undefined && !validReactions.includes(reaction)) {
    throw new ApiError(400, "reaction must be 'like', 'dislike', or null/'none'.");
  }

  const userFilter = buildUserFilter(req, anonKey);
  if (!userFilter) {
    throw new ApiError(400, 'User authentication or an anonymous client key is required to react.');
  }

  const query = { datasetId, ...userFilter };
  const existing = await DatasetReaction.findOne(query);

  if (reaction === 'none' || reaction === null) {
    if (existing) {
      await DatasetReaction.deleteOne({ _id: existing._id });
    }
  } else if (existing) {
    if (existing.reaction === reaction) {
      // Toggle off if clicking the same reaction
      await DatasetReaction.deleteOne({ _id: existing._id });
    } else {
      // Switch reaction (e.g. like -> dislike)
      existing.reaction = reaction;
      await existing.save();
    }
  } else {
    // Create new reaction
    const docData = { datasetId, reaction, ...userFilter };
    await DatasetReaction.create(docData);
  }

  const summary = await getReactionSummary(datasetId, userFilter);
  return new ApiResponse(200, summary, 'Reaction updated successfully.').send(res);
});

/**
 * POST /datasets/reactions/batch
 * Batch fetch reaction counts and user reactions for multiple dataset IDs in search results.
 */
const getReactionsBatch = asyncHandler(async (req, res) => {
  const { datasetIds, anonKey } = req.body;

  if (!Array.isArray(datasetIds)) {
    throw new ApiError(400, 'datasetIds array is required.');
  }

  const cleanIds = datasetIds.filter((id) => typeof id === 'string' && id.trim());
  if (cleanIds.length === 0) {
    return new ApiResponse(200, {}).send(res);
  }

  const userFilter = buildUserFilter(req, anonKey);

  // Group counts by datasetId and reaction type
  const countsPipeline = [
    { $match: { datasetId: { $in: cleanIds } } },
    {
      $group: {
        _id: { datasetId: '$datasetId', reaction: '$reaction' },
        count: { $sum: 1 },
      },
    },
  ];

  const countsResult = await DatasetReaction.aggregate(countsPipeline);

  // Fetch current user reactions for these datasetIds
  let userReactionsMap = {};
  if (userFilter) {
    const userDocs = await DatasetReaction.find({
      datasetId: { $in: cleanIds },
      ...userFilter,
    }).lean();

    userDocs.forEach((doc) => {
      userReactionsMap[doc.datasetId] = doc.reaction;
    });
  }

  // Construct response map
  const resultMap = {};
  cleanIds.forEach((id) => {
    resultMap[id] = {
      datasetId: id,
      likes: 0,
      dislikes: 0,
      userReaction: userReactionsMap[id] || null,
    };
  });

  countsResult.forEach((item) => {
    const dId = item._id.datasetId;
    const rType = item._id.reaction;
    if (resultMap[dId]) {
      if (rType === 'like') resultMap[dId].likes = item.count;
      if (rType === 'dislike') resultMap[dId].dislikes = item.count;
    }
  });

  return new ApiResponse(200, resultMap).send(res);
});

module.exports = { toggleReaction, getReactionsBatch };
