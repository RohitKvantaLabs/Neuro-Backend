const express = require('express');
const { listHistory, clearHistory, deleteHistoryItem } = require('./searchHistory.controller');

const router = express.Router();

router.get('/', listHistory);
router.delete('/', clearHistory);
router.delete('/:id', deleteHistoryItem);

module.exports = router;
