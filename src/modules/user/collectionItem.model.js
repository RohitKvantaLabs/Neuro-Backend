const mongoose = require('mongoose');

const collectionItemSchema = new mongoose.Schema(
  {
    collectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Collection', required: true },
    savedDatasetId: { type: mongoose.Schema.Types.ObjectId, ref: 'SavedDataset', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

collectionItemSchema.index({ collectionId: 1, savedDatasetId: 1 }, { unique: true });

module.exports = mongoose.model('CollectionItem', collectionItemSchema);
