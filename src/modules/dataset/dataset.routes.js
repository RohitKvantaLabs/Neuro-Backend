const express = require('express');
const { search } = require('./dataset.controller');
const { requireAuth } = require('../auth/auth.middleware');
const { searchLimiter } = require('../../middleware/rateLimiter');

const router = express.Router();

// requireAuth enforced per spec: anonymous users MUST NOT trigger LLM/Tavily calls
router.post('/search', requireAuth, searchLimiter, search);

module.exports = router;
