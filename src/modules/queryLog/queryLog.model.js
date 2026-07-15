const mongoose = require('mongoose');

const queryLogSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // null for anonymous searches, if allowed
    rawQuery: { type: String, required: true },
    filters: { type: mongoose.Schema.Types.Mixed, default: {} },
    resultSource: { type: String, enum: ['cache', 'fallback'], required: true },
    resultCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('QueryLog', queryLogSchema);
