const logger = require('../utils/logger');

// Must be mounted LAST in app.js, after all routes.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Normalise Mongoose CastError (bad ObjectId) to a 400 — never expose raw Mongoose messages
  if (err.name === 'CastError') {
    return res.status(400).json({ success: false, message: 'Invalid ID format.' });
  }

  // Mongoose / MongoDB duplicate-key (E11000) → 409 Conflict
  if (err.code === 11000) {
    return res.status(409).json({ success: false, message: 'A record with that value already exists.' });
  }

  const statusCode = err.statusCode || (err.isApiError ? err.statusCode : 500);
  const message = err.message || 'Internal server error';

  if (statusCode >= 500) {
    logger.error(`${req.method} ${req.originalUrl} -> ${statusCode}: ${err.stack || err.message}`);
  } else {
    logger.warn(`${req.method} ${req.originalUrl} -> ${statusCode}: ${err.message}`);
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(err.details ? { details: err.details } : {}),
  });
}

module.exports = errorHandler;
