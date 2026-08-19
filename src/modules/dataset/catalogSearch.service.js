/**
 * CatalogSearchService
 *
 * Isolated retrieval module for the `neurosearch_dataset_catalog` collection.
 *
 * Responsibilities (Option B — Fully Hybrid Retrieval):
 *   - catalogSearch(filters, limit) — same return shape as searchDatasets() so
 *     the orchestrator step 3b wiring is a single parallel call.
 *   - Modality synonym expansion using the same synonym families as rankingEngine.js
 *     MODALITY_SYNONYMS plus catalog-native aliases (design §10).
 *   - Primary-source selection from sources[] (design §7).
 *   - Catalog → pipeline projection (design §6).
 *   - Failure: throws → orchestrator catch → catalogResults = [].
 *
 * Constraints (strictly followed):
 *   - Reads ONLY `neurosearch_dataset_catalog`. Never reads or writes `datasets`.
 *   - Does NOT create indexes. Regex-only (collection scan, safe for 7,320 docs).
 *   - Does NOT invent quality_score, trust_tier, or confidence_score values.
 *   - Existing dedup key `source:source_id` is reconstructed from the primary source
 *     so rankingEngine.js deduplicate() works without modification.
 */

'use strict';

const mongoose = require('mongoose');
const logger   = require('../../utils/logger');

// ponytail: 200 gives the ranker enough headroom (~30x final top-30) without
// pulling the whole 7,320-doc collection.
const CATALOG_CANDIDATE_LIMIT = 200;

// ── Catalog Mongoose model (read-only access) ─────────────────────────────────
// strict:false avoids maintaining a full mirror of the Python schema here.
// The catalog collection is written exclusively by Python; this model never mutates it.
let CatalogDataset;
function getCatalogModel() {
  if (CatalogDataset) return CatalogDataset;
  const schema = new mongoose.Schema({}, {
    collection: 'neurosearch_dataset_catalog',
    strict: false,
    timestamps: false,
  });
  CatalogDataset = mongoose.model('CatalogDataset', schema);
  return CatalogDataset;
}

// ── Modality synonym expansion (design §10) ───────────────────────────────────
// Mirrors MODALITY_SYNONYMS in rankingEngine.js and adds catalog-native aliases
// for values observed in the catalog (mri->imaging, eeg->electrophysiology, etc.).
// QUERY-SIDE ONLY — stored catalog values are never modified.
const CATALOG_MODALITY_MAP = {
  meg:           ['meg', 'magnetoencephalography'],
  fmri:          ['fmri', 'mri', 'functional mri', 'functional magnetic resonance imaging', 'func', 'bold'],
  'functional mri': ['fmri', 'mri', 'functional mri', 'functional magnetic resonance imaging', 'func', 'bold'],
  'functional magnetic resonance imaging': ['fmri', 'mri', 'functional mri'],
  smri:          ['smri', 'mri', 'anat', 't1w', 't2w'],
  'structural mri': ['smri', 'mri', 'anat', 't1w', 't2w'],
  mri:           ['mri', 'fmri', 'smri', 'anat', 'imaging', 'func', 't1w', 't2w', 'bold', 'sbref', 'dwi', 'dti', 'fmap', 'fieldmap', 'perf'],
  eeg:           ['eeg', 'electroencephalography', 'electrophysiology'],
  electroencephalography: ['eeg', 'electroencephalography', 'electrophysiology'],
  ieeg:          ['ieeg', 'intracranial eeg', 'ecog'],
  ecog:          ['ecog', 'ieeg', 'intracranial eeg'],
  dti:           ['dti', 'dwi', 'diffusion mri', 'diffusion tensor imaging', 'mri'],
  dwi:           ['dwi', 'dti', 'diffusion mri', 'diffusion tensor imaging'],
  'diffusion mri': ['dti', 'dwi', 'diffusion mri', 'diffusion tensor imaging', 'mri'],
  'diffusion tensor imaging': ['dti', 'dwi', 'diffusion mri', 'diffusion tensor imaging'],
  nirs:          ['nirs', 'fnirs', 'functional near-infrared spectroscopy'],
  fnirs:         ['fnirs', 'nirs', 'functional near-infrared spectroscopy'],
  pet:           ['pet', 'positron emission tomography'],
};

/**
 * Expand a single modality string into the set of catalog vocab terms to OR-match.
 * @param {string} mod
 * @returns {string[]}
 */
function expandModality(mod) {
  const key = String(mod || '').trim().toLowerCase();
  const synonyms = CATALOG_MODALITY_MAP[key];
  return synonyms ? [...new Set(synonyms)] : [key];
}

// ── Query builder ─────────────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toRegex(str) {
  return new RegExp(escapeRegex(String(str || '').trim()), 'i');
}

