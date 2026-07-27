const mongoose = require('mongoose');
const Admin = require('./admin.model');
const { User } = require('../user/user.model');
const Dataset = require('../dataset/dataset.model');
const QueryLog = require('../queryLog/queryLog.model');
const ApiError = require('../../utils/ApiError');
const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const { TtlCache } = require('../../utils/ttlCache');

// In-memory cache for the public /repositories endpoint.
// Repository listing rarely changes (admin CRUD only) and is identical
// for every user — no reason to hit Mongo on every landing page load.
const _reposCache = new TtlCache({ ttlMs: 300_000 }); // 5 minutes
const REPOS_CACHE_KEY = 'repos';
const { adminLoginSchema, verifyLoginOtpSchema } = require('./admin.validation');
const { OTP_PURPOSES, generateOtp, hashOtp, compareOtp } = require('../../utils/otp.util');
const { sendOtpEmail } = require('../../utils/mailer');
const env = require('../../config/env.config');
const { signAccessToken, signRefreshToken, REFRESH_COOKIE_NAME, REFRESH_COOKIE_OPTIONS } = require('../auth/auth.service');
const { logAdminAction } = require('../../utils/auditLog.util');
const AuditLog = require('./auditLog.model');
const Repository = require('./repository.model');
const SupportTicket = require('./supportTicket.model');
const HelpArticle = require('./helpArticle.model');

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

  // Blocking audit log — ensures the action is recorded even if a subsequent request
  // clears logs before the fire-and-forget promise resolves.
  await logAdminAction(req.user.id, 'user.delete', 'user', id).catch(() => {});

  return new ApiResponse(200, null, 'User deleted.').send(res);
});

// ─── Admin accounts ───────────────────────────────────────────────────────────

const getAdmins = asyncHandler(async (req, res) => {
  const admins = await Admin.find().select('name email createdAt').sort({ createdAt: -1 });
  return new ApiResponse(200, admins).send(res);
});

// ─── Update admin profile (name only) ────────────────────────────────────────

const updateAdminProfile = asyncHandler(async (req, res) => {
  const { name } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new ApiError(400, 'Name is required and must be a non-empty string.');
  }

  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 100) {
    throw new ApiError(400, 'Name must be between 2 and 100 characters.');
  }

  const admin = await Admin.findByIdAndUpdate(
    req.user.id,
    { name: trimmed },
    { new: true, select: 'name email createdAt' }
  );

  if (!admin) throw new ApiError(404, 'Admin not found.');

  logAdminAction(req.user.id, 'admin.profile.update', 'admin', req.user.id, { name: trimmed });
  return new ApiResponse(200, admin, 'Profile updated.').send(res);
});

// ─── Datasets ────────────────────────────────────────────────────────────────

const listDatasets = asyncHandler(async (req, res) => {
  const { trust_tier: trustTier, page = 1, limit = 50 } = req.query;
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const safePage = Math.max(Number(page) || 1, 1);
  const filter = trustTier ? { trust_tier: trustTier } : {};
  const datasets = await Dataset.find(filter)
    .sort({ updated_at: -1 })
    .skip((safePage - 1) * safeLimit)
    .limit(safeLimit);
  return new ApiResponse(200, datasets).send(res);
});

const deleteDataset = asyncHandler(async (req, res) => {
  const { datasetId } = req.params;
  const deleted = await Dataset.findByIdAndDelete(datasetId);
  if (!deleted) throw new ApiError(404, 'Dataset not found.');
  logAdminAction(req.user.id, 'dataset.delete', 'dataset', datasetId);
  return new ApiResponse(200, null, 'Dataset deleted.').send(res);
});

// ─── Repositories (§11.1) ─────────────────────────────────────────────────────

const listRepositories = asyncHandler(async (req, res) => {
  const repos = await _reposCache.getOrSet(REPOS_CACHE_KEY, () =>
    Repository.find().sort({ createdAt: -1 })
  );
  // Cache at Vercel edge for 5 min; allow serving stale for 1 min while revalidating
  res.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60');
  return new ApiResponse(200, repos).send(res);
});

const createRepository = asyncHandler(async (req, res) => {
  const { name, trust_tier, endpoint_config } = req.body;
  if (!name) throw new ApiError(400, 'name is required.');

  // ponytail: hard cap — keeps the frontend grid bounded at 10 cards
  const count = await Repository.countDocuments();
  if (count >= 10) throw new ApiError(400, 'Maximum 10 repositories allowed. Remove one before adding another.');

  const repo = await Repository.create({ name, trust_tier, endpoint_config });
  _reposCache.delete(REPOS_CACHE_KEY);
  logAdminAction(req.user.id, 'repo.create', 'repository', repo._id.toString(), { name });
  return new ApiResponse(201, repo, 'Repository created.').send(res);
});


