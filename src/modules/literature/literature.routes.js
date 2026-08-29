'use strict';

const express = require('express');
const { searchLiterature } = require('./literature.controller');
const { requireAuth } = require('../auth/auth.middleware');
const { requireOnboardingComplete } = require('../../middleware/requireOnboardingComplete');
const { searchLimiter } = require('../../middleware/rateLimiter');

const router = express.Router();

router.post('/search', requireAuth, requireOnboardingComplete, searchLimiter, searchLiterature);

module.exports = router;
