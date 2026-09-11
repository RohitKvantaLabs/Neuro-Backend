const mongoose = require('mongoose');

const searchFeedbackSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    anonKey: { type: String, default: null, index: true },
    query: { type: String, required: true },
    filters: { type: mongoose.Schema.Types.Mixed, default: {} },
    rating: {
      type: String,
      enum: ['good', 'bad', 'none'],
      required: true,
    },
    reasons: [{ type: String }],
    comment: {
      type: String,
      default: null,
      maxlength: 1000,
      trim: true,
    },
    resultCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

searchFeedbackSchema.index({ userId: 1, createdAt: -1 });
searchFeedbackSchema.index({ createdAt: -1 });

module.exports = mongoose.model('SearchFeedback', searchFeedbackSchema);
