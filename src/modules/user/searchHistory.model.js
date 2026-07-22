const mongoose = require('mongoose');

const searchHistorySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    query: { type: String, required: true, trim: true, maxlength: 500 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// §10.5: matches frontend's search_history_user_created_idx
searchHistorySchema.index({ userId: 1, createdAt: -1 });

// Keep at most 30 items per user — delete oldest when exceeded.
searchHistorySchema.post('save', async function () {
  const Model = mongoose.model('SearchHistory');
  const nthLatest = await Model
    .find({ userId: this.userId })
    .sort({ createdAt: -1 })
    .skip(29)
    .limit(1)
    .lean();
  if (nthLatest.length > 0) {
    await Model.deleteMany({
      userId: this.userId,
      createdAt: { $lt: nthLatest[0].createdAt },
    });
  }
});

module.exports = mongoose.model('SearchHistory', searchHistorySchema);
