const ApiError = require('../../utils/ApiError');
const { verifyAccessToken } = require('./auth.service');

/**
 * Verifies the access token from the Authorization header, attaches the
 * decoded payload to req.user. Does NOT hit the database — the token
 * payload itself carries id + role, kept intentionally minimal.
 *
 * §10.2: Full tokens are issued immediately after verification/login.
 * Scope-restricted tokens no longer exist — requireOnboardingScope removed.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(new ApiError(401, 'Missing or malformed Authorization header.'));
  }

  const token = header.split(' ')[1];
  try {
    const decoded = verifyAccessToken(token);
    req.user = decoded; // { id, role, iat, exp }
    return next();
  } catch (err) {
    return next(new ApiError(401, 'Invalid or expired access token.'));
  }
}

/**
 * Must run AFTER requireAuth. Checks the role embedded in the token.
 * NOTE: this checks the JWT's role claim, not a fresh DB lookup — if an
 * admin is demoted mid-session, their existing access token remains
 * valid until it expires (kept short-lived — see JWT_ACCESS_EXPIRES_IN —
 * specifically to bound this window).
 */
function requireAdmin(req, res, next) {
  if (!req.user) {
    return next(new ApiError(401, 'Authentication required.'));
  }
  if (req.user.role !== 'admin') {
    return next(new ApiError(403, 'Admin access required.'));
  }
  return next();
}

module.exports = { requireAuth, requireAdmin };
