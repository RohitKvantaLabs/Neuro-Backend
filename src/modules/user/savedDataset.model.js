const mongoose = require('mongoose');

// §10.3 — Denormalized snapshot: survives source dataset edits/deletions.
const savedDatasetSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Plain String (not ObjectId ref) so snapshot survives source doc deletion (§10.3)
    datasetId: { type: String, required: true },
    datasetSnapshot: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

savedDatasetSchema.index({ userId: 1, datasetId: 1 }, { unique: true });

module.exports = mongoose.model('SavedDataset', savedDatasetSchema);
