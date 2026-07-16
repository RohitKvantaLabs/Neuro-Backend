const mongoose = require('mongoose');

// §11.1 — Repository.trust_tier is open/registered/restricted (access tier of the SOURCE).
// Do NOT conflate with Dataset.trust_tier (verified/unverified/stale — link-verification status).
const repositorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    trust_tier: { type: String, enum: ['open', 'registered', 'restricted'], default: 'open' },
    sync_status: { type: String, enum: ['online', 'syncing', 'offline'], default: 'offline' },
    last_sync_at: { type: Date, default: null },
    dataset_count: { type: Number, default: 0 },
    endpoint_config: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Repository', repositorySchema);
