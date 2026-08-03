const express = require('express');
const { search, getById } = require('./dataset.controller');
const { toggleReaction, getReactionsBatch } = require('./datasetReaction.controller');
const { requireAuth, optionalAuth } = require('../auth/auth.middleware');
const { requireOnboardingComplete } = require('../../middleware/requireOnboardingComplete');
const { searchLimiter } = require('../../middleware/rateLimiter');

const router = express.Router();

// requireAuth & requireOnboardingComplete enforced per spec for dataset search
router.post('/search', requireAuth, requireOnboardingComplete, searchLimiter, search);

// Dataset search reactions (like / dislike) by dataset serial number / ID
router.post('/reactions', optionalAuth, toggleReaction);
router.post('/reactions/batch', optionalAuth, getReactionsBatch);

// Public read — no auth needed for dataset detail page
router.get('/:id', getById);

module.exports = router;
