const QueryLog = require('./queryLog.model');
const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');

const getMyHistory = asyncHandler(async (req, res) => {
  const logs = await QueryLog.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(50);
  return new ApiResponse(200, logs).send(res);
});

module.exports = { getMyHistory };
