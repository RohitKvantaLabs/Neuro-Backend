'use strict';

const axios = require('axios');
const logger = require('../../utils/logger');
const env = require('../../config/env.config');
const { LiteratureProvider } = require('./literatureProvider.interface');
const { CircuitBreaker } = require('../../utils/circuitBreaker');

const OPENALEX_URL = 'https://api.openalex.org/works';

const openalexCB = new CircuitBreaker('openalex', {
  failureThreshold: 5,
  recoveryTimeoutMs: 30_000,
});

const client = axios.create({
  timeout: 15000,
  headers: { 'Accept': 'application/json', 'User-Agent': 'NeuroSearch/1.0 (mailto:neuro@neurosearch.app)' },
});

/**
 * OpenAlex provider — VERIFIED via https://docs.openalex.org/
 * - search param: fulltext search across title/abstract
 * - filter: optional but we use search only to avoid concept-id mapping
 * - per_page max 200, we use 10
 * - No auth required (polite pool via mailto)
 * - Rate limit: 10 req/s polite, 100k/day anonymous (docs: https://docs.openalex.org/how-to-use-the-api/rate-limits)
 * - Response: { results: [{ id, doi, title, abstract_inverted_index, authorships[], host_venue{journal}, publication_year, publication_date, cited_by_count, type, ids{pmid, pmcid} }] }
 */
class OpenAlexProvider extends LiteratureProvider {
  constructor(opts = {}) {
    super();
    this._client = opts.client || client;
  }

  async search(literatureQuery, options = {}) {
    const limit = Math.min(options.limit || 10, 25);
    const query = String(literatureQuery.literatureSearch || literatureQuery.raw_query || '').trim();
    if (!query) return [];

    const params = {
      search: query,
      per_page: limit,
      mailto: 'neuro@neurosearch.app',
    };

    try {
      const fn = () => this._client.get(OPENALEX_URL, { params });
      const { data } = await openalexCB.wrap(fn)();
      const results = Array.isArray(data?.results) ? data.results : [];
      logger.info(`[OpenAlex] query="${query}" returned ${results.length} works`);
      return results;
    } catch (err) {
      logger.warn(`[OpenAlex] search failed for "${query}": ${err.message}`);
      throw err;
    }
  }
}

module.exports = { OpenAlexProvider, OPENALEX_URL };
