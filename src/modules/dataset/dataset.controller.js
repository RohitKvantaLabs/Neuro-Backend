const ApiError = require('../../utils/ApiError');
const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const logger = require('../../utils/logger');
const env = require('../../config/env.config');
const { parseQuery, runFallbackSearch } = require('../agent/agent.client');
const { searchDatasets } = require('./dataset.service');
const { orchestrateSearch } = require('./retrievalOrchestrator');
const Dataset = require('./dataset.model');
const { User } = require('../user/user.model');
const QueryLog = require('../queryLog/queryLog.model');
const SearchHistory = require('../user/searchHistory.model');
const { PopularDataset } = require('./popularDataset.model');
const { AdminDatasetOverride } = require('./adminDatasetOverride.model');
const { resolveDatasetMetadata } = require('../../utils/datasetMetadataResolver.util');

/**
 * POST /datasets/search
 *
 * When FF_USE_NEW_ORCHESTRATOR=true:
 *   Delegates entirely to RetrievalOrchestrator, which implements the full
 *   Retrieval Orchestrator architecture (§7): parse → MongoDB → quality →
 *   Discovery Policy → optional Discovery Agent → Layer 3 ranking.
 *
 * When FF_USE_NEW_ORCHESTRATOR=false (default):
 *   Runs the original binary decision flow (cache hit → return, miss → fallback).
 *   Preserved exactly for rollback safety (§18.6).
 *
 * §10.5: Fire-and-forget SearchHistory write for authenticated users.
 * Node stays read-only for the datasets collection — Python owns writes.
 */
