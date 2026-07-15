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

  // Fallback: if nothing structured matched, do a loose text search on
  // title/description/keywords using the raw query string.
  if (Object.keys(query).length === 0 && normalizedFilters.raw_query) {
    const regex = new RegExp(normalizedFilters.raw_query.split(/\s+/).join('|'), 'i');
    query.$or = [{ title: regex }, { description: regex }, { keywords: regex }];
  }

  return query;
}

async function searchDatasets(filters, limit = 20) {
  const mongoQuery = buildMongoQuery(filters);
  return Dataset.find(mongoQuery).limit(limit).lean();
}

module.exports = { buildMongoQuery, searchDatasets };
