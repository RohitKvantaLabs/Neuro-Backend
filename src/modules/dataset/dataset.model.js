const mongoose = require('mongoose');

/**
 * MUST stay in sync with the Python service's app/models/dataset.py.
 * Field names and the trust_tier enum values are written by Python's
 * upsert_dataset() - Node only ever READS this collection (except
 * possibly admin manual edits). If Python's schema changes, this file
 * needs to change with it, or reads/writes will silently disagree.
 */
const datasetSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: { type: String, default: null },
    source: { type: String, required: true }, // e.g. "openneuro", "dandi", "web_search"
    source_id: { type: String, required: true },
    url: { type: String, required: true },

    modality: { type: [String], default: [] },
    species: { type: [String], default: [] },
    subject_count: { type: Number, default: null },
    keywords: { type: [String], default: [] },

    license: { type: String, default: null },

    trust_tier: {
      type: String,
      enum: ['verified', 'unverified', 'stale'],
      default: 'unverified',
    },
    confidence_score: { type: Number, default: null },
    is_direct_link: { type: Boolean, default: false },

    last_verified_at: { type: Date, default: null },
    ingested_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },

    // §10.1 — frontend display fields (optional, populated by pipeline or lookup table)
    region:      { type: String, default: null },
    age_group:   { type: String, default: null },
    disease:     { type: String, default: null },
    access_tier: { type: String, enum: ['open', 'registered', 'restricted', null], default: null },
    doi:         { type: String, default: null },
    size_label:  { type: String, default: null }, // human-readable e.g. "184 GB"
  },
  {
    collection: 'datasets', // must match Python's COLLECTION_NAME in dataset_repository.py
    timestamps: false, // Python manages ingested_at/updated_at itself
  }
);

datasetSchema.index({ source: 1, source_id: 1 }, { unique: true });

module.exports = mongoose.model('Dataset', datasetSchema);
