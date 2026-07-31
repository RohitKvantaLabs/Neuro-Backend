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

  const toRegexArray = (arr) => {
    if (!arr) return [];
    const list = Array.isArray(arr) ? arr : [arr];
    return list.map((item) => new RegExp(`^${item.trim()}$`, 'i'));
  };

  const modalities = toRegexArray(normalizedFilters.modality);
  if (modalities.length) query.modality = { $in: modalities };

  const species = toRegexArray(normalizedFilters.species);
  if (species.length) query.species = { $in: species };

  const diseases = toRegexArray(normalizedFilters.disease || normalizedFilters.condition);
  if (diseases.length) {
    query.$or = query.$or || [];
    query.$or.push({ disease: { $in: diseases } }, { keywords: { $in: diseases } });
  }

  const tasks = toRegexArray(normalizedFilters.task);
  if (tasks.length) {
    query.keywords = query.keywords || {};
    query.keywords.$in = [...(query.keywords.$in || []), ...tasks];
  }

  const formats = toRegexArray(normalizedFilters.format);
  if (formats.length) {
    query.keywords = query.keywords || {};
    query.keywords.$in = [...(query.keywords.$in || []), ...formats];
  }

  const repos = toRegexArray(normalizedFilters.repository);
  if (repos.length) {
    query.source = { $in: repos };
  }

  const ageGroups = toRegexArray(normalizedFilters.age_group || normalizedFilters.ageGroup);
  if (ageGroups.length) {
    query.age_group = { $in: ageGroups };
  }

  const regions = toRegexArray(normalizedFilters.region);
  if (regions.length) query.region = { $in: regions };

  const availabilities = toRegexArray(normalizedFilters.availability || normalizedFilters.access_tier);
  if (availabilities.length) {
    query.access_tier = { $in: availabilities };
  }

  // Use $text index for raw_query if no structured fields match
  if (Object.keys(query).length === 0 && normalizedFilters.raw_query) {
    query.$text = { $search: normalizedFilters.raw_query };
  }

  return query;
}

async function searchDatasets(filters, limit = 20) {
  const mongoQuery = buildMongoQuery(filters);
  const hasText = Boolean(mongoQuery.$text);
  const textProjection = { score: { $meta: 'textScore' } };
  const textSort = { score: { $meta: 'textScore' } };

  if (hasText) {
    return Dataset.find(mongoQuery, textProjection).sort(textSort).limit(limit).lean();
  }

  // Structured AND-query first (fast — uses field indexes).
  const structured = await Dataset.find(mongoQuery).limit(limit).lean();
  if (structured.length > 0) return structured;

  // ponytail: two-phase fallback — structured AND-query can miss stored datasets
  // when agent only populated *some* filter fields (e.g. species:[] stored but
  // query requires species:["human"]). A $text search on raw_query finds them.
  if (filters.raw_query) {
    return Dataset.find(
      { $text: { $search: filters.raw_query } },
      textProjection,
    ).sort(textSort).limit(limit).lean();
  }

  return [];
}

// ponytail: alias for RetrievalOrchestrator (architecture §18.2) — same function, separate export name.
const searchMongoDB = searchDatasets;

module.exports = { buildMongoQuery, searchDatasets, searchMongoDB };
