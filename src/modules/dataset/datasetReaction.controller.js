const DatasetReaction = require('./datasetReaction.model');
const { DatasetDislikeFeedback, VALID_REASONS } = require('./datasetDislikeFeedback.model');
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
 * Validate and normalise dislike feedback fields.
 * Returns { reason, comment } or throws ApiError.
 */
function validateFeedback(reason, comment) {
  if (!reason || typeof reason !== 'string') {
    throw new ApiError(400, 'reason is required when reaction is dislike.');
  }
  const trimmedReason = reason.trim();
  if (!VALID_REASONS.includes(trimmedReason)) {
    throw new ApiError(400, `Invalid reason. Must be one of: ${VALID_REASONS.join(', ')}.`);
  }
  let trimmedComment = null;
  if (comment !== undefined && comment !== null && comment !== '') {
    if (typeof comment !== 'string') {
      throw new ApiError(400, 'comment must be a string.');
    }
    trimmedComment = comment.trim();
    if (trimmedComment.length > 1000) {
      throw new ApiError(400, 'comment must not exceed 1000 characters.');
    }
    if (trimmedComment === '') trimmedComment = null;
  }
  if (trimmedReason === 'other' && !trimmedComment) {
    throw new ApiError(400, "comment is required when reason is 'other'.");
  }
  return { reason: trimmedReason, comment: trimmedComment };
}

/**
 * POST /datasets/reactions
 * Toggle or set a like/dislike reaction for a dataset.
 *
 * Extended in Phase 1 to accept optional `reason` + `comment` when
 * reaction === 'dislike'. All other paths are fully backward-compatible.
 *
 * Dislike feedback ordering (no Mongo transactions on M0):
 *   1. Validate feedback fields (fast, no DB)
 *   2. Update DatasetReaction (existing behaviour)
 *   3. Upsert DatasetDislikeFeedback
 *   4. Return summary
 *
 * If step 3 fails the reaction has already been written. We log the error
 * and return a partial success so the reaction count stays accurate. The
 * frontend will surface a non-blocking toast.
 */
const toggleReaction = asyncHandler(async (req, res) => {
  const { datasetId, reaction, anonKey, reason, comment } = req.body;

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

  // Phase 1: validate feedback upfront if this is a dislike, before touching DB
  let validatedFeedback = null;
  if (reaction === 'dislike' && (reason !== undefined || comment !== undefined)) {
    validatedFeedback = validateFeedback(reason, comment);
  }

  // ── Existing reaction toggle logic (unchanged) ────────────────────────────
  const query = { datasetId, ...userFilter };
  const existing = await DatasetReaction.findOne(query);
  // Capture before mutation so dismissed_by_user check remains correct after existing.save()
  const prevExistingReaction = existing?.reaction ?? null;

  let resultingReaction = reaction; // track what actually ended up stored

  if (reaction === 'none' || reaction === null) {
    if (existing) {
      await DatasetReaction.deleteOne({ _id: existing._id });
    }
    resultingReaction = null;
  } else if (existing) {
    if (existing.reaction === reaction) {
      // Toggle off — clicking same reaction removes it
      await DatasetReaction.deleteOne({ _id: existing._id });
      resultingReaction = null;
    } else {
      // Switch reaction (e.g. like → dislike or dislike → like)
      existing.reaction = reaction;
      await existing.save();
    }
  } else {
    // Create new reaction
    const docData = { datasetId, reaction, ...userFilter };
    await DatasetReaction.create(docData);
  }

  // ── Phase 1: handle dislike feedback side-effects ────────────────────────
  // Case 1: new dislike (or like→dislike) with feedback payload → upsert feedback
  if (resultingReaction === 'dislike' && validatedFeedback) {
    try {
      await DatasetDislikeFeedback.findOneAndUpdate(
        { datasetId, ...userFilter },
        {
          $set: {
            reason: validatedFeedback.reason,
            comment: validatedFeedback.comment,
            status: 'pending',
            adminNotes: null,
            resolvedBy: null,
            resolvedAt: null,
          },
        },
        { upsert: true, new: true }
      );
    } catch (feedbackErr) {
      // ponytail: feedback failure must not block the reaction response
      // The reaction is already committed; partial success is preferable to a
      // broken reaction count on the client.
      const logger = require('../../utils/logger');
      logger.error('toggleReaction: failed to upsert dislike feedback', {
        datasetId,
        err: feedbackErr.message,
      });
    }
  }

  // Case 2: user switched away from dislike (dislike→like or dislike→none)
  // Mark any existing pending feedback as dismissed_by_user to preserve history
  // but signal it no longer reflects an active dislike.
  if (resultingReaction !== 'dislike' && prevExistingReaction === 'dislike') {
    try {
      await DatasetDislikeFeedback.findOneAndUpdate(
        { datasetId, ...userFilter, status: 'pending' },
        { $set: { status: 'dismissed_by_user' } }
      );
    } catch (feedbackErr) {
      // fire-and-forget: same rationale as above
    }
  }

  const summary = await getReactionSummary(datasetId, userFilter);
  return new ApiResponse(200, summary, 'Reaction updated successfully.').send(res);
});

/**
 * POST /datasets/reactions/batch
 * Batch fetch reaction counts and user reactions for multiple dataset IDs in search results.
 * Unchanged in Phase 1.
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
