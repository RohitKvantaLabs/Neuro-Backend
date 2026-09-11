const express = require('express');
const { getMyHistory, submitSearchFeedback } = require('./queryLog.controller');
const { requireAuth, optionalAuth } = require('../auth/auth.middleware');

const router = express.Router();

router.get('/me', requireAuth, getMyHistory);
router.post('/feedback', optionalAuth, submitSearchFeedback);

module.exports = router;
