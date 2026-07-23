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

  if (normalizedFilters.modality?.length) query.modality = { $in: normalizedFilters.modality };
  if (normalizedFilters.species?.length) query.species = { $in: normalizedFilters.species };
  if (normalizedFilters.condition?.length) query.keywords = { $in: normalizedFilters.condition }; // condition isn't a stored field yet - matched via keywords for now
  if (normalizedFilters.task) query.keywords = { ...(query.keywords || {}), $in: [...(query.keywords?.$in || []), normalizedFilters.task] };
  if (normalizedFilters.format?.length) query.keywords = { $in: [...(query.keywords?.$in || []), ...normalizedFilters.format] };

  // ponytail: use $text index instead of unanchored regex — no full collection scan.
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

module.exports = { buildMongoQuery, searchDatasets };