const deleteRepository = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const repo = await Repository.findByIdAndDelete(id);
  if (!repo) throw new ApiError(404, 'Repository not found.');
  _reposCache.delete(REPOS_CACHE_KEY);
  logAdminAction(req.user.id, 'repo.delete', 'repository', id, { name: repo.name });
  return new ApiResponse(200, null, 'Repository deleted.').send(res);
});

const resyncRepository = asyncHandler(async (req, res) => {
  const { id } = req.params;
  // ponytail: only flips the flag — real trigger to Python is a follow-up (§11.1)
  const repo = await Repository.findByIdAndUpdate(id, { sync_status: 'syncing' }, { new: true });
  if (!repo) throw new ApiError(404, 'Repository not found.');
  _reposCache.delete(REPOS_CACHE_KEY);
  logAdminAction(req.user.id, 'repo.resync', 'repository', id, { name: repo.name });
  return new ApiResponse(200, repo, 'Resync initiated.').send(res);
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
  const [totalUsers, repositories, recentAudit] = await Promise.all([
    User.countDocuments(),
    Repository.find().sort({ createdAt: -1 }),
    AuditLog.find().sort({ createdAt: -1 }).limit(10),
  ]);

  // ponytail: no moderation queue — Python writes directly to datasets; QC via cron + listDatasets/deleteDataset
  return new ApiResponse(200, { totalUsers, repositories, recentAudit }).send(res);
});

// ─── Audit Log (§11.6) ────────────────────────────────────────────────────────

const getAuditLog = asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const logs = await AuditLog.find()
    .populate('adminId', 'name email')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return new ApiResponse(200, logs).send(res);
});

// ─── Infrastructure — MongoDB ──────────────────────────────────────────────────

const getInfraMongo = asyncHandler(async (req, res) => {
  let totalSizeBytes = 0;
  let dataSizeBytes = 0;
  let storageSizeBytes = 0;
  let indexSizeBytes = 0;
  let collectionStats = [];

  try {
    const db = mongoose.connection.db;
    if (!db) throw new ApiError(503, 'MongoDB not connected.');

    // dbStats provides DB-level size info — works on Atlas M0
    const dbStats = await db.command({ dbStats: 1 });
    dataSizeBytes = dbStats.dataSize || 0;
    storageSizeBytes = dbStats.storageSize || 0;
    indexSizeBytes = dbStats.indexSize || 0;

    // List collections + per-collection document counts — safe on Atlas M0
    const collections = await db.listCollections().toArray();
    const collResults = await Promise.allSettled(
      collections.map(async (c) => {
        const coll = db.collection(c.name);
        const count = await coll.estimatedDocumentCount();
        // Try $collStats aggregation stage (safer than deprecated collStats command)
        let sizeBytes = 0;
        try {
          const pipeline = await coll.aggregate([
            { $collStats: { storageStats: {} } }
          ]).toArray();
          if (pipeline.length > 0) {
            sizeBytes = pipeline[0].storageStats?.size || 0;
          }
        } catch {
          // fallback: estimate size from average document
          sizeBytes = 0;
        }
        return {
          name: c.name,
          count,
          sizeBytes,
          storageSizeBytes: 0,
          indexSizeBytes: 0,
          avgObjSizeBytes: 0,
        };
      })
    );

    collectionStats = collResults
      .filter((r) => r.status === 'fulfilled')
      .map((r) => r.value);

    // Calculate total from actual collection sizes, or use dbStats as fallback
    totalSizeBytes = collectionStats.reduce((a, c) => a + c.sizeBytes, 0) || dataSizeBytes;
  } catch { /* best-effort — return partial data */ }

  // Growth simulation (flat line, real historical tracking is a future feature)
  const growth = Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (13 - i));
    return { day: d.toISOString().slice(0, 10), sizeBytes: totalSizeBytes };
  });

  return new ApiResponse(200, {
    totalSizeBytes,
    dataSizeBytes,
    storageSizeBytes,
    indexSizeBytes,
    collections: collectionStats,
    growth,
    freeTierLimitBytes: 512 * 1024 * 1024,
    usagePercent: totalSizeBytes > 0 ? (totalSizeBytes / (512 * 1024 * 1024)) * 100 : 0,
  }).send(res);
});

// ─── Infrastructure — Redis ────────────────────────────────────────────────────

