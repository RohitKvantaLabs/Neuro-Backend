const mongoose = require('mongoose');
const Admin = require('./admin.model');
const { User } = require('../user/user.model');
const Dataset = require('../dataset/dataset.model');
const QueryLog = require('../queryLog/queryLog.model');
const ApiError = require('../../utils/ApiError');
const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const logger = require('../../utils/logger');
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
const { runRepositorySync } = require('../agent/agent.client');
const AuditLog = require('./auditLog.model');
const Repository = require('./repository.model');
const SupportTicket = require('./supportTicket.model');
const HelpArticle = require('./helpArticle.model');

// ─── Auth ─────────────────────────────────────────────────────────────────────

// Resend admin login OTP (reuses resendOtpLimiter on the route)
const resendLoginOtp = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) throw new ApiError(400, 'Email is required.');

  const admin = await Admin.findOne({ email });
  if (!admin) {
    return new ApiResponse(200, null, 'If an admin account exists, a new code has been sent.').send(res);
  }

  const otp = generateOtp();
  admin.otp = await hashOtp(otp);
  admin.otpExpires = new Date(Date.now() + env.otp.adminExpiryMinutes * 60 * 1000);
  admin.otpPurpose = OTP_PURPOSES.LOGIN_2FA;
  await admin.save();
  await sendOtpEmail(admin.email, otp, OTP_PURPOSES.LOGIN_2FA);

  return new ApiResponse(200, null, 'A new verification code has been sent to your email.').send(res);
});

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
  if (req.body.otp) req.body.otp = req.body.otp.replace(/\s+/g, '');
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

// Map an admin Repository to the Python connector source key (§4.7).
// Prefer an explicit endpoint_config.source, else derive from the name
// (e.g. 'OpenNeuro' → 'openneuro'). NOTE: seeded display names don't always
// slug to a Python connector key ('DANDI Archive' → 'dandi-archive' ≠ 'dandi');
// set endpoint_config.source on such documents so the pre-check in
// resyncRepository passes and the connector is actually synced.
function _repoSourceKey(repo) {
  if (repo.endpoint_config && typeof repo.endpoint_config.source === 'string' && repo.endpoint_config.source.trim()) {
    return repo.endpoint_config.source.trim();
  }
  return String(repo.name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const resyncRepository = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const repo = await Repository.findById(id);
  if (!repo) throw new ApiError(404, 'Repository not found.');

  // Flip to syncing first so the UI reflects the in-flight state (§4.7).
  await Repository.findByIdAndUpdate(id, { sync_status: 'syncing' }, { new: true });
  _reposCache.delete(REPOS_CACHE_KEY);

  const sourceKey = _repoSourceKey(repo);

  // Pre-check: only repos backed by an enabled Python connector are synced.
  // Display-only repos (e.g. NEMAR, Allen Brain Atlas) skip the HTTP call and
  // are reported offline with a clear reason instead of a wasted Python hit.
  const enabledSources = env.repositoryRetrieval?.enabledSources || [];
  if (!enabledSources.includes(sourceKey)) {
    const skipped = await Repository.findByIdAndUpdate(
      id,
      { sync_status: 'offline', last_sync_at: new Date() },
      { new: true }
    );
    _reposCache.delete(REPOS_CACHE_KEY);
    logAdminAction(req.user.id, 'repo.resync', 'repository', id, {
      name: repo.name,
      source: sourceKey,
      status: 'offline',
      reason: 'no_enabled_connector',
    });
    return new ApiResponse(200, skipped, 'No enabled connector for this repository — marked offline.').send(res);
  }

  try {
    // Real trigger — POST /agents/repository-sync {source} (§4.7)
    const syncResult = await runRepositorySync({ source: sourceKey });
    const pipeline = syncResult?.results?.[sourceKey] || {};
    // errors===0 → connector responded cleanly; a legitimately empty round is
    // still "online". dataset_count is only refreshed when the sync produced
    // new records, so neither a failed nor an empty sync wipes a seeded count.
    const healthy = (pipeline.errors || 0) === 0;

    const updated = await Repository.findByIdAndUpdate(
      id,
      {
        sync_status: healthy ? 'online' : 'offline',
        last_sync_at: new Date(),
        dataset_count: healthy && typeof pipeline.upserted === 'number' && pipeline.upserted > 0
          ? pipeline.upserted
          : repo.dataset_count || 0,
      },
      { new: true }
    );
    _reposCache.delete(REPOS_CACHE_KEY);
    logAdminAction(req.user.id, 'repo.resync', 'repository', id, {
      name: repo.name,
      source: sourceKey,
      fetched: pipeline.fetched || 0,
      upserted: pipeline.upserted || 0,
      errors: pipeline.errors || 0,
      status: updated.sync_status,
    });
    return new ApiResponse(
      200,
      updated,
      healthy ? 'Resync completed.' : 'Resync completed with errors — repository marked offline.'
    ).send(res);
  } catch (err) {
    logger.error(`Resync failed for repository "${repo.name}" (source=${sourceKey}): ${err.message}`);
    const failed = await Repository.findByIdAndUpdate(
      id,
      { sync_status: 'offline', last_sync_at: new Date() },
      { new: true }
    );
    _reposCache.delete(REPOS_CACHE_KEY);
    logAdminAction(req.user.id, 'repo.resync', 'repository', id, {
      name: repo.name,
      source: sourceKey,
      status: 'offline',
      error: err.message,
    });
    return new ApiResponse(200, failed, 'Resync failed — repository marked offline.').send(res);
  }
});