/**
 * Build a MongoDB filter for `neurosearch_dataset_catalog` from QueryFilters.
 *
 * Regex-only (no $text — no text index on catalog).
 * Fields targeted per catalog schema (design §6):
 *   raw_query  -> title, description, keywords
 *   modality   -> modality[] (synonym-expanded)
 *   species    -> species[]
 *   condition  -> disease[] (catalog stores array)
 *   task       -> tasks[], keywords[]
 *   region     -> brainRegions[]
 *   age_group  -> ageGroup[]
 *   format     -> keywords[]
 *   avail      -> availability
 *
 * @param {Object} filters - QueryFilters from parseQuery
 * @returns {Object} MongoDB filter
 */
function buildCatalogQuery(filters) {
  const f = (filters && typeof filters === 'object') ? filters : {};
  const andClauses = [];

  const addOr = (orClauses) => {
    if (orClauses.length > 0) andClauses.push({ $or: orClauses });
  };

  // raw_query: tokenize and OR across title/description/keywords
  if (f.raw_query && typeof f.raw_query === 'string' && f.raw_query.trim()) {
    const tokens = f.raw_query.trim().split(/\s+/).filter((t) => t.length >= 2).map(toRegex);
    if (tokens.length > 0) {
      const textOr = [];
      for (const rx of tokens) {
        textOr.push({ title: rx }, { description: rx }, { keywords: rx });
      }
      addOr(textOr);
    }
  }

  // modality: synonym-expanded OR
  const modalities = Array.isArray(f.modality) ? f.modality : (f.modality ? [f.modality] : []);
  if (modalities.length > 0) {
    const expanded = [...new Set(modalities.flatMap(expandModality))];
    addOr(expanded.map((m) => ({ modality: toRegex(m) })));
  }

  // species
  const species = Array.isArray(f.species) ? f.species : (f.species ? [f.species] : []);
  if (species.length > 0) {
    addOr(species.map((s) => ({ species: toRegex(s) })));
  }

  // condition/disease -> catalog disease[] (array field; regex works on array)
  const conditions = Array.isArray(f.condition)
    ? f.condition
    : (f.condition ? [f.condition] : (f.disease ? [f.disease] : []));
  if (conditions.length > 0) {
    addOr(conditions.map((c) => ({ disease: toRegex(c) })));
  }

  // task -> tasks[], keywords[]
  if (f.task) {
    const taskTerms = Array.isArray(f.task) ? f.task : [f.task];
    const taskOr = taskTerms.flatMap((t) => [{ tasks: toRegex(t) }, { keywords: toRegex(t) }]);
    addOr(taskOr);
  }

  // region -> brainRegions[] (catalog field; pipeline reads `region`)
  if (f.region) {
    addOr([{ brainRegions: toRegex(f.region) }]);
  }

  // age_group / age_range -> ageGroup[]
  const ageVal = f.age_group || f.age_range;
  if (ageVal) {
    addOr([{ ageGroup: toRegex(ageVal) }]);
  }

  // format -> keywords[]
  const formats = Array.isArray(f.format) ? f.format : (f.format ? [f.format] : []);
  if (formats.length > 0) {
    addOr(formats.map((fmt) => ({ keywords: toRegex(fmt) })));
  }

  // availability
  const avail = f.availability || f.access_tier;
  if (avail) {
    andClauses.push({ availability: toRegex(avail) });
  }

  return andClauses.length > 0 ? { $and: andClauses } : {};
}

// ── Primary source selection (design §7) ──────────────────────────────────────

/**
 * Select the "primary" source from a catalog doc's sources[] array.
 *
 * Priority:
 *   1. Source whose doi matches provenance.identity.doi
 *   2. Source whose sourceUrl matches provenance.identity.sourceUrlNorm
 *   3. Source whose repository:sourceDatasetId matches provenance.identity.primary
 *   4. First source (fallback)
 *
 * @param {Object} doc - raw catalog document
 * @returns {Object|null}
 */
function selectPrimarySource(doc) {
  const sources = doc.sources;
  if (!Array.isArray(sources) || sources.length === 0) return null;
  if (sources.length === 1) return sources[0];

  const identity = doc.provenance && doc.provenance.identity ? doc.provenance.identity : {};
  const doiNorm  = (identity.doi || '').toLowerCase().trim();
  const urlNorm  = (identity.sourceUrlNorm || '').toLowerCase().trim();
  const primary  = (identity.primary || '').toLowerCase().trim();

  // 1: matching DOI
  if (doiNorm) {
    const m = sources.find((s) => (s.doi || '').toLowerCase().trim() === doiNorm);
    if (m) return m;
  }

  // 2: matching normalized source URL
  if (urlNorm) {
    const m = sources.find((s) => (s.sourceUrl || '').toLowerCase().trim() === urlNorm);
    if (m) return m;
  }

  // 3: primary identity in repo:id format
  if (primary && !primary.startsWith('doi:') && !primary.startsWith('url:')) {
    const colonIdx = primary.indexOf(':');
    if (colonIdx > 0) {
      const repo = primary.slice(0, colonIdx);
      const id   = primary.slice(colonIdx + 1);
      const m = sources.find(
        (s) => (s.repository || '').toLowerCase() === repo &&
               String(s.sourceDatasetId || '').toLowerCase() === id
      );
      if (m) return m;
    }
  }

  return sources[0];
}