const getInfraRedis = asyncHandler(async (req, res) => {
  let uptimeSeconds = 0;
  let connectedClients = 0;
  let memoryUsedBytes = 0;
  let memoryPeakBytes = 0;
  let maxMemoryBytes = 30 * 1024 * 1024;
  let messageThroughputPerMin = 0;
  let version = '';
  let os = '';
  let keyspaceHits = 0;
  let keyspaceMisses = 0;
  let inFlightQueries = 0;
  let activeSse = 0;

  try {
    const { redisClient } = require('../../config/redis.config');
    const info = await redisClient.info();

    // Parse Redis INFO output into key-value pairs
    const lines = info.split('\r\n');
    const data = {};
    for (const line of lines) {
      if (line && !line.startsWith('#') && line.includes(':')) {
        const idx = line.indexOf(':');
        data[line.slice(0, idx)] = line.slice(idx + 1);
      }
    }

    uptimeSeconds = parseInt(data.uptime_in_seconds, 10) || 0;
    connectedClients = parseInt(data.connected_clients, 10) || 0;
    memoryUsedBytes = parseInt(data.used_memory, 10) || 0;
    memoryPeakBytes = parseInt(data.used_memory_peak, 10) || 0;
    const maxMemConfig = parseInt(data.maxmemory, 10) || 0;
    if (maxMemConfig > 0) maxMemoryBytes = maxMemConfig;
    messageThroughputPerMin = Math.round(
      (parseInt(data.instantaneous_ops_per_sec, 10) || 0) * 60
    );
    version = data.redis_version || '';
    os = data.os || '';
    keyspaceHits = parseInt(data.keyspace_hits, 10) || 0;
    keyspaceMisses = parseInt(data.keyspace_misses, 10) || 0;

    // Count in-flight queries — a loose heuristic based on pubsub channels
    try {
      const pubsubResult = await redisClient.sendCommand(['PUBSUB', 'CHANNELS']);
      inFlightQueries = Array.isArray(pubsubResult) ? pubsubResult.length : 0;
    } catch { /* best-effort */ }
  } catch { /* best-effort — Redis may not be configured on free tier */ }

  // Count active SSE connections from in-memory manager (always available)
  try {
    const { getConnectionCount } = require('../realtime/sse.manager');
    activeSse = getConnectionCount();
  } catch { /* best-effort */ }

  const hitRate = (keyspaceHits + keyspaceMisses) > 0
    ? keyspaceHits / (keyspaceHits + keyspaceMisses)
    : 0;

  return new ApiResponse(200, {
    uptimeSeconds,
    connectedClients,
    activeSseConnections: activeSse,
    memoryUsedBytes,
    memoryPeakBytes,
    maxMemoryBytes,
    memoryUsagePercent: maxMemoryBytes > 0 ? (memoryUsedBytes / maxMemoryBytes) * 100 : 0,
    inFlightQueries,
    messageThroughputPerMin,
    pubsubChannels: [],
    version,
    os,
    keyspaceHits,
    keyspaceMisses,
    hitRate,
  }).send(res);
});

// ─── Infrastructure — Storage ──────────────────────────────────────────────────

const getInfraStorage = asyncHandler(async (req, res) => {
  const db = mongoose.connection.db;
  const { redisClient } = require('../../config/redis.config');

  // MongoDB stats
  let mongoUsedBytes = 0;
  let mongoStorageBytes = 0;
  try {
    if (db) {
      const dbStats = await db.command({ dbStats: 1 });
      mongoUsedBytes = dbStats.dataSize || 0;
      mongoStorageBytes = dbStats.storageSize || 0;
    }
  } catch { /* best-effort */ }

  // Redis stats
  let redisUsedBytes = 0;
  let redisMaxBytes = 30 * 1024 * 1024;
  try {
    const info = await redisClient.info();
    const lines = info.split('\r\n');
    const data = {};
    for (const line of lines) {
      if (line && !line.startsWith('#') && line.includes(':')) {
        const idx = line.indexOf(':');
        data[line.slice(0, idx)] = line.slice(idx + 1);
      }
    }
    redisUsedBytes = parseInt(data.used_memory, 10) || 0;
    const maxMem = parseInt(data.maxmemory, 10) || 0;
    if (maxMem > 0) redisMaxBytes = maxMem;
  } catch { /* best-effort */ }

  // MongoDB Atlas M0 free tier: 512MB
  const mongoLimitBytes = 512 * 1024 * 1024;
  // Calculate combined usage
  const totalUsedBytes = mongoUsedBytes + redisUsedBytes;
  const totalLimitBytes = mongoLimitBytes + redisMaxBytes;
  const totalRemainingBytes = totalLimitBytes - totalUsedBytes;

  // Document & collection counts
  let totalDocuments = 0;
  let totalCollections = 0;
  try {
    if (db) {
      totalCollections = (await db.listCollections().toArray()).length;
      for (const c of await db.listCollections().toArray()) {
        totalDocuments += await db.collection(c.name).countDocuments();
      }
    }
  } catch { /* best-effort */ }

  return new ApiResponse(200, {
    // MongoDB
    mongoUsedBytes,
    mongoStorageBytes,
    mongoLimitBytes,
    mongoUsagePercent: mongoLimitBytes > 0 ? (mongoUsedBytes / mongoLimitBytes) * 100 : 0,
    mongoDocuments: totalDocuments,
    mongoCollections: totalCollections,
    // Redis
    redisUsedBytes,
    redisMaxBytes,
    redisUsagePercent: redisMaxBytes > 0 ? (redisUsedBytes / redisMaxBytes) * 100 : 0,
    // Combined
    totalUsedBytes,
    totalLimitBytes,
    totalRemainingBytes,
    totalUsagePercent: totalLimitBytes > 0 ? (totalUsedBytes / totalLimitBytes) * 100 : 0,
  }).send(res);
});