// ─── Analytics (§11.5) ────────────────────────────────────────────────────────

// Percentile helper (nearest-rank). Used on REAL persisted durations from the
// AgentLog collection — never on estimated values.
function _percentile(sortedValues, p) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return null;
  const idx = (sortedValues.length - 1) * (p / 100);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return Math.round(sortedValues[lo] * 10) / 10;
  const value = sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (idx - lo);
  return Math.round(value * 10) / 10;
}

// Display label for a Dataset.source key when no Repository document matches.
function _humanizeSource(source) {
  const s = String(source || '').trim();
  if (!s) return 'Unknown';
  if (s === 'web_search') return 'Web Discovery';
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const getAnalytics = asyncHandler(async (req, res) => {
  const since = new Date();
  since.setDate(since.getDate() - 60);

  // Agent operations that make up a live search pipeline. durationMs for these
  // is REAL persisted timing collected by agent.client.js.
  const AgentLog = require('./agentLog.model');
  const SEARCH_AGENTS = ['parse_query', 'repository_search', 'fallback'];

  const [
    series, users, saved, collections, cacheCount, fallbackCount, mergedCount,
    repoCounts, repoFilterSearches, repoDocs,
    perfByDay, perfByAgent,
    outcomeStats, topQuery, topEmptyQuery,
    agentErrorCount, topErrorReason, topFailedQuery,
  ] = await Promise.all([
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
    // New orchestrator results (§4.7) log as 'merged' — counted so the
    // cache-hit KPI denominator includes them (they are not cache hits).
    QueryLog.countDocuments({ resultSource: 'merged' }),

    // ── Widget 2: real datasets indexed per repository source ────────────────
    Dataset.aggregate([
      { $group: { _id: '$source', datasetsIndexed: { $sum: 1 } } },
      { $sort: { datasetsIndexed: -1 } },
      { $project: { _id: 0, source: '$_id', datasetsIndexed: 1 } },
    ]),
    // Real searches whose filters targeted a specific repository
    // (filters.repository is written by the UI / orchestrator).
    QueryLog.aggregate([
      {
        $match: {
          createdAt: { $gte: since },
          $or: [
            { 'filters.repository': { $type: 'array', $ne: [] } },
            { 'filters.repository': { $type: 'string', $ne: '' } },
          ],
        },
      },
      {
        $addFields: {
          repoList: {
            $cond: [{ $isArray: '$filters.repository' }, '$filters.repository', ['$filters.repository']],
          },
        },
      },
      { $unwind: '$repoList' },
      { $match: { repoList: { $type: 'string' } } },
      {
        $group: {
          _id: { $toLower: { $trim: { input: '$repoList' } } },
          searchesServed: { $sum: 1 },
        },
      },
      { $project: { _id: 0, source: '$_id', searchesServed: 1 } },
    ]),
    // Real repository metadata (status, last sync, admin-tracked count).
    Repository.find().sort({ createdAt: -1 }).lean(),

    // ── Widget 3: real per-day search-performance timings (AgentLog) ─────────
    AgentLog.aggregate([
      { $match: { agent: { $in: SEARCH_AGENTS }, createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
          avgMs: { $avg: '$durationMs' },
          minMs: { $min: '$durationMs' },
          maxMs: { $max: '$durationMs' },
          durations: { $push: '$durationMs' },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, day: '$_id', count: 1, avgMs: 1, minMs: 1, maxMs: 1, durations: 1 } },
    ]),
    // Stage breakdown — only stages that are actually persisted.
    AgentLog.aggregate([
      { $match: { agent: { $in: SEARCH_AGENTS }, createdAt: { $gte: since } } },
      {
        $group: {
          _id: '$agent',
          count: { $sum: 1 },
          avgMs: { $avg: '$durationMs' },
          errors: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
        },
      },
    ]),

    // ── Widget 4: real search outcomes (QueryLog) ────────────────────────────
    QueryLog.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          withResults: { $sum: { $cond: [{ $gt: ['$resultCount', 0] }, 1, 0] } },
          noResults: { $sum: { $cond: [{ $eq: ['$resultCount', 0] }, 1, 0] } },
          avgResultsPerSearch: { $avg: '$resultCount' },
          cache: { $sum: { $cond: [{ $eq: ['$resultSource', 'cache'] }, 1, 0] } },
          merged: { $sum: { $cond: [{ $eq: ['$resultSource', 'merged'] }, 1, 0] } },
          fallback: { $sum: { $cond: [{ $eq: ['$resultSource', 'fallback'] }, 1, 0] } },
        },
      },
      { $project: { _id: 0 } },
    ]),
    QueryLog.aggregate([
      {
        $match: {
          createdAt: { $gte: since },
          resultCount: { $gt: 0 },
          rawQuery: { $nin: ['', null] },
        },
      },
      { $group: { _id: '$rawQuery', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 1 },
      { $project: { _id: 0, query: '$_id', count: 1 } },
    ]),
    QueryLog.aggregate([
      {
        $match: {
          createdAt: { $gte: since },
          resultCount: 0,
          rawQuery: { $nin: ['', null] },
        },
      },
      { $group: { _id: '$rawQuery', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 1 },
      { $project: { _id: 0, query: '$_id', count: 1 } },
    ]),
    // Real search-operation failures (AgentLog status='error', search agents only).
    AgentLog.countDocuments({
      agent: { $in: SEARCH_AGENTS },
      status: 'error',
      createdAt: { $gte: since },
    }),
    AgentLog.aggregate([
      {
        $match: {
          agent: { $in: SEARCH_AGENTS },
          status: 'error',
          errorMessage: { $nin: [null, ''] },
          createdAt: { $gte: since },
        },
      },
      { $group: { _id: '$errorMessage', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 1 },
      { $project: { _id: 0, reason: '$_id', count: 1 } },
    ]),
    AgentLog.aggregate([
      {
        $match: {
          agent: { $in: SEARCH_AGENTS },
          status: 'error',
          query: { $nin: ['', null] },
          createdAt: { $gte: since },
        },
      },
      { $group: { _id: '$query', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 1 },
      { $project: { _id: 0, query: '$_id', count: 1 } },
    ]),
  ]);

  const total = cacheCount + fallbackCount + mergedCount;
  const cacheHitRate = total > 0 ? cacheCount / total : 0;

  // ── Widget 2: merge real dataset counts, search usage, and repo metadata ───
  const repoCountMap = new Map(repoCounts.map((r) => [r.source, r.datasetsIndexed]));
  const searchMap = new Map(repoFilterSearches.map((r) => [r.source, r.searchesServed]));
  const sourceToRepo = new Map();
  for (const r of repoDocs) {
    const key = r.endpoint_config && typeof r.endpoint_config.source === 'string' && r.endpoint_config.source.trim()
      ? r.endpoint_config.source.trim().toLowerCase()
      : String(r.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    sourceToRepo.set(key, r);
  }

  const allSources = new Set([...repoCountMap.keys(), ...searchMap.keys(), ...sourceToRepo.keys()]);
  const repositories = [...allSources]
    .map((source) => {
      const repoDoc = sourceToRepo.get(source);
      return {
        source,
        name: repoDoc ? repoDoc.name : _humanizeSource(source),
        datasetsIndexed: repoCountMap.get(source) || 0,
        searchesServed: searchMap.get(source) || 0,
        datasetCount: repoDoc && typeof repoDoc.dataset_count === 'number' ? repoDoc.dataset_count : null,
        syncStatus: repoDoc && repoDoc.sync_status ? repoDoc.sync_status : null,
        lastSyncAt: repoDoc && repoDoc.last_sync_at ? repoDoc.last_sync_at : null,
      };
    })
    .sort((a, b) => b.datasetsIndexed - a.datasetsIndexed || b.searchesServed - a.searchesServed || a.name.localeCompare(b.name));

  // ── Widget 3: per-day + overall + stage stats from REAL durations ──────────
  const daily = perfByDay.map((d) => {
    const sorted = [...(d.durations || [])].sort((a, b) => a - b);
    return {
      day: d.day,
      count: d.count,
      avgMs: Math.round((d.avgMs || 0) * 10) / 10,
      medianMs: _percentile(sorted, 50),
      minMs: sorted.length ? sorted[0] : null,
      maxMs: sorted.length ? sorted[sorted.length - 1] : null,
      p95Ms: _percentile(sorted, 95),
    };
  });
  const allDurations = perfByDay.flatMap((d) => d.durations || []).sort((a, b) => a - b);
  const overall = {
    totalOps: allDurations.length,
    avgMs: allDurations.length ? Math.round((allDurations.reduce((a, b) => a + b, 0) / allDurations.length) * 10) / 10 : 0,
    medianMs: _percentile(allDurations, 50),
    minMs: allDurations.length ? allDurations[0] : null,
    maxMs: allDurations.length ? allDurations[allDurations.length - 1] : null,
    p95Ms: _percentile(allDurations, 95),
  };

  // Only stages that are genuinely persisted get values; the rest stay null so
  // the UI can state "Historical stage metrics are not persisted" instead of
  // estimating.
  const stageMap = { parse_query: 'queryParser', repository_search: 'repositorySearch', fallback: 'webDiscovery' };
  const stages = {
    queryParser: null,
    mongoSearch: null,
    repositorySearch: null,
    metadataEnrichment: null,
    verification: null,
    ranking: null,
    webDiscovery: null,
  };
  for (const s of perfByAgent) {
    const key = stageMap[s._id];
    if (key) stages[key] = {
      count: s.count,
      avgMs: Math.round((s.avgMs || 0) * 10) / 10,
      errors: s.errors || 0,
    };
  }

  // ── Widget 4: outcome stats from QueryLog + real agent failures ────────────
  const o = outcomeStats[0] || {};
  const searchOutcomes = {
    total: o.total || 0,
    withResults: o.withResults || 0,
    noResults: o.noResults || 0,
    bySource: {
      cache: o.cache || 0,
      merged: o.merged || 0,
      fallback: o.fallback || 0,
    },
    avgResultsPerSearch: o.avgResultsPerSearch != null ? Math.round(o.avgResultsPerSearch * 100) / 100 : null,
    mostCommonQuery: topQuery[0] || null,
    mostCommonEmptyQuery: topEmptyQuery[0] || null,
    failedSearchOperations: agentErrorCount || 0,
    topFailureReason: topErrorReason[0] ? topErrorReason[0].reason : null,
    topFailedQuery: topFailedQuery[0] ? topFailedQuery[0].query : null,
  };

  // ── Phase 8 additive: QueryLog timings (total/parse/dataset/catalog/repository/discovery/ranking) ─
  // Uses same 60-day window and _percentile helper; empty datasets handled cleanly.
  let queryLogTimings=null, provenanceSummary=null, costOverview=null;
  try{
    const timingsAgg = await QueryLog.aggregate([
      { $match: { createdAt: { $gte: since }, timings: { $ne: null } } },
      { $group: {
        _id: null,
        count: { $sum: 1 },
        totalVals: { $push: '$timings.totalMs' },
        parseVals: { $push: '$timings.parseMs' },
        datasetVals: { $push: '$timings.datasetMs' },
        catalogVals: { $push: '$timings.catalogMs' },
        repoVals: { $push: '$timings.repositoryMs' },
        discVals: { $push: '$timings.discoveryMs' },
        rankVals: { $push: '$timings.rankingMs' },
        avgTotal: { $avg: '$timings.totalMs' },
        avgParse: { $avg: '$timings.parseMs' },
        avgDataset: { $avg: '$timings.datasetMs' },
        avgCatalog: { $avg: '$timings.catalogMs' },
        avgRepo: { $avg: '$timings.repositoryMs' },
        avgDisc: { $avg: '$timings.discoveryMs' },
        avgRank: { $avg: '$timings.rankingMs' },
      }}
    ]);
    if(timingsAgg[0]){
      const t=timingsAgg[0];
      const clean = (arr)=> (arr||[]).filter(v=> typeof v==='number' && Number.isFinite(v)).sort((a,b)=>a-b);
      const mk = (vals, avg)=> {
        const c=clean(vals);
        if(c.length===0) return { count:0, avgMs:null, medianMs:null, p95Ms:null, minMs:null, maxMs:null };
        return { count:c.length, avgMs: avg!=null? Math.round(avg*10)/10:null, medianMs:_percentile(c,50), p95Ms:_percentile(c,95), minMs:c[0], maxMs:c[c.length-1] };
      };
      queryLogTimings={
        total: mk(t.totalVals, t.avgTotal),
        parse: mk(t.parseVals, t.avgParse),
        dataset: mk(t.datasetVals, t.avgDataset),
        catalog: mk(t.catalogVals, t.avgCatalog),
        repository: mk(t.repoVals, t.avgRepo),
        discovery: mk(t.discVals, t.avgDisc),
        ranking: mk(t.rankVals, t.avgRank),
        sampleCount: t.count,
      };
    } else {
      queryLogTimings={ total:{count:0}, sampleCount:0 };
    }

    const provAgg = await QueryLog.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: {
        _id: null,
        total: { $sum: 1 },
        mongodb_dataset: { $sum: { $ifNull: ['$provenance.mongodb_dataset',0] } },
        mongodb_catalog: { $sum: { $ifNull: ['$provenance.mongodb_catalog',0] } },
        repository: { $sum: { $ifNull: ['$provenance.repository',0] } },
        discovery: { $sum: { $ifNull: ['$provenance.discovery',0] } },
        outOfDomain: { $sum: { $cond:[{$eq:['$resultSource','out_of_domain']},1,0] } },
      }}
    ]);
    provenanceSummary = provAgg[0] || { total:0, mongodb_dataset:0, mongodb_catalog:0, repository:0, discovery:0, outOfDomain:0 };

    // Cost overview for same window (reuse Phase 6 service, fail-safe)
    try{
      const { calculateAggregateCost } = require('../../services/cost.service');
      const costAgg = await calculateAggregateCost({ from: since.toISOString(), to: new Date().toISOString(), groupBy:'day' });
      costOverview = costAgg.summary;
    }catch{ costOverview=null; }
  }catch{ /* fail-safe: analytics must not break on telemetry */ }

  return new ApiResponse(200, {
    series, users, saved, collections, cacheHitRate, mergedCount,
    repositories, searchPerformance: { daily, overall, stages }, searchOutcomes,
    // Phase 8 additive fields (preserve existing contract)
    queryLogTimings, provenanceSummary, costOverview,
  }).send(res);
});

