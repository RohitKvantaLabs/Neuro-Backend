const mongoose = require('mongoose');

const datasetReactionSchema = new mongoose.Schema(
  {
    datasetId: { type: String, required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    anonKey: { type: String, default: null, index: true },
    reaction: {
      type: String,
      enum: ['like', 'dislike'],
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index to ensure a registered user or anonymous token has at most one reaction per dataset
datasetReactionSchema.index(
  { datasetId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } }
);

datasetReactionSchema.index(
  { datasetId: 1, anonKey: 1 },
  { unique: true, partialFilterExpression: { anonKey: { $type: 'string' } } }
);

module.exports = mongoose.model('DatasetReaction', datasetReactionSchema);
