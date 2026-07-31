/**
 * QueryComplexityAnalyzer
 *
 * Pure computation — no I/O, no side effects.
 * Counts how many filter dimensions the user requested and whether
 * the query signals freshness. Returns a complexity level used by
 * the Discovery Policy to weight its decision.
 *
 * Architecture ref: §19 Step 1.1, §11.2 "Query Complexity Analysis"
 */

const FRESHNESS_KEYWORDS = ['latest', 'recent', 'new', 'updated', 'newest', 'current'];

/**
 * @param {Object} filters - QueryFilters from parseQuery
 * @returns {{ score: number, level: 'low'|'medium'|'high'|'very_high', dimensionCount: number, freshness: boolean }}
 */
function analyzeQueryComplexity(filters = {}) {
  let dimensionCount = 0;

  // Count each requested (non-empty) filter dimension
  if (Array.isArray(filters.modality) && filters.modality.length > 0) dimensionCount++;
  if (Array.isArray(filters.species) && filters.species.length > 0) dimensionCount++;
  if (Array.isArray(filters.condition) && filters.condition.length > 0) dimensionCount++;
  if (filters.task) dimensionCount++;
  if (filters.region) dimensionCount++;
  if (filters.age_range || filters.age_group) dimensionCount++;
  if (Array.isArray(filters.format) && filters.format.length > 0) dimensionCount++;
  if (Array.isArray(filters.keywords) && filters.keywords.length > 0) dimensionCount++;

  // Freshness signal from raw query text
  const rawQuery = (filters.raw_query || '').toLowerCase();
  const freshness = FRESHNESS_KEYWORDS.some((kw) => rawQuery.includes(kw));

  // Normalize to 0–1 score (cap at 8 dimensions)
  const score = Math.min(dimensionCount / 8, 1.0);

  let level;
  if (dimensionCount <= 1) level = 'low';
  else if (dimensionCount <= 2) level = 'medium';
  else if (dimensionCount <= 4) level = 'high';
  else level = 'very_high';

  return { score, level, dimensionCount, freshness };
}

module.exports = { analyzeQueryComplexity, FRESHNESS_KEYWORDS };
