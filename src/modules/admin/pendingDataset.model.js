const mongoose = require('mongoose');

// §11.3 — Mirrors dataset.model.js field-for-field (per §3 Pydantic contract),
// plus three review-workflow fields that do NOT exist on the public Dataset shape.
// Python is the writer of this collection — Node only reads and mutates status/rejectionReason.
const pendingDatasetSchema = new mongoose.Schema(
  {
    // ── Core fields mirrored from dataset.model.js ──────────────────────────
    title: { type: String, required: true },
    description: { type: String, default: null },
    source: { type: String, required: true },
    source_id: { type: String, required: true },
    url: { type: String, required: true },

    modality: { type: [String], default: [] },
    species: { type: [String], default: [] },
    subject_count: { type: Number, default: null },
    keywords: { type: [String], default: [] },

    license: { type: String, default: null },

    // Dataset trust_tier enum (verified/unverified/stale) — NOT Repository's enum
    trust_tier: { type: String, enum: ['verified', 'unverified', 'stale'], default: 'unverified' },
    confidence_score: { type: Number, default: null },
    is_direct_link: { type: Boolean, default: false },

    last_verified_at: { type: Date, default: null },
    ingested_at: { type: Date, default: null },
    updated_at: { type: Date, default: null },

    // ── Review-workflow fields (NOT on public Dataset shape) ─────────────────
    source_query: { type: String, required: true },   // what search triggered discovery
    discovered_at: { type: Date, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    rejectionReason: { type: String, default: null }, // kept on reject for admin history
  },
  { timestamps: true }
);

// Same compound unique index as Dataset (source is the writer, same constraint)
pendingDatasetSchema.index({ source: 1, source_id: 1 }, { unique: true });

module.exports = mongoose.model('PendingDataset', pendingDatasetSchema);
