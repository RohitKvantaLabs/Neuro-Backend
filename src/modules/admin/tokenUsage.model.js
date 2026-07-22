const mongoose = require('mongoose');

const tokenUsageSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    userEmail: { type: String, default: 'anonymous' },
    agent: { type: String, required: true }, // e.g. 'fallback', 'search_provider', 'link_verifier', 'parse_query'
    model: { type: String, default: 'unknown' }, // e.g. 'gpt-4', 'gpt-3.5-turbo'
    tokens: { type: Number, required: true, default: 0 },
    query: { type: String, default: '' },
    durationMs: { type: Number, default: 0 },
    status: { type: String, enum: ['success', 'error'], default: 'success' },
  },
  { timestamps: true }
);

tokenUsageSchema.index({ createdAt: -1 });
tokenUsageSchema.index({ agent: 1, createdAt: -1 });
tokenUsageSchema.index({ userEmail: 1, createdAt: -1 });

module.exports = mongoose.model('TokenUsage', tokenUsageSchema);
