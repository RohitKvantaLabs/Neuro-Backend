const express = require('express');
const {
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
} = require('./admin.controller');
const { requireAuth, requireAdmin } = require('../auth/auth.middleware');
const { otpVerifyLimiter, resendOtpLimiter, loginLimiter, ticketIngestLimiter } = require('../../middleware/rateLimiter');
const requireTicketIngestSecret = require('../../middleware/requireTicketIngestSecret');

const router = express.Router();

// ── Public auth routes ───────────────────────────────────────────────────────
router.post('/login', loginLimiter, login);
router.post('/verify-login-otp', otpVerifyLimiter, verifyLoginOtp);
router.post('/resend-login-otp', resendOtpLimiter, resendLoginOtp);

// ── Email ingestion webhook (no auth — called by external email service) ─────
router.post('/tickets/ingest', ticketIngestLimiter, requireTicketIngestSecret, ingestEmailTicket);

// ── All routes below require a valid admin access token ──────────────────────
router.use(requireAuth, requireAdmin);

// Users
router.get('/users', listUsers);
router.delete('/users/:id', deleteUser);             // §11.2

// Curation & Overrides (Phase 3)
const {
  updateDatasetOverride,
  deleteDatasetOverride,
  publishPopularDataset,
  unpublishPopularDataset,
  reorderPopularDatasets,
  archiveDataset,
  restoreDataset,
  hardDeleteDataset,
} = require('./adminCuration.controller');

router.patch('/datasets/:datasetId/override', updateDatasetOverride);
router.delete('/datasets/:datasetId/override', deleteDatasetOverride);
router.post('/datasets/:datasetId/archive', archiveDataset);
router.post('/datasets/:datasetId/restore', restoreDataset);
router.delete('/datasets/:datasetId', hardDeleteDataset);

router.post('/moderation/popular/:datasetId/publish', publishPopularDataset);
router.post('/moderation/popular/:datasetId/unpublish', unpublishPopularDataset);
router.put('/moderation/popular/reorder', reorderPopularDatasets);

// Repositories (§11.1)
router.get('/repositories', listRepositories);
router.post('/repositories', createRepository);
router.delete('/repositories/:id', deleteRepository);
router.post('/repositories/:id/resync', resyncRepository);

// Moderation (Phase 2 & 4)
const {
  getPopularCandidates,
  getDislikeQueue,
  getDislikeDetail,
  getPublishedCatalog,
  searchCanonicalDatasetsForAdmin,
} = require('./adminModeration.controller');

router.get('/moderation/popular-candidates', getPopularCandidates);
router.get('/moderation/dislike-queue', getDislikeQueue);
router.get('/moderation/dislike-queue/:datasetId', getDislikeDetail);
router.get('/moderation/published', getPublishedCatalog);
router.get('/moderation/datasets/search', searchCanonicalDatasetsForAdmin);


// Admin accounts
router.get('/admins', getAdmins);
router.patch('/profile', updateAdminProfile);

// Analytics, Dashboard, Audit log (§11.5, §11.8, §11.6)
router.get('/analytics', getAnalytics);
router.get('/dashboard', getDashboard);
router.get('/audit-log', getAuditLog);

// Phase 8 — Search Observability (additive)
const { listSearches, getSearchDetail, listExternalLogs } = require('./adminObservability.controller');
router.get('/searches', listSearches);
router.get('/searches/:requestId', getSearchDetail);
router.get('/external-logs', listExternalLogs);

// Infrastructure (§11.9)
router.get('/infra/mongo', getInfraMongo);
router.get('/infra/redis', getInfraRedis);
router.get('/infra/storage', getInfraStorage);

// Token usage & Agent activity
router.get('/tokens', getTokens);
router.get('/agents', getAgents);

// Cost Intelligence — Phase 6/11
const {
  getCostByRequestId,
  getDailyCost,
  getMonthlyCost,
  getCostSummary,
  getPricing,
  getCostBreakdown,
  getCostScaling,
} = require('./cost.controller');

router.get('/cost/pricing', getPricing);
router.get('/cost/request/:requestId', getCostByRequestId);
router.get('/cost/breakdown', getCostBreakdown);
router.get('/cost/scaling', getCostScaling);
router.get('/cost/daily', getDailyCost);
router.get('/cost/monthly', getMonthlyCost);
router.get('/cost/summary', getCostSummary);

// Help Desk — Tickets
router.get('/tickets', listTickets);
router.patch('/tickets/:id', updateTicketStatus);

// Help Desk — Articles
router.get('/articles', listHelpArticles);
router.post('/articles', createHelpArticle);
router.delete('/articles/:id', deleteHelpArticle);

// Announcements
const {
  listAllAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  toggleAnnouncement,
  deleteAnnouncement,
} = require('../announcement/announcement.controller');

router.get('/announcements', listAllAnnouncements);
router.post('/announcements', createAnnouncement);
router.patch('/announcements/:id/toggle', toggleAnnouncement);
router.patch('/announcements/:id', updateAnnouncement);
router.delete('/announcements/:id', deleteAnnouncement);

module.exports = router;
