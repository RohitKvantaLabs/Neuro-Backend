const { User } = require('../modules/user/user.model');
const ApiError = require('../utils/ApiError');

/**
 * �10.2 � Gates dashboard-facing routes.
 * Must run AFTER requireAuth (req.user already populated).
 * Hits DB once to read isOnboarded � kept out of the JWT payload
 * so the frontend does not need a token refresh after onboarding.
 */
async function requireOnboardingComplete(req, res, next) {
  try {
    const user = await User.findById(req.user.id).select('isOnboarded').lean();
    if (!user) return next(new ApiError(401, 'User not found.'));
    if (!user.isOnboarded) return next(new ApiError(403, 'Please complete your profile before accessing this feature.'));
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireOnboardingComplete };
