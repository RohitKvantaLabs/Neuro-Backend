const express = require('express');
const { login, verifyLoginOtp, listUsers, setUserActive, listDatasets, deleteDataset, getStats } = require('./admin.controller');
const { requireAuth, requireAdmin } = require('../auth/auth.middleware');
const { otpVerifyLimiter } = require('../../middleware/rateLimiter');

const router = express.Router();

router.post('/login', login);
router.post('/verify-login-otp', otpVerifyLimiter, verifyLoginOtp);

// everything below requires a valid access token AND role=admin
router.use(requireAuth, requireAdmin);

router.get('/stats', getStats);
router.get('/users', listUsers);
router.patch('/users/:userId/active', setUserActive);
router.get('/datasets', listDatasets);
router.delete('/datasets/:datasetId', deleteDataset);

module.exports = router;
