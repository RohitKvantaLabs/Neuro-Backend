const express = require('express');
const { saveDataset, listSavedDatasets, deleteSavedDataset } = require('./savedDataset.controller');

const router = express.Router();

router.post('/', saveDataset);
router.get('/', listSavedDatasets);
router.delete('/:id', deleteSavedDataset);

module.exports = router;

