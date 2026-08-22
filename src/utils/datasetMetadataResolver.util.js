/**
 * Metadata Resolution Helper (§6, §18)
 *
 * Precedence:
 *   1. Admin Override (if present and non-empty/non-null)
 *   2. Canonical Dataset (if present and non-empty/non-null)
 *   3. Default Fallback ("N/A" for display strings, null / [] for raw primitives)
 *
 * Never fabricates values from title/description/readme.
 */
function resolveDatasetMetadata(datasetDoc, overrideDoc) {
  const d = datasetDoc || {};
  const o = overrideDoc || {};

  const list = (overrideVal, canonicalVal) => {
    if (Array.isArray(overrideVal) && overrideVal.length > 0) return overrideVal;
    if (Array.isArray(canonicalVal) && canonicalVal.length > 0) return canonicalVal;
    if (typeof canonicalVal === 'string' && canonicalVal.trim()) return [canonicalVal.trim()];
    return [];
  };

  const str = (overrideVal, canonicalVal, fallback = 'N/A') => {
    if (typeof overrideVal === 'string' && overrideVal.trim()) return overrideVal.trim();
    if (typeof canonicalVal === 'string' && canonicalVal.trim()) return canonicalVal.trim();
    return fallback;
  };

  const num = (overrideVal, canonicalVal) => {
    if (typeof overrideVal === 'number' && !isNaN(overrideVal)) return overrideVal;
    if (typeof canonicalVal === 'number' && !isNaN(canonicalVal)) return canonicalVal;
    return null;
  };

  return {
    datasetId: d._id ? d._id.toString() : (d.source_id || o.datasetId || null),
    source: d.source || 'unknown',
    source_id: d.source_id || null,
    url: d.url || null,
    doi: d.doi || null,
    is_active: d.is_active !== undefined ? d.is_active : true,

    title: str(o.title, d.title, 'Untitled dataset'),
    description: str(o.description, d.description, null),
    modality: list(o.modality, d.modality),
    species: list(o.species, d.species),
    disease: str(o.disease, d.disease, null),
    tasks: list(o.tasks, d.tasks),
    region: str(o.region, d.region, null),
    ageGroup: str(o.ageGroup, d.age_group, null),
    subjects: num(o.subjects, d.subject_count),
    size: str(o.size, d.size_label, null),
    publicationYear: num(o.publicationYear, d.publication_year),
    studyDesign: str(o.studyDesign, d.study_design, null),
    hasOverride: Boolean(overrideDoc),
  };
}

module.exports = { resolveDatasetMetadata };
