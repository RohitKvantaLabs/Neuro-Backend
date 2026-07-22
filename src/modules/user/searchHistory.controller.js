const SearchHistory = require('./searchHistory.model');
const ApiError = require('../../utils/ApiError');
const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');

// GET /users/search-history — most recent first, limit 30
const listHistory = asyncHandler(async (req, res) => {
  const items = await SearchHistory.find({ userId: req.user.id })
    .sort({ createdAt: -1 })
    .limit(30)
    .lean();
  return new ApiResponse(200, items).send(res);
});

// DELETE /users/search-history — clear all
const clearHistory = asyncHandler(async (req, res) => {
  await SearchHistory.deleteMany({ userId: req.user.id });
  return new ApiResponse(200, null, 'Search history cleared.').send(res);
});

// DELETE /users/search-history/:id
const deleteHistoryItem = asyncHandler(async (req, res) => {
  const doc = await SearchHistory.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
  if (!doc) throw new ApiError(404, 'History item not found.');
  return new ApiResponse(200, null, 'History item deleted.').send(res);
});

module.exports = { listHistory, clearHistory, deleteHistoryItem };
