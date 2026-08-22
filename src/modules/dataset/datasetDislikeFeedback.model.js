const mongoose = require('mongoose');

/**
 * VALID_REASONS is the single source of truth shared with the controller.
 * Keep these IDs in sync with the frontend DISLIKE_REASONS constant.
 */
const VALID_REASONS = [
  'metadata_incorrect',
  'data_incomplete',
  'quality_concern',
  'duplicate',
  'broken_link',
  'wrong_modality_disease',
  'irrelevant',
  'other',
];

const datasetDislikeFeedbackSchema = new mongoose.Schema(
  {
    datasetId: { type: String, required: true, index: true },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    anonKey: { type: String, default: null, index: true },
    reason: {
      type: String,
      enum: VALID_REASONS,
      required: true,
    },
    comment: {
      type: String,
      default: null,
      maxlength: 1000,
      trim: true,
    },
    // Lifecycle status — tracks whether feedback is still associated with an
    // active dislike or was superseded by the user switching to like/none.
    status: {
      type: String,
      enum: ['pending', 'reviewed', 'resolved', 'dismissed_by_user', 'dismissed_by_admin'],
      default: 'pending',
      index: true,
    },
    // Admin-facing fields (Phase 3+); null in Phase 1.
    adminNotes: { type: String, default: null },
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// One feedback document per user/anonKey per dataset.
// On re-dislike we upsert, so uniqueness is enforced at the application layer
// via findOneAndUpdate with upsert:true. No unique index here to avoid the
// dual-index complexity of DatasetReaction while supporting upsert cleanly.
datasetDislikeFeedbackSchema.index({ datasetId: 1, userId: 1 });
datasetDislikeFeedbackSchema.index({ datasetId: 1, anonKey: 1 });
// Admin queue queries: filter pending feedback, order by newest.
datasetDislikeFeedbackSchema.index({ status: 1, createdAt: -1 });

module.exports = {
  DatasetDislikeFeedback: mongoose.model('DatasetDislikeFeedback', datasetDislikeFeedbackSchema),
  VALID_REASONS,
};
