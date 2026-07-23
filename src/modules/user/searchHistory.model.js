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

// ponytail: replace find+sort+skip hook (3 ops/search) with count+conditional-delete.
// Only queries once per save; skips the delete entirely when under the cap.
searchHistorySchema.post('save', async function () {
  const Model = mongoose.model('SearchHistory');
  const count = await Model.countDocuments({ userId: this.userId });
  if (count > 30) {
    // Find the 30th-newest entry's createdAt and delete anything older.
    const [cutoff] = await Model
      .find({ userId: this.userId })
      .sort({ createdAt: -1 })
      .skip(29)
      .limit(1)
      .select('createdAt')
      .lean();
    if (cutoff) {
      await Model.deleteMany({ userId: this.userId, createdAt: { $lte: cutoff.createdAt, $ne: cutoff.createdAt } });
    }
  }
});

module.exports = mongoose.model('SearchHistory', searchHistorySchema);
