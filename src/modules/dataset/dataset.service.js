const Dataset = require('./dataset.model');

const GB = 1024 ** 3;

// M3: size bucket → byte ranges (mirrors SIZE_BUCKET_RANGES in candidateGenerator.js)
const SIZE_BUCKET_RANGES_SVC = {
  '<10 GB':     { $lt: 10 * GB },
  '10–100 GB':  { $gte: 10 * GB, $lt: 101 * GB },
  '100–500 GB': { $gte: 100 * GB, $lt: 501 * GB },
  '500 GB+':    { $gte: 500 * GB },
};

// M4: year bucket → numeric year ranges
const YEAR_BUCKET_RANGES_SVC = {
  'Before 2020': { gte: null, lt: 2020 },
  '2020–2022':   { gte: 2020, lt: 2023 },
  '2023–2025':   { gte: 2023, lt: 2026 },
  '2026+':       { gte: 2026, lt: null },
};

// M6: participants bucket → subject_count ranges
const PARTICIPANTS_BUCKET_RANGES_SVC = {
  '1–25':   { $gte: 1,   $lte: 25 },
  '26–50':  { $gte: 26,  $lte: 50 },
  '51–100': { $gte: 51,  $lte: 100 },
  '101+':   { $gte: 101 },
};

// M2: modality bucket → token families
const MODALITY_BUCKET_TOKENS_SVC = {
  'MRI':   ['mri', 'fmri', 'smri', 'structural mri', 'functional mri',
             'magnetic resonance imaging', 'functional magnetic resonance imaging',
             'structural magnetic resonance imaging', 'dti', 'dwi', 'diffusion',
             't1w', 't2w', 'bold', 'anat', 'func'],
  'EEG':   ['eeg', 'electroencephalography', 'electroencephalogram', 'electrophysiology',
             'ecg', 'emg', 'lfp', 'local field potential'],
  'IEEG':  ['ieeg', 'intracranial eeg', 'intracranial electroencephalography',
             'ecog', 'electrocorticography', 'seeg'],
  'MEG':   ['meg', 'magnetoencephalography'],
  'fNIRS': ['fnirs', 'nirs', 'near-infrared spectroscopy', 'near infrared spectroscopy'],
  'PET':   ['pet', 'positron emission tomography'],
};

// M5: human species tokens
const HUMAN_TOKENS_SVC = [
  'human', 'humans', 'homo sapiens', 'participant', 'participants',
  'subject', 'subjects', 'patient', 'patients', 'adult', 'adults',
  'child', 'children', 'person', 'people',
];

