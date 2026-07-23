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
  // ponytail: if $text query, sort by text score for relevance; otherwise no sort needed.
  const hasText = Boolean(mongoQuery.$text);
  const projection = hasText ? { score: { $meta: 'textScore' } } : {};
  const sort = hasText ? { score: { $meta: 'textScore' } } : {};
  return Dataset.find(mongoQuery, projection).sort(sort).limit(limit).lean();
}

module.exports = { buildMongoQuery, searchDatasets };