const search = asyncHandler(async (req, res) => {
  const { query, filters: explicitFilters } = req.body;
  const hasExplicitFilters = explicitFilters && typeof explicitFilters === 'object' && Object.values(explicitFilters).some(v => Array.isArray(v) ? v.length > 0 : Boolean(v));
  const rawQuery = (typeof query === 'string' ? query.trim() : '');

  if (!rawQuery && !hasExplicitFilters) {
    throw new ApiError(400, 'A query string of at least 2 characters or active filter selections are required.');
  }

  let effectiveQuery = rawQuery;
  if (!effectiveQuery && hasExplicitFilters) {
    const filterTokens = Object.values(explicitFilters).flatMap(v => Array.isArray(v) ? v : [v]).filter(Boolean);
    effectiveQuery = filterTokens.join(' ');
  }

  let userEmail = 'anonymous';
  if (req.user?.id) {
    try {
      const u = await User.findById(req.user.id).select('email').lean();
      if (u) userEmail = u.email;
    } catch { /* best-effort */ }
  }

  // §10.5: fire-and-forget — don't block the response on the history write
  if (req.user?.id) {
    SearchHistory.create({ userId: req.user.id, query: (rawQuery || effectiveQuery).slice(0, 500) })
      .catch((err) => logger.warn(`SearchHistory write failed: ${err.message}`));
  }

  // ── Feature flag: new Retrieval Orchestrator (§18.5) ──────────────────────
  const requestId = req.requestId || null;
  const controllerStart = Date.now();
  if (env.featureFlags?.useNewOrchestrator) {
    const orchestratorResult = await orchestrateSearch(
      effectiveQuery || 'neuroscience datasets',
      hasExplicitFilters ? explicitFilters : null,
      { userId: req.user?.id, userEmail },
      requestId
    );

    // Phase 2 four-way provenance: count final ranked results by provenance for telemetry
    const provenanceCounts = { mongodb_dataset: 0, mongodb_catalog: 0, repository: 0, discovery: 0 };
    for (const r of orchestratorResult.results || []) {
      const prov = r._provenance || r._source || 'unknown';
      if (prov === 'mongodb_dataset' || prov === 'mongodb') provenanceCounts.mongodb_dataset++;
      else if (prov === 'mongodb_catalog' || prov === 'catalog') provenanceCounts.mongodb_catalog++;
      else if (prov === 'repository') provenanceCounts.repository++;
      else if (prov === 'discovery') provenanceCounts.discovery++;
    }
    // Phase 7 — persist wall-clock stage timings (passive, never blocks search)
    const stageTimings = orchestratorResult.timings || null;
    await QueryLog.create({
      requestId,
      userId:       req.user?.id || null,
      rawQuery:     rawQuery,
      filters:      orchestratorResult.filters,
      resultSource: orchestratorResult.source,
      resultCount:  orchestratorResult.metrics.totalFound,
      provenance:   provenanceCounts,
      timings:      stageTimings,
    }).catch((err) => logger.warn(`QueryLog write failed: ${err.message}`));

    return new ApiResponse(
      200,
      {
        source:  orchestratorResult.source,
        results: orchestratorResult.results,
        metrics: orchestratorResult.metrics,
        timings: stageTimings,
        // v0.3 §9.2 (additive): expose the effective (merged) parsed filters so
        // the UI can auto-select parser-derived filters (FR-8) and detect
        // filter/query conflicts (FR-7). Search behavior is unchanged.
        filters: orchestratorResult.filters,
      },
      orchestratorResult.results.length > 0
        ? 'Results found.'
        : 'No datasets found for this query.'
    ).send(res);
  }

  // ── Legacy path (unchanged, timings best-effort total only) ──────────────
  let filters;
  const legacyParseStart = Date.now();
  try {
    filters = await parseQuery(effectiveQuery || 'neuroscience datasets', req.user?.id, userEmail, requestId);
  } catch (err) {
    logger.warn(`Dataset search parser fallback triggered for query="${effectiveQuery}": ${err.message}`);
    filters = { raw_query: effectiveQuery };
  }

  // Merge user explicit filters over parser filters
  if (hasExplicitFilters) {
    filters = { ...filters, ...explicitFilters, raw_query: effectiveQuery || filters.raw_query };
  }

  const cachedResults = await searchDatasets(filters);

  if (cachedResults.length > 0) {
    const legacyTimings = { totalMs: Date.now() - controllerStart, parseMs: Date.now() - legacyParseStart, datasetMs: 0, catalogMs: null, repositoryMs: null, discoveryMs: null, rankingMs: null };
    await QueryLog.create({
      requestId,
      userId: req.user?.id || null,
      rawQuery: query,
      filters,
      resultSource: 'cache',
      resultCount: cachedResults.length,
      provenance: { mongodb_dataset: cachedResults.length, mongodb_catalog: 0, repository: 0, discovery: 0 },
      timings: legacyTimings,
    }).catch(()=>{});
    // v0.3 §9.2 (additive): expose effective filters (FR-8/FR-7).
    return new ApiResponse(200, { source: 'cache', results: cachedResults, filters }, 'Results found.').send(res);
  }

  // Cache miss: return Python's verified records directly.
  let fallbackDatasets = [];
  try {
    const agentResult = await runFallbackSearch({
      query,
      filters,
      userId: req.user?.id,
      userEmail,
      requestId,
    });
    fallbackDatasets = Array.isArray(agentResult?.datasets) ? agentResult.datasets : [];
  } catch (err) {
    logger.error(`Fallback agent search failed for query="${query}": ${err.message}`);
    throw new ApiError(502, 'Dataset fallback search could not be completed. Please try again.');
  }

  const legacyFallbackTimings = { totalMs: Date.now() - controllerStart, parseMs: Date.now() - legacyParseStart, datasetMs: null, catalogMs: null, repositoryMs: null, discoveryMs: null, rankingMs: null };
  await QueryLog.create({
    requestId,
    userId: req.user?.id || null,
    rawQuery: query,
    filters,
    resultSource: 'fallback',
    resultCount: fallbackDatasets.length,
    provenance: { mongodb_dataset: 0, mongodb_catalog: 0, repository: 0, discovery: fallbackDatasets.length },
    timings: legacyFallbackTimings,
  }).catch(()=>{});

  return new ApiResponse(
    200,
    // v0.3 §9.2 (additive): expose effective filters (FR-8/FR-7).
    { source: 'agent', results: fallbackDatasets, filters },
    fallbackDatasets.length > 0 ? 'Results found via live search.' : 'No datasets found for this query.'
  ).send(res);
});

