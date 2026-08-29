'use strict';

const axios = require('axios');
const logger = require('../../utils/logger');
const env = require('../../config/env.config');
const { LiteratureProvider } = require('./literatureProvider.interface');
const { CircuitBreaker } = require('../../utils/circuitBreaker');

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

const tavilyLiteratureCB = new CircuitBreaker('tavily-literature', {
  failureThreshold: 5,
  recoveryTimeoutMs: 30_000,
});

const client = axios.create({
  timeout: parseInt(process.env.PYTHON_AGENT_TIMEOUT_MS, 10) || 15000,
  headers: { 'Content-Type': 'application/json' },
});

/**
 * Tavily literature adapter — REUSES existing Tavily infrastructure (same API, same retry shape)
 * but literature-specific:
 * - Query: raw_query + " research paper review article"
 * - Does NOT go through dataset FallbackAgent validation
 * - Filters out obvious dataset repo domains to prefer scholarly content
 */
const DATASET_DOMAINS = ['openneuro.org','dandiarchive.org','neurovault.org','zenodo.org/records','figshare.com','dryad','osf.io','nitrc.org','humanconnectome.org'];

class TavilyLiteratureProvider extends LiteratureProvider {
  constructor(opts = {}) {
    super();
    this._client = opts.client || client;
    this._apiKey = opts.apiKey || process.env.TAVILY_API_KEY || null;
  }

  async search(literatureQuery, options = {}) {
    const limit = Math.min(options.limit || 10, 10);
    const base = String(literatureQuery.literatureSearch || literatureQuery.raw_query || '').trim();
    if (!base) return [];

    const apiKey = process.env.TAVILY_API_KEY || this._apiKey;
    if (!apiKey) {
      logger.warn('[TavilyLiterature] TAVILY_API_KEY not set — failing provider search');
      throw new Error('TAVILY_API_KEY not set');
    }

    const query = `${base} research paper peer reviewed article`;
    const payload = {
      api_key: apiKey,
      query,
      search_depth: 'advanced',
      max_results: limit,
      include_answer: false,
      include_domains: ['pubmed.ncbi.nlm.nih.gov','ncbi.nlm.nih.gov','europepmc.org','scholar.google.com','semanticscholar.org','arxiv.org','biorxiv.org','nature.com','sciencedirect.com','wiley.com','frontiersin.org','plos.org'],
      exclude_domains: DATASET_DOMAINS,
    };

    try {
      const fn = () => this._client.post(TAVILY_SEARCH_URL, payload);
      const { data } = await tavilyLiteratureCB.wrap(fn)();
      const results = Array.isArray(data?.results) ? data.results : [];
      logger.info(`[TavilyLiterature] query="${query}" returned ${results.length} hits`);
      return results.map(r => ({
        title: r.title || 'Untitled',
        url: r.url || '',
        snippet: r.content || '',
        score: r.score || 0,
      })).filter(r => r.url);
    } catch (err) {
      logger.warn(`[TavilyLiterature] search failed for "${query}": ${err.message}`);
      throw err;
    }
  }
}

module.exports = { TavilyLiteratureProvider, TAVILY_SEARCH_URL };
