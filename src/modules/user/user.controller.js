const { User } = require('./user.model');
const ApiError = require('../../utils/ApiError');
const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const { validateEmail } = require('../../utils/emailValidator');
const { OTP_PURPOSES, generateOtp, hashOtp, compareOtp } = require('../../utils/otp.util');
const { sendOtpEmail } = require('../../utils/mailer');
const { verifyGoogleIdToken } = require('../auth/google.service');
const env = require('../../config/env.config');
const {
  registerSchema,
  loginSchema,
  verifyOtpSchema,
  resendOtpSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  completeOnboardingSchema,
  updateMeSchema,
  updateNotificationsSchema,
} = require('./user.validation');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_OPTIONS,
} = require('../auth/auth.service');

// ─── helpers ──────────────────────────────────────────────────────────────────

function otpExpiryDate(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000);
}

async function issueAndSendOtp(user, purpose, expiryMinutes) {
  const otp = generateOtp();
  user.otp = await hashOtp(otp);
  user.otpExpires = otpExpiryDate(expiryMinutes);
  user.otpPurpose = purpose;
  await user.save();
  await sendOtpEmail(user.email, otp, purpose);
}

// §10.2: Issues a full access + refresh token pair. No scoped tokens.
function issueFullTokens(res, user) {
  const payload = { id: user._id.toString(), role: 'user' };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, REFRESH_COOKIE_OPTIONS);
  return { accessToken, user: { id: user._id, name: user.name, email: user.email, isOnboarded: user.isOnboarded, isLegacyUser: user.isLegacyUser } };
}

// ─── controllers ──────────────────────────────────────────────────────────────

const register = asyncHandler(async (req, res) => {
  const { error, value } = registerSchema.validate(req.body);
  if (error) throw new ApiError(400, error.details[0].message);

  const emailCheck = await validateEmail(value.email);
  if (!emailCheck.valid) throw new ApiError(400, emailCheck.reason);

  const existing = await User.findOne({ email: value.email });
  if (existing) throw new ApiError(409, 'An account with this email already exists.');

  const phoneCount = await User.countDocuments({ phone: value.phone });
  if (phoneCount >= 2) throw new ApiError(409, 'This phone number is already associated with the maximum number of accounts.');

  const passwordHash = await User.hashPassword(value.password);
  const user = await User.create({
    name: value.name,
    email: value.email,
    passwordHash,
    phone: value.phone,
    authProvider: 'local',
    isEmailVerified: false,
  });

  await issueAndSendOtp(user, OTP_PURPOSES.REGISTRATION, env.otp.expiryMinutes);
  return new ApiResponse(201, { id: user._id, email: user.email }, 'Registration successful. Check your email for the verification code.').send(res);
});

const verifyOtp = asyncHandler(async (req, res) => {
  const { error, value } = verifyOtpSchema.validate(req.body);
  if (error) throw new ApiError(400, error.details[0].message);

  const user = await User.findOne({ email: value.email }).select('+otp +otpExpires +otpPurpose +passwordHash');
  if (!user) throw new ApiError(400, 'Invalid request.');

  if (!user.otp || !user.otpExpires || user.otpPurpose !== OTP_PURPOSES.REGISTRATION)
    throw new ApiError(400, 'No pending registration verification for this email.');

  if (user.otpExpires < new Date()) throw new ApiError(400, 'Verification code has expired. Please request a new one.');

  const match = await compareOtp(value.otp, user.otp);
  if (!match) throw new ApiError(400, 'Invalid verification code.');

  user.isEmailVerified = true;
  user.otp = undefined;
  user.otpExpires = undefined;
  user.otpPurpose = undefined;
  await user.save();

  // §10.2: full tokens immediately — dashboard gated by requireOnboardingComplete
  const tokenData = issueFullTokens(res, user);
  return new ApiResponse(200, { ...tokenData, requiresOnboarding: !user.isOnboarded }, 'Email verified. Complete your profile to continue.').send(res);
});

const resendOtp = asyncHandler(async (req, res) => {
  const { error, value } = resendOtpSchema.validate(req.body);
  if (error) throw new ApiError(400, error.details[0].message);

  const user = await User.findOne({ email: value.email });
  if (!user) {
    return new ApiResponse(200, null, 'If an unverified account exists, a new code has been sent.').send(res);
  }
  if (user.isEmailVerified) throw new ApiError(400, 'This account is already verified.');

  await issueAndSendOtp(user, OTP_PURPOSES.REGISTRATION, env.otp.expiryMinutes);
  return new ApiResponse(200, null, 'A new verification code has been sent to your email.').send(res);
});

