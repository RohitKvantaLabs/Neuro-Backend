const crypto = require('crypto');

/**
 * Phase 1 request correlation middleware.
 * Generates a fresh server-side UUID for every incoming HTTP request.
 * Never trusts a client-supplied X-Request-Id as the canonical ID.
 * Attaches to req.requestId and echoes as response header X-Request-Id.
 */
function requestIdMiddleware(req, res, next) {
  const id = crypto.randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  return next();
}

module.exports = requestIdMiddleware;
