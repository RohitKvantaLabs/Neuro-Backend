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
const { logAdminAction } = require('../../utils/auditLog.util');
const AuditLog = require('./auditLog.model');
const Repository = require('./repository.model');
const PendingDataset = require('./pendingDataset.model');

// ─── Auth ─────────────────────────────────────────────────────────────────────

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
  return new ApiResponse(200, {
    accessToken,
    admin: { id: admin._id, name: admin.name, email: admin.email, isAdmin: true },
  }, 'Logged in.').send(res);
});

// ─── Users ────────────────────────────────────────────────────────────────────

const listUsers = asyncHandler(async (req, res) => {
  const users = await User.find().select('-passwordHash').sort({ createdAt: -1 });
  return new ApiResponse(200, users).send(res);
});

// §11.2 — Hard delete user + full cascade (mirrors §10.8)
const deleteUser = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const Collection = require('../user/collection.model');
  const CollectionItem = require('../user/collectionItem.model');
  const SavedDataset = require('../user/savedDataset.model');
  const SearchHistory = require('../user/searchHistory.model');
  const SocialLink = require('../user/socialLink.model');

  const user = await User.findById(id);
  if (!user) throw new ApiError(404, 'User not found.');

  const collectionIds = await Collection.find({ userId: id }).distinct('_id');

  await Promise.all([
    User.findByIdAndDelete(id),
    SavedDataset.deleteMany({ userId: id }),
    Collection.deleteMany({ userId: id }),
    CollectionItem.deleteMany({ collectionId: { $in: collectionIds } }),
    SearchHistory.deleteMany({ userId: id }),
    SocialLink.deleteMany({ userId: id }),
  ]);

  // ponytail: fire-and-forget, never blocks response
  logAdminAction(req.user.id, 'user.delete', 'user', id);

  return new ApiResponse(200, null, 'User deleted.').send(res);
});

// ─── Datasets ────────────────────────────────────────────────────────────────

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

// ─── Repositories (§11.1) ─────────────────────────────────────────────────────

const listRepositories = asyncHandler(async (req, res) => {
  const repos = await Repository.find().sort({ createdAt: -1 });
  return new ApiResponse(200, repos).send(res);
});

const createRepository = asyncHandler(async (req, res) => {
  const { name, trust_tier, endpoint_config } = req.body;
  if (!name) throw new ApiError(400, 'name is required.');

  const repo = await Repository.create({ name, trust_tier, endpoint_config });
  logAdminAction(req.user.id, 'repo.create', 'repository', repo._id.toString(), { name });
  return new ApiResponse(201, repo, 'Repository created.').send(res);
});

const deleteRepository = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const repo = await Repository.findByIdAndDelete(id);
  if (!repo) throw new ApiError(404, 'Repository not found.');
  logAdminAction(req.user.id, 'repo.delete', 'repository', id, { name: repo.name });
  return new ApiResponse(200, null, 'Repository deleted.').send(res);
});

const resyncRepository = asyncHandler(async (req, res) => {
  const { id } = req.params;
  // ponytail: only flips the flag — real trigger to Python is a follow-up (§11.1)
  const repo = await Repository.findByIdAndUpdate(id, { sync_status: 'syncing' }, { new: true });
  if (!repo) throw new ApiError(404, 'Repository not found.');
  logAdminAction(req.user.id, 'repo.resync', 'repository', id, { name: repo.name });
  return new ApiResponse(200, repo, 'Resync initiated.').send(res);
});

// ─── Moderation (§11.3) ───────────────────────────────────────────────────────

const getModerationQueue = asyncHandler(async (req, res) => {
  const queue = await PendingDataset.find({ status: 'pending' }).sort({ discovered_at: -1 });
  return new ApiResponse(200, queue).send(res);
});

const approveDataset = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const pending = await PendingDataset.findById(id);
  if (!pending) throw new ApiError(404, 'Pending dataset not found.');

  // Upsert into the live Dataset collection on (source, source_id)
  const datasetFields = pending.toObject();
  // Strip fields that are moderation-specific and not on Dataset schema
  delete datasetFields._id;
  delete datasetFields.source_query;
  delete datasetFields.discovered_at;
  delete datasetFields.status;
  delete datasetFields.rejectionReason;
  delete datasetFields.__v;
  delete datasetFields.createdAt;
  delete datasetFields.updatedAt;

  await Dataset.findOneAndUpdate(
    { source: pending.source, source_id: pending.source_id },
    { $set: datasetFields },
    { upsert: true, new: true }
  );

  await PendingDataset.findByIdAndDelete(id);

  logAdminAction(req.user.id, 'moderation.approve', 'dataset', id, {
    source: pending.source,
    source_id: pending.source_id,
  });

  return new ApiResponse(200, null, 'Dataset approved and published.').send(res);
});

const rejectDataset = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  const pending = await PendingDataset.findByIdAndUpdate(
    id,
    { status: 'rejected', rejectionReason: reason ?? null },
    { new: true }
  );
  if (!pending) throw new ApiError(404, 'Pending dataset not found.');

  logAdminAction(req.user.id, 'moderation.reject', 'dataset', id, { reason: reason ?? null });

  return new ApiResponse(200, null, 'Dataset rejected.').send(res);
});

// ─── Analytics (§11.5) ────────────────────────────────────────────────────────

const getAnalytics = asyncHandler(async (req, res) => {
  const since = new Date();
  since.setDate(since.getDate() - 60);

  const [series, users, saved, collections, cacheCount, fallbackCount] = await Promise.all([
    QueryLog.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, day: '$_id', count: 1 } },
    ]),
    User.countDocuments(),
    // ponytail: lazy require to avoid circular dep at module load
    require('../user/savedDataset.model').countDocuments(),
    require('../user/collection.model').countDocuments(),
    QueryLog.countDocuments({ resultSource: 'cache' }),
    QueryLog.countDocuments({ resultSource: 'fallback' }),
  ]);

  const total = cacheCount + fallbackCount;
  const cacheHitRate = total > 0 ? cacheCount / total : 0;

  return new ApiResponse(200, { series, users, saved, collections, cacheHitRate }).send(res);
});

// ─── Dashboard (§11.8) ────────────────────────────────────────────────────────

const getDashboard = asyncHandler(async (req, res) => {
  const [totalUsers, pendingModeration, repositories, recentAudit] = await Promise.all([
    User.countDocuments(),
    PendingDataset.countDocuments({ status: 'pending' }),
    Repository.find().sort({ createdAt: -1 }),
    AuditLog.find().sort({ createdAt: -1 }).limit(10),
  ]);

  return new ApiResponse(200, { totalUsers, pendingModeration, repositories, recentAudit }).send(res);
});

// ─── Audit Log (§11.6) ────────────────────────────────────────────────────────

const getAuditLog = asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(limit);
  return new ApiResponse(200, logs).send(res);
});

module.exports = {
  login, verifyLoginOtp,
  listUsers, deleteUser,
  listDatasets, deleteDataset,
  listRepositories, createRepository, deleteRepository, resyncRepository,
  getModerationQueue, approveDataset, rejectDataset,
  getAnalytics, getDashboard, getAuditLog,
};
