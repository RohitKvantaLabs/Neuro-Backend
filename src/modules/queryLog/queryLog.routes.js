const express = require('express');
const { getMyHistory } = require('./queryLog.controller');
const { requireAuth } = require('../auth/auth.middleware');

const router = express.Router();

router.get('/me', requireAuth, getMyHistory);

module.exports = router;
