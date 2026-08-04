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

  const toRegexList = (arr) => {
    if (!arr) return [];
    const list = Array.isArray(arr) ? arr : [arr];
    return list
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .map((item) => new RegExp(item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
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

  addFieldMatch(normalizedFilters.modality, 'modality');
  addFieldMatch(normalizedFilters.species, 'species');
  addFieldMatch(normalizedFilters.disease || normalizedFilters.condition, 'disease');
  addFieldMatch(normalizedFilters.task, 'keywords');
  addFieldMatch(normalizedFilters.format, 'keywords');
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
