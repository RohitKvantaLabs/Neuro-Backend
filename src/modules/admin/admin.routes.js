const express = require('express');
const {
  login, verifyLoginOtp,
  getAdmins,
  listUsers, deleteUser,
  listDatasets, deleteDataset,
  listRepositories, createRepository, deleteRepository, resyncRepository,
  getAnalytics, getDashboard, getAuditLog,
  getInfraMongo, getInfraRedis, getInfraStorage,
  getTokens, getAgents,
} = require('./admin.controller');
const { requireAuth, requireAdmin } = require('../auth/auth.middleware');
const { otpVerifyLimiter, loginLimiter } = require('../../middleware/rateLimiter');

const router = express.Router();

// ── Public auth routes ───────────────────────────────────────────────────────
router.post('/login', loginLimiter, login);
router.post('/verify-login-otp', otpVerifyLimiter, verifyLoginOtp);

// ── All routes below require a valid admin access token ──────────────────────
router.use(requireAuth, requireAdmin);

// Users
router.get('/users', listUsers);
router.delete('/users/:id', deleteUser);             // §11.2

// Datasets (pre-existing)
router.get('/datasets', listDatasets);
router.delete('/datasets/:datasetId', deleteDataset);

// Repositories (§11.1)
router.get('/repositories', listRepositories);
router.post('/repositories', createRepository);
router.delete('/repositories/:id', deleteRepository);
router.post('/repositories/:id/resync', resyncRepository);


// Admin accounts
router.get('/admins', getAdmins);

// Analytics, Dashboard, Audit log (§11.5, §11.8, §11.6)
router.get('/analytics', getAnalytics);
router.get('/dashboard', getDashboard);
router.get('/audit-log', getAuditLog);

// Infrastructure (§11.9)
router.get('/infra/mongo', getInfraMongo);
router.get('/infra/redis', getInfraRedis);
router.get('/infra/storage', getInfraStorage);

// Token usage & Agent activity
router.get('/tokens', getTokens);
router.get('/agents', getAgents);

module.exports = router;