// ─── Infrastructure — Token Usage ─────────────────────────────────────────────

const getTokens = asyncHandler(async (req, res) => {
  const TokenUsage = require('./tokenUsage.model');
  const tokens = await TokenUsage.find()
    .sort({ createdAt: -1 })
    .limit(5000)
    .lean();
  return new ApiResponse(200, tokens).send(res);
});

// ─── Infrastructure — Agent Activity ──────────────────────────────────────────

const getAgents = asyncHandler(async (req, res) => {
  const AgentLog = require('./agentLog.model');
  const logs = await AgentLog.find()
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
  return new ApiResponse(200, logs).send(res);
});

// ─── Help Desk — Tickets ─────────────────────────────────────────────────────

const listTickets = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 50 } = req.query;
  const filter = status ? { status } : {};
  const tickets = await SupportTicket.find(filter)
    .sort({ createdAt: -1 })
    .skip((Number(page) - 1) * Number(limit))
    .limit(Number(limit))
    .lean();
  const total = await SupportTicket.countDocuments(filter);
  return new ApiResponse(200, { tickets, total, page: Number(page), limit: Number(limit) }).send(res);
});

const updateTicketStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!['open', 'in_progress', 'resolved'].includes(status))
    throw new ApiError(400, 'Invalid status.');

  const patch = { status };
  if (status === 'resolved') patch.resolved_at = new Date();
  else patch.resolved_at = null;

  const ticket = await SupportTicket.findByIdAndUpdate(id, patch, { new: true }).lean();
  if (!ticket) throw new ApiError(404, 'Ticket not found.');
  logAdminAction(req.user.id, 'ticket.update', 'supportTicket', id, { status });
  return new ApiResponse(200, ticket, 'Ticket updated.').send(res);
});

// ─── Help Desk — Email Ingestion Webhook ────────────────────────────────────

const ingestEmailTicket = asyncHandler(async (req, res) => {
  const { subject, message, email, name } = req.body;
  if (!subject || !message) throw new ApiError(400, 'subject and message are required.');

  const ticket = await SupportTicket.create({ subject, message, email, name, source: 'email' });
  return new ApiResponse(201, ticket, 'Ticket created from email.').send(res);
});

// ─── Help Desk — Articles ───────────────────────────────────────────────────

const listHelpArticles = asyncHandler(async (req, res) => {
  const articles = await HelpArticle.find().sort({ updatedAt: -1 }).lean();
  return new ApiResponse(200, articles).send(res);
});

const createHelpArticle = asyncHandler(async (req, res) => {
  const { title, slug, body, published } = req.body;
  if (!title || !slug) throw new ApiError(400, 'title and slug are required.');

  const existing = await HelpArticle.findOne({ slug });
  if (existing) throw new ApiError(409, 'An article with this slug already exists.');

  const article = await HelpArticle.create({ title, slug, body, published });
  logAdminAction(req.user.id, 'article.create', 'helpArticle', article._id.toString(), { title });
  return new ApiResponse(201, article, 'Article created.').send(res);
});

const deleteHelpArticle = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const article = await HelpArticle.findByIdAndDelete(id);
  if (!article) throw new ApiError(404, 'Article not found.');
  logAdminAction(req.user.id, 'article.delete', 'helpArticle', id, { title: article.title });
  return new ApiResponse(200, null, 'Article deleted.').send(res);
});

module.exports = {
  login, verifyLoginOtp,
  getAdmins, updateAdminProfile,
  listUsers, deleteUser,
  listDatasets, deleteDataset,
  listRepositories, createRepository, deleteRepository, resyncRepository,
  getAnalytics, getDashboard, getAuditLog,
  getInfraMongo, getInfraRedis, getInfraStorage,
  getTokens, getAgents,
  listTickets, updateTicketStatus, ingestEmailTicket,
  listHelpArticles, createHelpArticle, deleteHelpArticle,
};
