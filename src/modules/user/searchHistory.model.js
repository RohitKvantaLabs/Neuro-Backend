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

// §10.5: Enforce a 30-entry cap per user. Uses ObjectId ordering (monotonically
// increasing per process) instead of createdAt to narrow the race window between
// the find and the delete.  A single findOne + deleteMany is still non-atomic,
// but using _id guarantees strict ordering (createdAt can have ties at ms
// precision).
searchHistorySchema.post('save', async function () {
  const Model = mongoose.model('SearchHistory');
  // Find the _id of the 30th-newest entry; ObjectId embeds a timestamp
  // and orders strictly by insertion.
  const cutoff = await Model
    .findOne({ userId: this.userId })
    .sort({ _id: -1 })
    .skip(29)
    .select('_id')
    .lean();
  if (cutoff) {
    // Atomic single-query delete — every document with _id older than cutoff
    await Model.deleteMany({ userId: this.userId, _id: { $lt: cutoff._id } });
  }
});

module.exports = mongoose.model('SearchHistory', searchHistorySchema);
