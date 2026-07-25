const crypto = require('crypto');
const env = require('../config/env.config');
const ApiError = require('../utils/ApiError');

/** Authenticate the external email provider without granting admin access. */
function requireTicketIngestSecret(req, res, next) {
  const configuredSecret = env.ticketIngestSecret;
  const suppliedSecret = req.get('X-Ticket-Ingest-Secret');

  // Fail closed: an accidentally undeployed secret must not expose the route.
  if (!configuredSecret) return next(new ApiError(503, 'Ticket ingestion is not configured.'));
  if (!suppliedSecret) return next(new ApiError(401, 'Ticket ingestion authentication is required.'));

  const expected = Buffer.from(configuredSecret);
  const supplied = Buffer.from(suppliedSecret);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    return next(new ApiError(401, 'Invalid ticket ingestion credentials.'));
  }
  return next();
}

module.exports = requireTicketIngestSecret;
