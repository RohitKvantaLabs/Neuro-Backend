const mongoose = require('mongoose');

const externalApiLogSchema = new mongoose.Schema(
  {
    requestId: { type: String, default: null },
    queryId: { type: String, default: null },
    service: { type: String, required: true }, // e.g. 'tavily', 'openneuro', 'dandi', 'zenodo'
    operation: { type: String, required: true }, // e.g. 'search', 'fetch', 'lookup'
    endpoint: { type: String, default: null }, // endpoint identifier, not full URL with secrets
    durationMs: { type: Number, default: 0 },
    status: { type: String, enum: ['success', 'error'], default: 'success' },
    httpStatus: { type: Number, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true }
);

externalApiLogSchema.index({ requestId: 1 });
externalApiLogSchema.index({ service: 1, createdAt: -1 });
externalApiLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('ExternalApiLog', externalApiLogSchema);
