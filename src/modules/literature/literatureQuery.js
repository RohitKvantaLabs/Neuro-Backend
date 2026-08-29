'use strict';

/**
 * LiteratureQuery — derives literature-oriented query from QueryFilters.
 * Reuses existing QueryFilters structure; provider adapters do provider-specific syntax.
 */

function buildLiteratureQuery(filters = {}) {
  const rawQuery = String(filters.raw_query || '').trim();
  const terms = [];

  const push = (v) => {
    const s = String(v || '').trim();
    if (s) terms.push(s);
  };

  // Core neuroscience concepts useful for literature
  (Array.isArray(filters.modality) ? filters.modality : []).forEach(push);
  (Array.isArray(filters.condition) ? filters.condition : []).forEach(push);
  if (filters.task) push(filters.task);
  if (filters.region) push(filters.region);
  if (filters.age_range || filters.age_group) push(filters.age_range || filters.age_group);
  (Array.isArray(filters.species) ? filters.species : []).forEach(push);
  (Array.isArray(filters.keywords) ? filters.keywords : []).forEach(push);

  const searchTerms = terms.join(' ');
  // Normalized query for scholarly APIs: prefer terms + raw_query fallback
  const literatureSearch = rawQuery || searchTerms;

  return {
    raw_query: rawQuery,
    searchTerms,
    literatureSearch,
    // Pass through structured concepts for per-paper relevance scoring
    concepts: {
      modality: Array.isArray(filters.modality) ? [...filters.modality] : [],
      condition: Array.isArray(filters.condition) ? [...filters.condition] : [],
      age_range: filters.age_range || filters.age_group || null,
      task: filters.task || null,
      region: filters.region || null,
      species: Array.isArray(filters.species) ? [...filters.species] : [],
      keywords: Array.isArray(filters.keywords) ? [...filters.keywords] : [],
    },
  };
}

module.exports = { buildLiteratureQuery };
