const mongoose = require('mongoose');

const queryLogSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // null for anonymous searches, if allowed
    rawQuery: { type: String, required: true },
    filters: { type: mongoose.Schema.Types.Mixed, default: {} },
    // resultSource values written by dataset.controller.js:
    //   legacy path   → 'cache' | 'fallback'
    //   new orchestrator (FF_USE_NEW_ORCHESTRATOR=true) → orchestratorResult.source, which is 'cache' | 'merged'
    resultSource: { type: String, enum: ['cache', 'fallback', 'merged'], required: true },
    resultCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// ponytail: compound index for per-user analytics and admin queries sorted by time.
queryLogSchema.index({ userId: 1, createdAt: -1 });
queryLogSchema.index({ createdAt: -1 }); // admin dashboard sort

module.exports = mongoose.model('QueryLog', queryLogSchema);
