/**
 * Wrap every async controller with this. Any rejected promise / thrown
 * error inside gets forwarded to Express's error-handling middleware
 * (see middleware/errorHandler.js) instead of crashing the process or
 * requiring a try/catch in every single controller.
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