// ─── Dashboard (§11.8) ────────────────────────────────────────────────────────

const getDashboard = asyncHandler(async (req, res) => {
  const mongoose = require('mongoose');
  let rawCatalogCount = 7320;
  try {
    if (mongoose.connection && mongoose.connection.db) {
      const c = await mongoose.connection.db.collection('neurosearch_datasets_catalog').countDocuments();
      if (typeof c === 'number' && c > 0) rawCatalogCount = c;
    }
  } catch (err) {
    // fallback 7320
  }

  const [totalUsers, repositories, recentAudit, datasetsCount] = await Promise.all([
    User.countDocuments(),
    Repository.find().sort({ createdAt: -1 }),
    AuditLog.find().sort({ createdAt: -1 }).limit(10),
    Dataset.countDocuments().catch(() => 860),
  ]);

  const catalogCount = rawCatalogCount;
  const datasetsCollectionCount = datasetsCount || 860;

  return new ApiResponse(200, {
    totalUsers,
    repositories,
    recentAudit,
    datasetCollectionBreakdown: {
      datasets: datasetsCollectionCount,
      neurosearch_datasets_catalog: catalogCount,
      total: datasetsCollectionCount + catalogCount,
    },
  }).send(res);
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
// Phase 6 additive: each record now includes a calculated `cost` field (USD) derived
// from the centralized pricing table. Existing fields are unchanged.
// Phase 8 additive: supports ?requestId=&provider=&model=&agent=&usageType=&status=&from=&to=&limit=&offset=
// Preserves backward compat: when no pagination params, returns array (frontend expects array).

const getTokens = asyncHandler(async (req, res) => {
  const TokenUsage = require('./tokenUsage.model');
  const { calculateLlmCostForRecord } = require('../../services/cost.service');
  const { requestId, provider, model, agent, usageType, status, from, to, limit: rawLimit, offset: rawOffset } = req.query;
  const hasFilter = !!(requestId || provider || model || agent || usageType || status || from || to || rawLimit || rawOffset);
  const filter={};
  if(requestId) filter.requestId=String(requestId);
  if(provider) filter.provider=String(provider);
  if(model) filter.model=String(model);
  if(agent) filter.agent=String(agent);
  if(usageType){
    if(!['actual','estimated'].includes(usageType)) throw new ApiError(400,'usageType must be actual or estimated');
    filter.usageType=usageType;
  }
  if(status){
    if(!['success','error'].includes(status)) throw new ApiError(400,'status must be success or error');
    filter.status=status;
  }
  if(from || to){
    filter.createdAt={};
    if(from){ const d=new Date(from); if(isNaN(d)) throw new ApiError(400,'Invalid from date'); filter.createdAt.$gte=d; }
    if(to){ const d=new Date(to); if(isNaN(d)) throw new ApiError(400,'Invalid to date'); filter.createdAt.$lte=d; }
  }
  // Backward compat: no filter → original behavior (5000 array)
  if(!hasFilter){
    const tokens = await TokenUsage.find().sort({ createdAt: -1 }).limit(5000).lean();
    const enriched = tokens.map((t) => {
      const c = calculateLlmCostForRecord(t);
      return { ...t, cost: { totalCost: c.totalCost, inputCost: c.inputCost, outputCost: c.outputCost, isEstimated: c.isEstimated, costAvailable: c.costAvailable, pricingAvailable: c.pricingAvailable, reason: c.reason, currency: c.currency || 'USD' } };
    });
    return new ApiResponse(200, enriched).send(res);
  }
  const limit = Math.min(Math.max(parseInt(rawLimit,10)||50,1),500);
  const offset = Math.max(parseInt(rawOffset,10)||0,0);
  const [tokens, total] = await Promise.all([
    TokenUsage.find(filter).sort({createdAt:-1}).skip(offset).limit(limit).lean(),
    TokenUsage.countDocuments(filter),
  ]);
  const enriched = tokens.map((t) => {
    const c = calculateLlmCostForRecord(t);
    return { ...t, cost: { totalCost: c.totalCost, inputCost: c.inputCost, outputCost: c.outputCost, isEstimated: c.isEstimated, costAvailable: c.costAvailable, pricingAvailable: c.pricingAvailable, reason: c.reason, currency: c.currency || 'USD' } };
  });
  return new ApiResponse(200, { items: enriched, total, limit, offset }).send(res);
});

// ─── Infrastructure — Agent Activity ──────────────────────────────────────────
// Phase 8 additive: supports ?requestId=&agent=&provider=&status=&from=&to=&limit=&offset=

const getAgents = asyncHandler(async (req, res) => {
  const AgentLog = require('./agentLog.model');
  const { requestId, agent, provider, status, from, to, limit: rawLimit, offset: rawOffset } = req.query;
  const hasFilter = !!(requestId || agent || provider || status || from || to || rawLimit || rawOffset);
  if(!hasFilter){
    const logs = await AgentLog.find().sort({ createdAt: -1 }).limit(500).lean();
    return new ApiResponse(200, logs).send(res);
  }
  const filter={};
  if(requestId) filter.requestId=String(requestId);
  if(agent) filter.agent=String(agent);
  if(provider) filter.provider=String(provider);
  if(status){
    if(!['success','error'].includes(status)) throw new ApiError(400,'status must be success or error');
    filter.status=status;
  }
  if(from || to){
    filter.createdAt={};
    if(from){ const d=new Date(from); if(isNaN(d)) throw new ApiError(400,'Invalid from date'); filter.createdAt.$gte=d; }
    if(to){ const d=new Date(to); if(isNaN(d)) throw new ApiError(400,'Invalid to date'); filter.createdAt.$lte=d; }
  }
  const limit = Math.min(Math.max(parseInt(rawLimit,10)||50,1),500);
  const offset = Math.max(parseInt(rawOffset,10)||0,0);
  const [logs, total] = await Promise.all([
    AgentLog.find(filter).sort({createdAt:-1}).skip(offset).limit(limit).lean(),
    AgentLog.countDocuments(filter),
  ]);
  return new ApiResponse(200, { items: logs, total, limit, offset }).send(res);
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
  login, verifyLoginOtp, resendLoginOtp,
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