function escapeRx(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Builds a Mongo filter from the QueryFilters JSON returned by Python's
 * POST /agents/parse-query (see NODE_INTEGRATION_CONTRACT.md). Empty
 * arrays/null fields are simply omitted from the query rather than
 * matched literally.
 *
 * M2: modality UI bucket → synonym-family $or regex expansion.
 * M3: size UI bucket → size_bytes numeric range.
 * M4: year UI bucket → numeric year range across date fields.
 * M5: species UI bucket → Human ($or tokens) or Animal ($nin tokens).
 * M6: participants UI bucket → subject_count $gte/$lte range.
 */
function buildMongoQuery(filters = {}) {
  const normalizedFilters = filters && typeof filters === 'object' ? filters : {};
  const query = {};

  const toRx = (v) => new RegExp(escapeRx(String(v || '').trim()), 'i');
  const toRegexList = (arr) => {
    if (!arr) return [];
    const list = Array.isArray(arr) ? arr : [arr];
    return list.map((item) => String(item || '').trim()).filter(Boolean).map(toRx);
  };

  const andConditions = [];

  const addFieldMatch = (items, primaryField) => {
    const regexes = toRegexList(items);
    if (!regexes.length) return;
    const orClauses = [];
    regexes.forEach((rx) => {
      orClauses.push(
        { [primaryField]: rx },
        { keywords: rx },
        { title: rx },
        { description: rx }
      );
    });
    andConditions.push({ $or: orClauses });
  };

  // M2: modality — expand UI bucket to synonym family
  const modalityValues = normalizedFilters.modality;
  if (modalityValues) {
    const modList = Array.isArray(modalityValues) ? modalityValues : [modalityValues];
    const modClauses = modList.filter(Boolean).flatMap((bucket) => {
      const tokens = MODALITY_BUCKET_TOKENS_SVC[bucket];
      if (tokens) return tokens.map((t) => ({ modality: toRx(t) }));
      return [{ modality: toRx(bucket) }]; // Unspecified passthrough
    });
    if (modClauses.length) andConditions.push({ $or: modClauses });
  }

  // M5: species bucket → Human (inclusive) or Animal (exclusive)
  const speciesValues = normalizedFilters.species;
  if (speciesValues) {
    const specList = Array.isArray(speciesValues) ? speciesValues : [speciesValues];
    for (const bucket of specList.filter(Boolean)) {
      const b = bucket.trim().toLowerCase();
      if (b === 'human') {
        andConditions.push({ $or: HUMAN_TOKENS_SVC.map((t) => ({ species: toRx(t) })) });
      } else if (b === 'animal') {
        andConditions.push({
          species: { $exists: true, $not: new RegExp(HUMAN_TOKENS_SVC.map(escapeRx).join('|'), 'i') },
        });
      }
    }
  }

  addFieldMatch(normalizedFilters.disease || normalizedFilters.condition, 'disease');
  addFieldMatch(normalizedFilters.task, 'task');
  addFieldMatch(normalizedFilters.format, 'keywords');
  addFieldMatch(normalizedFilters.repository, 'source');
  addFieldMatch(normalizedFilters.age_group || normalizedFilters.ageGroup, 'age_group');
  addFieldMatch(normalizedFilters.region, 'region');
  addFieldMatch(normalizedFilters.availability || normalizedFilters.access_tier, 'access_tier');

  // M3: size bucket → size_bytes numeric range
  const sizeBuckets = normalizedFilters.size;
  if (sizeBuckets) {
    const sizeList = Array.isArray(sizeBuckets) ? sizeBuckets : [sizeBuckets];
    for (const bucket of sizeList.filter(Boolean)) {
      const range = SIZE_BUCKET_RANGES_SVC[bucket];
      if (range) andConditions.push({ size_bytes: range });
    }
  }

  // M4: year bucket → numeric year range
  const yearBuckets = normalizedFilters.year;
  if (yearBuckets) {
    const yearList = Array.isArray(yearBuckets) ? yearBuckets : [yearBuckets];
    for (const bucket of yearList.filter(Boolean)) {
      const range = YEAR_BUCKET_RANGES_SVC[bucket];
      if (!range) continue;
      const r = {};
      if (range.gte != null) r.$gte = range.gte;
      if (range.lt  != null) r.$lt  = range.lt;
      if (Object.keys(r).length) {
        andConditions.push({
          $or: [
            { publication_year: r },
            { published_at: r },
            { date_published: r },
          ],
        });
      }
    }
  }

  // M6: participants bucket → subject_count range
  const participantsBuckets = normalizedFilters.participants;
  if (participantsBuckets) {
    const pList = Array.isArray(participantsBuckets) ? participantsBuckets : [participantsBuckets];
    for (const bucket of pList.filter(Boolean)) {
      const range = PARTICIPANTS_BUCKET_RANGES_SVC[bucket];
      if (range) andConditions.push({ subject_count: range });
    }
  }

  if (normalizedFilters.raw_query && typeof normalizedFilters.raw_query === 'string' && normalizedFilters.raw_query.trim()) {
    query.$text = { $search: normalizedFilters.raw_query.trim() };
  }

  if (andConditions.length > 0) {
    query.$and = andConditions;
  }

  return query;
}

/**
 * Build a $text search string from NORMALIZED semantic terms.
 *
 * Stabilization (Phase 6): the fallback must reflect semantic relevance, not
 * raw token coincidence. Searching the raw query string means typo-preserved
 * tokens ("fMRRri", "stte") drive the $text match — results missing critical
 * requested fields then dominate. Instead, structured filter fields are
 * prioritized (modality → task → condition → region → species → age_group),
 * and only non-typo keywords are appended (same typo signal as the Python
 * build_query_terms: 3+ identical consecutive letters).
 */
function buildSemanticTextQuery(filters = {}) {
  const terms = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (s) terms.push(s);
  };

  if (Array.isArray(filters.modality)) filters.modality.forEach(push);
  if (filters.task) push(filters.task);
  if (Array.isArray(filters.condition)) filters.condition.forEach(push);
  if (filters.region) push(filters.region);
  if (Array.isArray(filters.species)) filters.species.forEach(push);
  if (filters.age_range || filters.age_group) push(filters.age_range || filters.age_group);

  // Keywords only as filler — and only when they are not typo fragments or
  // duplicates of an already-included structured value.
  const included = new Set(terms.map((t) => t.toLowerCase()));
  if (Array.isArray(filters.keywords)) {
    for (const kw of filters.keywords) {
      const k = String(kw || '').trim();
      if (!k) continue;
      const kl = k.toLowerCase();
      if (included.has(kl)) continue;
      if (/(.)\1{2,}/.test(kl)) continue; // typo signal: 3+ same letters in a row
      terms.push(k);
      included.add(kl);
    }
  }

  return terms.join(' ');
}

async function searchDatasets(filters, limit = 30) {
  const mongoQuery = buildMongoQuery(filters);
  const hasText = Boolean(mongoQuery.$text);
  const textProjection = { score: { $meta: 'textScore' } };
  const textSort = { score: { $meta: 'textScore' } };

  if (hasText) {
    try {
      const results = await Dataset.find(mongoQuery, textProjection).sort(textSort).limit(limit).lean();
      if (results.length > 0) return results;

      // Fallback: if $text + $and filters returned 0 results, try without $text (filters only)
      const { $text, ...onlyFilters } = mongoQuery;
      if (Object.keys(onlyFilters).length > 0) {
        const filterOnly = await Dataset.find(onlyFilters).limit(limit).lean();
        if (filterOnly.length > 0) return filterOnly;
      }
    } catch { /* proceed to fallbacks below */ }
  }

  // Structured AND-query first (fast — uses field indexes).
  try {
    const structured = await Dataset.find(mongoQuery).limit(limit).lean();
    if (structured.length > 0) return structured;
  } catch { /* proceed */ }

  const semanticText = buildSemanticTextQuery(filters);
  if (semanticText) {
    try {
      const semanticResults = await Dataset.find(
        { $text: { $search: semanticText } },
        textProjection
      ).sort(textSort).limit(limit).lean();
      if (semanticResults.length > 0) return semanticResults;
    } catch { /* proceed */ }
  }

  if (filters.raw_query) {
    try {
      return await Dataset.find(
        { $text: { $search: filters.raw_query } },
        textProjection
      ).sort(textSort).limit(limit).lean();
    } catch { /* proceed */ }
  }

  return [];
}

// ponytail: alias for RetrievalOrchestrator (architecture §18.2) — same function, separate export name.
const searchMongoDB = searchDatasets;

module.exports = { buildMongoQuery, searchDatasets, searchMongoDB };
