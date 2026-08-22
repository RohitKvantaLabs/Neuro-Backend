const mongoose = require('mongoose');

const POPULAR_STATUSES = ['draft', 'published', 'unpublished', 'archived'];

const popularDatasetSchema = new mongoose.Schema(
  {
    datasetId: { type: String, required: true, unique: true, index: true },

    status: {
      type: String,
      enum: POPULAR_STATUSES,
      default: 'draft',
      index: true,
    },

    displayOrder: { type: Number, default: 0, index: true },
    featuredTitleOverride: { type: String, default: null },

    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    publishedAt: { type: Date, default: null },
  },
  {
    collection: 'populardatasets',
    timestamps: true,
  }
);

// Compound index for user-facing query: published items ordered by displayOrder
popularDatasetSchema.index({ status: 1, displayOrder: 1 });

module.exports = {
  PopularDataset: mongoose.model('PopularDataset', popularDatasetSchema),
  POPULAR_STATUSES,
};
