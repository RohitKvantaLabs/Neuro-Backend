const SavedDataset = require('./savedDataset.model');
const Dataset = require('../dataset/dataset.model');
const ApiError = require('../../utils/ApiError');
const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');

// §10.3: Server builds snapshot from trusted fields — client only sends { datasetId }
const SNAPSHOT_FIELDS = 'title description source source_id url modality species subject_count keywords license trust_tier region age_group disease access_tier doi size_label';

// POST /users/saved-datasets — upsert (matches frontend's onConflict: 'user_id,dataset_id')
const saveDataset = asyncHandler(async (req, res) => {
  const { datasetId } = req.body;
  if (!datasetId) throw new ApiError(400, 'datasetId is required.');

  const source = await Dataset.findById(datasetId).select(SNAPSHOT_FIELDS).lean();
  if (!source) throw new ApiError(404, 'Dataset not found.');

  // §limit: 30 saved datasets per user
  const count = await SavedDataset.countDocuments({ userId: req.user.id });
  const exists = await SavedDataset.exists({ userId: req.user.id, datasetId });
  if (!exists && count >= 30) throw new ApiError(400, 'You can save up to 30 datasets. Remove some to add new ones.');

  const saved = await SavedDataset.findOneAndUpdate(
    { userId: req.user.id, datasetId },
    { datasetSnapshot: source },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return new ApiResponse(201, saved, 'Dataset saved.').send(res);
});

// GET /users/saved-datasets
const listSavedDatasets = asyncHandler(async (req, res) => {
  const items = await SavedDataset.find({ userId: req.user.id }).sort({ createdAt: -1 }).lean();
  return new ApiResponse(200, items).send(res);
});

// DELETE /users/saved-datasets/:id — ownership-checked
const deleteSavedDataset = asyncHandler(async (req, res) => {
  const doc = await SavedDataset.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
  if (!doc) throw new ApiError(404, 'Saved dataset not found.');
  return new ApiResponse(200, null, 'Removed from saved datasets.').send(res);
});

module.exports = { saveDataset, listSavedDatasets, deleteSavedDataset };