// GET /datasets/:id — fetch a single dataset by Mongo _id or source_id for the detail page (with catalog fallback)
const getById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const mongoose = require('mongoose');
  let dataset = null;
  if (mongoose.Types.ObjectId.isValid(id)) {
    dataset = await Dataset.findById(id).lean();
  }
  if (!dataset) {
    dataset = await Dataset.findOne({ source_id: id }).lean();
  }
  if (dataset) {
    return new ApiResponse(200, dataset).send(res);
  }

  // Fallback: search neurosearch_dataset_catalog for catalog-only datasets
  const { getCatalogModel, projectCatalogDoc } = require('./catalogSearch.service');
  const CatalogDataset = getCatalogModel();
  let catalogDoc = null;

  if (mongoose.Types.ObjectId.isValid(id)) {
    catalogDoc = await CatalogDataset.findById(id).lean();
  }
  if (!catalogDoc) {
    catalogDoc = await CatalogDataset.findOne({
      $or: [
        { canonicalDatasetId: id },
        { 'sources.sourceDatasetId': id },
      ],
    }).lean();
  }

  if (catalogDoc) {
    const mapped = projectCatalogDoc(catalogDoc);
    if (mapped) {
      return new ApiResponse(200, mapped).send(res);
    }
  }

  throw new ApiError(404, 'Dataset not found.');
});


/**
 * GET /datasets/popular
 * Public endpoint — returns ≤6 admin-published PopularDataset records ordered by displayOrder ASC.
 * Resolves metadata from AdminDatasetOverride → canonical Dataset.
 * Excludes records whose canonical dataset is inactive (is_active=false) or missing.
 * ponytail: limit enforced at DB level (.limit(6)), not in JS.
 */
const MAX_PUBLIC_POPULAR = 6;

const getPopular = asyncHandler(async (req, res) => {
  const popularDocs = await PopularDataset.find({ status: 'published' })
    .sort({ displayOrder: 1 })
    .limit(MAX_PUBLIC_POPULAR)
    .lean();

  if (popularDocs.length === 0) {
    return new ApiResponse(200, { items: [] }).send(res);
  }

  const datasetIds = popularDocs.map((d) => d.datasetId);

  // Fetch canonical datasets and overrides in parallel
  const mongoose = require('mongoose');
  const objectIds = datasetIds.filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id) => new mongoose.Types.ObjectId(id));
  const [canonicalDocs, overrideDocs] = await Promise.all([
    Dataset.find({
      $or: [
        { _id: { $in: objectIds } },
        { source_id: { $in: datasetIds } },
      ],
      is_active: { $ne: false },
    }).lean(),
    AdminDatasetOverride.find({ datasetId: { $in: datasetIds } }).lean(),
  ]);

  // Build lookup maps
  const canonicalMap = {};
  canonicalDocs.forEach((doc) => {
    if (doc._id) canonicalMap[doc._id.toString()] = doc;
    if (doc.source_id) canonicalMap[doc.source_id] = doc;
  });
  const overrideMap = {};
  overrideDocs.forEach((doc) => { overrideMap[doc.datasetId] = doc; });

  const items = [];
  for (const pop of popularDocs) {
    const canonical = canonicalMap[pop.datasetId] || null;
    if (!canonical) {
      // ponytail: skip orphaned popular records; log for visibility
      logger.warn(`Popular dataset ${pop.datasetId} has no active canonical dataset — skipped from public response`);
      continue;
    }
    const override = overrideMap[pop.datasetId] || null;
    const resolved = resolveDatasetMetadata(canonical, override);

    // ponytail: only expose presentation fields; no admin/audit data
    items.push({
      datasetId: pop.datasetId,
      displayOrder: pop.displayOrder,
      title: pop.featuredTitleOverride || resolved.title,
      description: resolved.description,
      source: resolved.source,
      source_id: resolved.source_id,
      url: resolved.url,
      doi: resolved.doi,
      modality: resolved.modality,
      species: resolved.species,
      disease: resolved.disease,
      tasks: resolved.tasks,
      region: resolved.region,
      ageGroup: resolved.ageGroup,
      subjects: resolved.subjects,
      size: resolved.size,
      publicationYear: resolved.publicationYear,
      studyDesign: resolved.studyDesign,
    });
  }

  return new ApiResponse(200, { items }).send(res);
});

module.exports = { search, getById, getPopular };

