const Admin = require('./admin.model');
const { User } = require('../user/user.model');
const Dataset = require('../dataset/dataset.model');
const QueryLog = require('../queryLog/queryLog.model');
const ApiError = require('../../utils/ApiError');
const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const { adminLoginSchema, verifyLoginOtpSchema } = require('./admin.validation');
const { OTP_PURPOSES, generateOtp, hashOtp, compareOtp } = require('../../utils/otp.util');
const { sendOtpEmail } = require('../../utils/mailer');
const env = require('../../config/env.config');
const { signAccessToken, signRefreshToken, REFRESH_COOKIE_NAME, REFRESH_COOKIE_OPTIONS } = require('../auth/auth.service');

// Step 1: verify password, issue OTP (do NOT issue tokens yet)
const login = asyncHandler(async (req, res) => {
  const { error, value } = adminLoginSchema.validate(req.body);
  if (error) throw new ApiError(400, error.details[0].message);

  const admin = await Admin.findOne({ email: value.email }).select('+passwordHash');
  if (!admin) throw new ApiError(401, 'Invalid email or password.');

  const valid = await admin.comparePassword(value.password);
  if (!valid) throw new ApiError(401, 'Invalid email or password.');

  const otp = generateOtp();
  admin.otp = await hashOtp(otp);
  admin.otpExpires = new Date(Date.now() + env.otp.adminExpiryMinutes * 60 * 1000);
  admin.otpPurpose = OTP_PURPOSES.LOGIN_2FA;
  await admin.save();
  await sendOtpEmail(admin.email, otp, OTP_PURPOSES.LOGIN_2FA);

  return new ApiResponse(200, { otpRequired: true }, 'Verification code sent to your email.').send(res);
});

// Step 2: verify OTP, issue tokens
const verifyLoginOtp = asyncHandler(async (req, res) => {
  const { error, value } = verifyLoginOtpSchema.validate(req.body);
  if (error) throw new ApiError(400, error.details[0].message);

  const admin = await Admin.findOne({ email: value.email }).select('+otp +otpExpires +otpPurpose');
  if (!admin) throw new ApiError(400, 'Invalid request.');

  if (!admin.otp || !admin.otpExpires || admin.otpPurpose !== OTP_PURPOSES.LOGIN_2FA)
    throw new ApiError(400, 'No pending 2FA verification for this account.');

  if (admin.otpExpires < new Date()) throw new ApiError(400, 'Verification code has expired.');

  const match = await compareOtp(value.otp, admin.otp);
  if (!match) throw new ApiError(400, 'Invalid verification code.');

  admin.otp = undefined;
  admin.otpExpires = undefined;
  admin.otpPurpose = undefined;
  await admin.save();

  const payload = { id: admin._id.toString(), role: 'admin' };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, REFRESH_COOKIE_OPTIONS);
  return new ApiResponse(200, { accessToken, admin: { id: admin._id, name: admin.name, email: admin.email } }, 'Logged in.').send(res);
});

const listUsers = asyncHandler(async (req, res) => {
  const users = await User.find().select('-passwordHash').sort({ createdAt: -1 });
  return new ApiResponse(200, users).send(res);
});

const setUserActive = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { isActive } = req.body;
  const user = await User.findByIdAndUpdate(userId, { isActive: !!isActive }, { new: true }).select('-passwordHash');
  if (!user) throw new ApiError(404, 'User not found.');
  return new ApiResponse(200, user, `User ${isActive ? 'activated' : 'deactivated'}.`).send(res);
});

const listDatasets = asyncHandler(async (req, res) => {
  const { trust_tier: trustTier, page = 1, limit = 50 } = req.query;
  const filter = trustTier ? { trust_tier: trustTier } : {};
  const datasets = await Dataset.find(filter)
    .sort({ updated_at: -1 })
    .skip((page - 1) * limit)
    .limit(Number(limit));
  return new ApiResponse(200, datasets).send(res);
});

const deleteDataset = asyncHandler(async (req, res) => {
  const { datasetId } = req.params;
  const deleted = await Dataset.findByIdAndDelete(datasetId);
  if (!deleted) throw new ApiError(404, 'Dataset not found.');
  return new ApiResponse(200, null, 'Dataset deleted.').send(res);
});

const getStats = asyncHandler(async (req, res) => {
  const [userCount, datasetCount, cacheHitCount, fallbackCount] = await Promise.all([
    User.countDocuments(),
    Dataset.countDocuments(),
    QueryLog.countDocuments({ resultSource: 'cache' }),
    QueryLog.countDocuments({ resultSource: 'fallback' }),
  ]);
  return new ApiResponse(200, { userCount, datasetCount, cacheHitCount, fallbackCount }).send(res);
});

module.exports = { login, verifyLoginOtp, listUsers, setUserActive, listDatasets, deleteDataset, getStats };
