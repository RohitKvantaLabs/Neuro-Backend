const express = require('express');
const { createCollection, listCollections, deleteCollection, addItem, removeItem, getItems } = require('./collection.controller');

const router = express.Router();

router.post('/', createCollection);
router.get('/', listCollections);
router.delete('/:id', deleteCollection);
router.get('/:id/items', getItems);
router.post('/:id/items', addItem);
router.delete('/:id/items/:savedDatasetId', removeItem);

module.exports = router;
