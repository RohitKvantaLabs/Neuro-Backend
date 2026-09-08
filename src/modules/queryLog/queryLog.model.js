const mongoose = require('mongoose');

const queryLogSchema = new mongoose.Schema(
  {
    requestId: { type: String, default: null },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // null for anonymous searches, if allowed
    rawQuery: { type: String, required: true },
    filters: { type: mongoose.Schema.Types.Mixed, default: {} },
    // resultSource values written by dataset.controller.js:
    //   legacy path   → 'cache' | 'fallback'
    //   new orchestrator (FF_USE_NEW_ORCHESTRATOR=true) → orchestratorResult.source, which is 'cache' | 'merged' | 'out_of_domain'
    resultSource: { type: String, enum: ['cache', 'fallback', 'merged', 'out_of_domain'], required: true },
    resultCount: { type: Number, default: 0 },
    // Phase 2 four-way provenance — optional, for internal telemetry/admin observability.
    // Stores final ranked provenance distribution; historical docs remain valid (default null).
    provenance: { type: mongoose.Schema.Types.Mixed, default: null },
    // Phase 7 — stage timing observability (additive, nullable). Stores wall-clock ms per stage;
    // null/absent means stage was skipped (cache or policy) and must NOT be fabricated.
    // Individual ExternalApiLog durations remain per-call; repositoryMs is wall-clock (parallel), not sum.
    timings: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

// ponytail: compound index for per-user analytics and admin queries sorted by time.
queryLogSchema.index({ userId: 1, createdAt: -1 });
queryLogSchema.index({ createdAt: -1 }); // admin dashboard sort
queryLogSchema.index({ requestId: 1 }); // Phase 8: correlated detail lookup
queryLogSchema.index({ resultSource: 1, createdAt: -1 }); // Phase 8: analytics filter
queryLogSchema.index({ 'timings.totalMs': 1 }); // Phase 8: performance sort (sparse)

module.exports = mongoose.model('QueryLog', queryLogSchema);
