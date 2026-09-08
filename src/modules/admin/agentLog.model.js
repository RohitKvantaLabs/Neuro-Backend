const mongoose = require('mongoose');

const agentLogSchema = new mongoose.Schema(
  {
    requestId: { type: String, default: null },
    queryId: { type: String, default: null },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    agent: { type: String, required: true }, // e.g. 'fallback', 'search_provider', 'link_verifier', 'parse_query'
    provider: { type: String, default: null }, // e.g. 'groq', 'heuristic'
    model: { type: String, default: null },
    query: { type: String, default: '' },
    durationMs: { type: Number, default: 0 },
    resultCount: { type: Number, default: 0 },
    status: { type: String, enum: ['success', 'error'], default: 'success' },
    errorMessage: { type: String, default: null },
  },
  { timestamps: true }
);

agentLogSchema.index({ createdAt: -1 });
agentLogSchema.index({ agent: 1, createdAt: -1 });
agentLogSchema.index({ requestId: 1 });
agentLogSchema.index({ queryId: 1 });

module.exports = mongoose.model('AgentLog', agentLogSchema);
