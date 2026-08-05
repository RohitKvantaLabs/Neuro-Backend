const Dataset = require('./dataset.model');

/**
 * Builds a Mongo filter from the QueryFilters JSON returned by Python's
 * POST /agents/parse-query (see NODE_INTEGRATION_CONTRACT.md). Empty
 * arrays/null fields are simply omitted from the query rather than
 * matched literally.
 */
function buildMongoQuery(filters = {}) {
  const normalizedFilters = filters && typeof filters === 'object' ? filters : {};
  const query = {};

  // Metadata filters are exact constraints, not keyword searches. Anchoring
  // keeps MRI distinct from fMRI while allowing harmless display variants.
  const toExactRegexList = (arr) => {
    if (!arr) return [];
    const list = Array.isArray(arr) ? arr : [arr];
    return list
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .map((item) => {
        const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const normalizedPattern = escaped
          .replace(/[\u2018\u2019']/g, "['\u2018\u2019]?")
          .replace(/[\s_-]+/g, '[\\s_-]+');
        return new RegExp(`^${normalizedPattern}$`, 'i');
      });
  };

  const andConditions = [];

  const addFieldMatch = (items, field) => {
    const regexes = toExactRegexList(items);
    if (!regexes.length) return;
    // $in works for both scalar fields and arrays such as modality/species.
    const fields = Array.isArray(field) ? field : [field];
    const exactMatch = { $in: regexes };
    andConditions.push(fields.length === 1
      ? { [fields[0]]: exactMatch }
      : { $or: fields.map((name) => ({ [name]: exactMatch })) });
  };

  addFieldMatch(normalizedFilters.modality, 'modality');
  addFieldMatch(normalizedFilters.species, 'species');
  addFieldMatch(normalizedFilters.disease || normalizedFilters.condition, 'disease');
  // Legacy records store task/format taxonomy in keywords; newer records may
  // use dedicated fields. Both are metadata fields and both match exactly.
  addFieldMatch(normalizedFilters.task, ['task', 'keywords']);
  addFieldMatch(normalizedFilters.format, ['format', 'keywords']);
  addFieldMatch(normalizedFilters.repository, 'source');
  addFieldMatch(normalizedFilters.age_group || normalizedFilters.ageGroup, 'age_group');
  addFieldMatch(normalizedFilters.region, 'region');
  addFieldMatch(normalizedFilters.availability || normalizedFilters.access_tier, 'access_tier');

  if (normalizedFilters.raw_query && typeof normalizedFilters.raw_query === 'string' && normalizedFilters.raw_query.trim()) {
    query.$text = { $search: normalizedFilters.raw_query.trim() };
  }

  if (andConditions.length > 0) {
    query.$and = andConditions;
  }

  return query;
}

function normalizeMetadataValue(value) {
  return String(value || '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[\u2018\u2019']/g, '')
    .replace(/[\s_-]+/g, ' ');
}

function metadataValues(value) {
  return Array.isArray(value) ? value : (value ? [value] : []);
}

// Discovery providers return plain objects, so enforce the same metadata-only
// constraints before their results are returned to the client.
function filterDatasetsByMetadata(datasets, filters = {}) {
  if (!Array.isArray(datasets)) return [];
  const groups = [
    ['modality', ['modality']],
    ['species', ['species']],
    ['disease', ['disease', 'condition']],
    ['age_group', ['age_group', 'ageGroup']],
    ['task', ['task', 'keywords']],
    ['format', ['format', 'keywords']],
    ['repository', ['source']],
    ['availability', ['access_tier', 'availability']],
  ];
  const activeGroups = groups.map(([filterName, fields]) => ({
    fields,
    selected: metadataValues(filters[filterName] || (filterName === 'disease' ? filters.condition : undefined))
      .map(normalizeMetadataValue)
      .filter(Boolean),
  })).filter((group) => group.selected.length > 0);

  if (!activeGroups.length) return datasets;
  return datasets.filter((dataset) => activeGroups.every(({ fields, selected }) => {
    const actual = fields.flatMap((field) => metadataValues(dataset[field])).map(normalizeMetadataValue);
    return selected.some((value) => actual.includes(value));
  }));
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

      // Do not loosen either the text query or active metadata filters. A
      // search with filters must satisfy both, otherwise return no results.
    } catch { /* proceed to fallbacks below */ }
  }

  // Structured AND-query first (fast — uses field indexes).
  try {
    const structured = await Dataset.find(mongoQuery).limit(limit).lean();
    if (structured.length > 0) return structured;
  } catch { /* proceed */ }

  // Semantic/raw fallbacks are search-only behaviour. Applying either one
  // without structured clauses would leak datasets that violate a filter.
  const hasActiveFilters = Array.isArray(mongoQuery.$and) && mongoQuery.$and.length > 0;
  if (hasActiveFilters) return [];

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

module.exports = { buildMongoQuery, filterDatasetsByMetadata, searchDatasets, searchMongoDB };
