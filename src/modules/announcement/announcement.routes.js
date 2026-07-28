const express = require('express');
const { listActiveAnnouncements } = require('./announcement.controller');

const router = express.Router();

// GET /api/v1/announcements — Public endpoint accessible by all users & guest visitors
router.get('/', listActiveAnnouncements);

module.exports = router;
