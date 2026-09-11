const QueryLog = require('./queryLog.model');
const SearchFeedback = require('./searchFeedback.model');
const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const ApiError = require('../../utils/ApiError');

const getMyHistory = asyncHandler(async (req, res) => {
  const logs = await QueryLog.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(50);
  return new ApiResponse(200, logs).send(res);
});

const submitSearchFeedback = asyncHandler(async (req, res) => {
  const { query, filters, rating, reasons, comment, resultCount, anonKey } = req.body;
  if (!query || typeof query !== 'string') {
    throw new ApiError(400, 'Search query is required.');
  }

  if (!['good', 'bad', 'none'].includes(rating)) {
    throw new ApiError(400, 'Invalid rating value.');
  }

  const userId = req.user ? req.user.id : null;

  const feedback = await SearchFeedback.create({
    userId,
    anonKey: anonKey || null,
    query: query.trim(),
    filters: filters || {},
    rating,
    reasons: Array.isArray(reasons) ? reasons : [],
    comment: comment ? String(comment).trim() : null,
    resultCount: typeof resultCount === 'number' ? resultCount : 0,
  });

  return new ApiResponse(201, { success: true, feedback }).send(res);
});

module.exports = { getMyHistory, submitSearchFeedback };