const login = asyncHandler(async (req, res) => {
  const { error, value } = loginSchema.validate(req.body);
  if (error) throw new ApiError(400, error.details[0].message);

  const user = await User.findOne({ email: value.email }).select('+passwordHash');
  if (!user || !user.isActive) throw new ApiError(401, 'Invalid email or password.');
  if (user.authProvider !== 'local') throw new ApiError(401, 'This account uses Google Sign-In. Please log in with Google.');

  const valid = await user.comparePassword(value.password);
  if (!valid) throw new ApiError(401, 'Invalid email or password.');
  if (!user.isEmailVerified) throw new ApiError(403, 'Please verify your email before logging in.');

  // §10.2: always issue full tokens; isOnboarded in payload for immediate popup detection
  const tokenData = issueFullTokens(res, user);
  return new ApiResponse(200, { ...tokenData, isOnboarded: user.isOnboarded }, 'Logged in.').send(res);
});

const refresh = asyncHandler(async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!token) throw new ApiError(401, 'No refresh token provided.');

  let decoded;
  try {
    decoded = verifyRefreshToken(token);
  } catch {
    throw new ApiError(401, 'Invalid or expired refresh token.');
  }

  const accessToken = signAccessToken({ id: decoded.id, role: decoded.role });
  return new ApiResponse(200, { accessToken }, 'Access token refreshed.').send(res);
});

const logout = asyncHandler(async (req, res) => {
  res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/v1/auth' });
  return new ApiResponse(200, null, 'Logged out.').send(res);
});

// §10.7 — GET /users/me (reachable pre-onboarding)
const getMe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id).lean();
  if (!user) throw new ApiError(404, 'User not found.');

  const SocialLink = require('../user/socialLink.model');
  let socialLinks = [];
  try {
    socialLinks = await SocialLink.find({ userId: req.user.id }).lean();
  } catch {
    // ponytail: swallow if socialLink collection doesn't exist yet in early deploys
  }

  return new ApiResponse(200, {
    id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    institute: user.institute,
    isOnboarded: user.isOnboarded,
    isLegacyUser: user.isLegacyUser,
    notificationsEnabled: user.notificationsEnabled,
    socialLinks,
  }).send(res);
});

// §10.7 — PUT /users/me
const updateMe = asyncHandler(async (req, res) => {
  const { error, value } = updateMeSchema.validate(req.body);
  if (error) throw new ApiError(400, error.details[0].message);

  const user = await User.findById(req.user.id).select('+passwordHash');
  if (!user) throw new ApiError(404, 'User not found.');

  if (value.phone && value.phone !== user.phone) {
    const phoneCount = await User.countDocuments({ phone: value.phone, _id: { $ne: user._id } });
    if (phoneCount >= 2) throw new ApiError(409, 'This phone number is already associated with the maximum number of accounts.');
    user.phone = value.phone;
  }

  if (value.name !== undefined) user.name = value.name;
  if (value.role !== undefined) user.role = value.role;
  if (value.institute !== undefined) user.institute = value.institute;

  await user.save();
  return new ApiResponse(200, { id: user._id, name: user.name, email: user.email }, 'Profile updated.').send(res);
});

// §10.7 — PATCH /users/me/notifications
const updateNotifications = asyncHandler(async (req, res) => {
  const { error, value } = updateNotificationsSchema.validate(req.body);
  if (error) throw new ApiError(400, error.details[0].message);

  await User.findByIdAndUpdate(req.user.id, { notificationsEnabled: value.enabled });
  return new ApiResponse(200, null, 'Notification preference updated.').send(res);
});