// ── Catalog -> pipeline projection (design §6) ────────────────────────────────

/**
 * Project a catalog document into the shape the existing pipeline expects.
 *
 * quality_score and trust_tier are intentionally left null:
 *   - rankingEngine.js:296 computeQualityScore() has an existing fallback.
 *   - rankingEngine.js:328 computeTrustScore() returns 0.5 (neutral/unverified).
 * Neither value is invented.
 *
 * disease: catalog stores array; ranker reads string.
 * Projection: disease.join(' ') — approved Q1.
 *
 * @param {Object} doc - raw catalog document (from .lean())
 * @returns {Object|null} pipeline-shaped document, or null if required fields missing
 */
function projectCatalogDoc(doc) {
  if (!doc) return null;

  const primary = selectPrimarySource(doc);

  const title    = doc.title || (primary && primary.title) || null;
  const source   = (primary && primary.repository) || null;
  const sourceId = primary ? String(primary.sourceDatasetId || '') : null;

  // Required: drop doc if title/source/source_id absent (per design §15 validation rule)
  if (!title || !source || !sourceId) return null;

  // disease: array -> string
  let diseaseStr = null;
  if (Array.isArray(doc.disease) && doc.disease.length > 0) {
    diseaseStr = doc.disease.filter(Boolean).join(' ');
  } else if (typeof doc.disease === 'string' && doc.disease) {
    diseaseStr = doc.disease;
  }

  // brainRegions[] -> region (string, as the pipeline reads `dataset.region`)
  let region = null;
  if (Array.isArray(doc.brainRegions) && doc.brainRegions.length > 0) {
    region = doc.brainRegions.join(' ');
  }

  // ageGroup[] -> age_group (string, as the pipeline reads `dataset.age_group`)
  let ageGroup = null;
  if (Array.isArray(doc.ageGroup) && doc.ageGroup.length > 0) {
    ageGroup = doc.ageGroup.join(' ');
  } else if (typeof doc.ageGroup === 'string' && doc.ageGroup) {
    ageGroup = doc.ageGroup;
  }

  return {
    // Core identity
    title,
    description:   doc.description || (primary && primary.readme) || null,
    source,
    source_id:     sourceId,
    url:           (primary && primary.sourceUrl) || null,
    doi:           doc.doi || (primary && primary.doi) || null,

    // Semantic fields (pipeline-named)
    modality:      Array.isArray(doc.modality)  ? doc.modality  : [],
    species:       Array.isArray(doc.species)   ? doc.species   : [],
    disease:       diseaseStr,
    keywords:      Array.isArray(doc.keywords)  ? doc.keywords  : [],
    region,
    age_group:     ageGroup,
    subject_count: doc.participantCount != null ? doc.participantCount : null,

    // Timestamps (renamed from catalog fields)
    updated_at:    doc.lastUpdated || null,
    ingested_at:   doc.createdAt   || null,

    // Ranking-gated: intentionally null -> existing fallbacks apply
    quality_score: null,
    trust_tier:    null,

    // Direct-link flag
    is_direct_link: (primary && primary.isDirectLink) || false,

    // Catalog provenance (internal, _ prefixed, not in API contract)
    _source:      'catalog',
    _canonicalId: doc.canonicalDatasetId || null,
    _sourceKeys:  Array.isArray(doc.sourceKeys) ? doc.sourceKeys : [],
    _catalogDoi:  doc.doi || null,
    _matchedVia:  (doc.provenance && doc.provenance.identity && doc.provenance.identity.matchedVia) || null,
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Search the canonical catalog and return pipeline-shaped documents.
 *
 * Signature mirrors searchDatasets(filters, limit) so the orchestrator
 * can call both in parallel without interface changes.
 *
 * Throws on DB error -> orchestrator catches -> catalogResults = [].
 *
 * @param {Object} filters - QueryFilters from parseQuery
 * @param {number} [limit] - max candidates (default CATALOG_CANDIDATE_LIMIT=200)
 * @returns {Promise<Object[]>} projected pipeline-shaped documents
 */
async function catalogSearch(filters, limit) {
  const cap   = (limit != null && limit > 0) ? limit : CATALOG_CANDIDATE_LIMIT;
  const Model = getCatalogModel();
  const query = buildCatalogQuery(filters);
  const raw   = await Model.find(query).limit(cap).lean();

  let dropCount = 0;
  const results = [];
  for (const doc of raw) {
    const projected = projectCatalogDoc(doc);
    if (projected) {
      results.push(projected);
    } else {
      dropCount++;
    }
  }

  if (dropCount > 0) {
    logger.warn(`[CatalogSearch] Dropped ${dropCount} malformed catalog docs (missing title/source/source_id)`);
  }
  logger.info(`[CatalogSearch] query="${(filters && filters.raw_query) || ''}" raw=${raw.length} projected=${results.length}`);
  return results;
}

module.exports = {
  catalogSearch,
  // Exported for unit tests:
  buildCatalogQuery,
  projectCatalogDoc,
  selectPrimarySource,
  expandModality,
};
