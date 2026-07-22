const mongoose = require('mongoose');

const agentLogSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    agent: { type: String, required: true }, // e.g. 'fallback', 'search_provider', 'link_verifier'
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

module.exports = mongoose.model('AgentLog', agentLogSchema);