// §10.2 — POST /auth/complete-onboarding
const completeOnboarding = asyncHandler(async (req, res) => {
  const { error, value } = completeOnboardingSchema.validate(req.body);
  if (error) throw new ApiError(400, error.details[0].message);

  const user = await User.findById(req.user.id).select('+passwordHash');
  if (!user) throw new ApiError(404, 'User not found.');
  if (user.isOnboarded) throw new ApiError(400, 'Onboarding already complete.');

  // phone: only required if user has none (Google accounts); local already have it
  if (!user.phone) {
    if (!value.phone) throw new ApiError(400, 'Phone number is required to complete sign-in.');
    const phoneCount = await User.countDocuments({ phone: value.phone });
    if (phoneCount >= 2) throw new ApiError(409, 'This phone number is already associated with the maximum number of accounts.');
    user.phone = value.phone;
  }
  // If user already has phone, any phone sent is silently ignored (locked at this step by design)

  user.name = value.name;
  user.role = value.role;
  user.institute = value.institute || null;
  user.isOnboarded = true;
  await user.save();

  const tokenData = issueFullTokens(res, user);
  return new ApiResponse(200, tokenData, 'Onboarding complete.').send(res);
});

const googleLogin = asyncHandler(async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) throw new ApiError(400, 'Google ID token is required.');

  const { email, googleId, name } = await verifyGoogleIdToken(idToken);

  let user = await User.findOne({ email });
  if (!user) {
    user = await User.create({ name, email, googleId, authProvider: 'google', isEmailVerified: true, phone: null });
  } else if (user.authProvider === 'local') {
    throw new ApiError(409, 'An account with this email already exists. Please log in with your password.');
  }

  const tokenData = issueFullTokens(res, user);
  return new ApiResponse(200, { ...tokenData, isOnboarded: user.isOnboarded }, 'Logged in with Google.').send(res);
});

const forgotPassword = asyncHandler(async (req, res) => {
  const { error, value } = forgotPasswordSchema.validate(req.body);
  if (error) throw new ApiError(400, error.details[0].message);

  const generic = new ApiResponse(200, null, 'If an account with that email exists, a reset code has been sent.');
  const user = await User.findOne({ email: value.email });
  if (!user || user.authProvider !== 'local') return generic.send(res);

  await issueAndSendOtp(user, OTP_PURPOSES.PASSWORD_RESET, env.otp.passwordResetExpiryMinutes);
  return generic.send(res);
});

const resetPassword = asyncHandler(async (req, res) => {
  const { error, value } = resetPasswordSchema.validate(req.body);
  if (error) throw new ApiError(400, error.details[0].message);

  const user = await User.findOne({ email: value.email }).select('+otp +otpExpires +otpPurpose +passwordHash');
  if (!user) throw new ApiError(400, 'Invalid request.');

  if (!user.otp || !user.otpExpires || user.otpPurpose !== OTP_PURPOSES.PASSWORD_RESET)
    throw new ApiError(400, 'No pending password reset for this email.');

  if (user.otpExpires < new Date()) throw new ApiError(400, 'Reset code has expired. Please request a new one.');

  const match = await compareOtp(value.otp, user.otp);
  if (!match) throw new ApiError(400, 'Invalid reset code.');

  user.passwordHash = await User.hashPassword(value.newPassword);
  user.otp = undefined;
  user.otpExpires = undefined;
  user.otpPurpose = undefined;
  await user.save();

  // ponytail: known accepted limitation — existing refresh tokens remain valid (stateless JWT)
  return new ApiResponse(200, null, 'Password reset successfully. Please log in with your new password.').send(res);
});

// §10.8 — DELETE /users/me (hard delete + cascade, no re-auth required)
const deleteAccount = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const Collection = require('./collection.model');
  const CollectionItem = require('./collectionItem.model');
  const SavedDataset = require('./savedDataset.model');
  const SearchHistory = require('./searchHistory.model');
  const SocialLink = require('./socialLink.model');

  const collectionIds = await Collection.find({ userId }).distinct('_id');

  await Promise.all([
    User.findByIdAndDelete(userId),
    SavedDataset.deleteMany({ userId }),
    Collection.deleteMany({ userId }),
    CollectionItem.deleteMany({ collectionId: { $in: collectionIds } }),
    SearchHistory.deleteMany({ userId }),
    SocialLink.deleteMany({ userId }),
  ]);

  res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/v1/auth' });
  return new ApiResponse(200, null, 'Account deleted.').send(res);
});

// ponytail: keep getProfile alias for the /auth/me route
const getProfile = getMe;

module.exports = {
  register, login, refresh, logout,
  getProfile, getMe, updateMe, updateNotifications,
  verifyOtp, resendOtp,
  forgotPassword, resetPassword,
  completeOnboarding, googleLogin,
  deleteAccount,
};
