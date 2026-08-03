const express = require('express');

const authRoutes = require('../modules/auth/auth.routes');
const userRoutes = require('../modules/user/user.route');
const adminRoutes = require('../modules/admin/admin.routes');
const datasetRoutes = require('../modules/dataset/dataset.routes');
const queryLogRoutes = require('../modules/queryLog/queryLog.routes');
const { requireAuth } = require('../modules/auth/auth.middleware');
const { requireOnboardingComplete } = require('../middleware/requireOnboardingComplete');
const { listRepositories } = require('../modules/admin/admin.controller');

const announcementRoutes = require('../modules/announcement/announcement.routes');

const router = express.Router();

router.get('/health', (req, res) => res.json({ status: 'ok' }));

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/admin', adminRoutes);
router.use('/announcements', announcementRoutes);

// §public — repository list for landing page; no auth required
router.get('/repositories', listRepositories);

// §10.2: Dataset search & subroutes handled by datasetRoutes
router.use('/datasets', datasetRoutes);

router.use('/query-logs', queryLogRoutes);
// ponytail: /stream SSE route unmounted — replaced by blocking search flow

module.exports = router;
