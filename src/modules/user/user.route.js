const express = require('express');
const { requireAuth } = require('../auth/auth.middleware');
const { requireOnboardingComplete } = require('../../middleware/requireOnboardingComplete');
const { getMe, updateMe, updateNotifications, deleteAccount, cancelDeletion } = require('./user.controller');

const savedDatasetRoutes = require('./savedDataset.routes');
const collectionRoutes = require('./collection.routes');
const searchHistoryRoutes = require('./searchHistory.routes');
const socialLinkRoutes = require('./socialLink.routes');

const router = express.Router();

// All /users routes require authentication
router.use(requireAuth);

// §10.7: GET /users/me — reachable pre-onboarding (no requireOnboardingComplete here)
router.get('/me', getMe);
router.put('/me', requireOnboardingComplete, updateMe);
router.patch('/me/notifications', requireOnboardingComplete, updateNotifications);

// §10.8: DELETE /users/me — soft delete with 30-day grace period
router.delete('/me', deleteAccount);
router.post('/cancel-deletion', cancelDeletion);

// §10.3–10.6: Dashboard-facing sub-routes — all gated behind onboarding
router.use('/saved-datasets', requireOnboardingComplete, savedDatasetRoutes);
router.use('/collections', requireOnboardingComplete, collectionRoutes);
router.use('/search-history', requireOnboardingComplete, searchHistoryRoutes);
router.use('/social-links', requireOnboardingComplete, socialLinkRoutes);

module.exports = router;
