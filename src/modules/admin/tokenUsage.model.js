const mongoose = require('mongoose');

const tokenUsageSchema = new mongoose.Schema(
  {
    requestId: { type: String, default: null },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    userEmail: { type: String, default: 'anonymous' },
    agent: { type: String, required: true }, // e.g. 'fallback', 'search_provider', 'link_verifier', 'parse_query'
    provider: { type: String, default: null }, // e.g. 'groq', 'heuristic'
    model: { type: String, default: 'unknown' }, // e.g. 'gpt-4', 'gpt-3.5-turbo'
    tokens: { type: Number, required: true, default: 0 }, // legacy total, kept for backward compat
    inputTokens: { type: Number, default: null },
    outputTokens: { type: Number, default: null },
    totalTokens: { type: Number, default: null },
    usageType: { type: String, enum: ['actual', 'estimated'], default: null },
    query: { type: String, default: '' },
    durationMs: { type: Number, default: 0 },
    status: { type: String, enum: ['success', 'error'], default: 'success' },
  },
  { timestamps: true }
);

tokenUsageSchema.index({ createdAt: -1 });
tokenUsageSchema.index({ agent: 1, createdAt: -1 });
tokenUsageSchema.index({ userEmail: 1, createdAt: -1 });
tokenUsageSchema.index({ requestId: 1 });
tokenUsageSchema.index({ provider: 1, model: 1 });

module.exports = mongoose.model('TokenUsage', tokenUsageSchema);
