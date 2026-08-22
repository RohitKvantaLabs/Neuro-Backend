const mongoose = require('mongoose');

/**
 * ALLOWED_OVERRIDE_FIELDS is the single source of truth for editable fields.
 * Any fields outside this list (especially _id, source, source_id, url, doi, ingested_at)
 * are rejected at the controller boundary to preserve upstream traceability.
 */
const ALLOWED_OVERRIDE_FIELDS = [
  'title',
  'description',
  'modality',
  'species',
  'disease',
  'tasks',
  'region',
  'ageGroup',
  'subjects',
  'size',
  'publicationYear',
  'studyDesign',
];

const adminDatasetOverrideSchema = new mongoose.Schema(
  {
    datasetId: { type: String, required: true, unique: true, index: true },

    title: { type: String, default: null },
    description: { type: String, default: null },
    modality: { type: [String], default: null },
    species: { type: [String], default: null },
    disease: { type: String, default: null },
    tasks: { type: [String], default: null },
    region: { type: String, default: null },
    ageGroup: { type: String, default: null },
    subjects: { type: Number, default: null },
    size: { type: String, default: null },
    publicationYear: { type: Number, default: null },
    studyDesign: { type: String, default: null },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  {
    collection: 'admindatasetoverrides',
    timestamps: true,
  }
);

module.exports = {
  AdminDatasetOverride: mongoose.model('AdminDatasetOverride', adminDatasetOverrideSchema),
  ALLOWED_OVERRIDE_FIELDS,
};
