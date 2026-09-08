/**
 * Phase 6 — Centralized Pricing Configuration
 *
 * Single source of truth for LLM and external API pricing.
 * All cost calculations import from here — no scattered hardcoded prices.
 *
 * DESIGN:
 * - Provider/model-aware pricing (input/output per 1M tokens separately)
 * - Env overrides allow ops to update pricing without code changes
 * - Missing pricing returns null (do NOT invent a price)
 * - External API pricing defaults to unavailable (null) — only billable services
 *   with known units should be configured; call count ≠ billable unit.
 *
 * REQUIRED CONFIG DECISION:
 * The default LLM prices below reflect public Groq pricing as of 2026-09.
 * Ops MUST verify and update via env vars if pricing changes:
 *   GROQ_GPT_OSS_120B_INPUT_PER_1M, GROQ_GPT_OSS_120B_OUTPUT_PER_1M,
 *   GROQ_LLAMA_70B_INPUT_PER_1M, GROQ_LLAMA_70B_OUTPUT_PER_1M
 * External API pricing is intentionally NOT pre-configured — set
 *   TAVILY_PRICE_PER_1K_SEARCHES to enable Tavily cost calculation.
 */

function envFloat(key, fallback) {
  const raw = process.env[key];
  if (raw == null || raw === '') return fallback;
  const v = parseFloat(raw);
  return Number.isFinite(v) ? v : fallback;
}

// ── LLM pricing: price per 1M tokens in USD ────────────────────────────────
// Source: Groq public pricing page (https://groq.com/pricing) + provider docs
// as of 2026-09. Update via env vars below.
// Do NOT add providers/models not present in the system (groq + heuristic today).

const DEFAULT_LLM_PRICING = {
  groq: {
    // openai/gpt-oss-120b — Groq hosted
    'openai/gpt-oss-120b': {
      inputPerMillion: envFloat('GROQ_GPT_OSS_120B_INPUT_PER_1M', 0.15),
      outputPerMillion: envFloat('GROQ_GPT_OSS_120B_OUTPUT_PER_1M', 0.60),
      currency: 'USD',
    },
    // llama-3.3-70b-versatile — Groq hosted
    'llama-3.3-70b-versatile': {
      inputPerMillion: envFloat('GROQ_LLAMA_70B_INPUT_PER_1M', 0.59),
      outputPerMillion: envFloat('GROQ_LLAMA_70B_OUTPUT_PER_1M', 0.79),
      currency: 'USD',
    },
    // Fallback / generic groq model key
    unknown: null,
  },
  heuristic: null, // heuristic provider has no LLM cost
};

// Allow JSON override via LLM_PRICING_JSON env var for full table replacement
function loadLlmPricing() {
  const raw = process.env.LLM_PRICING_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      return parsed;
    } catch {
      // fall through to defaults
    }
  }
  return DEFAULT_LLM_PRICING;
}

let _cachedPricing = null;
function getLlmPricingTable() {
  // Lazily evaluate so envFloat picks up runtime env in tests
  if (_cachedPricing && process.env.NODE_ENV === 'test') {
    // In test, re-evaluate to allow env overrides per-test
    return buildLlmPricing();
  }
  if (_cachedPricing) return _cachedPricing;
  _cachedPricing = buildLlmPricing();
  return _cachedPricing;
}

function buildLlmPricing() {
  return {
    groq: {
      'openai/gpt-oss-120b': {
        inputPerMillion: envFloat('GROQ_GPT_OSS_120B_INPUT_PER_1M', 0.15),
        outputPerMillion: envFloat('GROQ_GPT_OSS_120B_OUTPUT_PER_1M', 0.60),
        currency: 'USD',
      },
      'llama-3.3-70b-versatile': {
        inputPerMillion: envFloat('GROQ_LLAMA_70B_INPUT_PER_1M', 0.59),
        outputPerMillion: envFloat('GROQ_LLAMA_70B_OUTPUT_PER_1M', 0.79),
        currency: 'USD',
      },
    },
    heuristic: null,
  };
}

/**
 * Resolve pricing for a provider/model pair.
 * Returns { inputPerMillion, outputPerMillion, currency } or null if unavailable.
 * Normalizes provider/model to lower-case trimmed strings.
 */
function getLlmPricing(provider, model) {
  if (!provider) return null;
  const table = getLlmPricingTable();
  const p = String(provider).toLowerCase().trim();
  const m = model ? String(model).trim() : null;

  const providerEntry = table[p];
  if (providerEntry === null) return null; // e.g., heuristic
  if (providerEntry == null) return null; // unknown provider

  if (m && providerEntry[m]) return providerEntry[m];
  // Fallback: try case-insensitive model match
  if (m) {
    const key = Object.keys(providerEntry).find((k) => k.toLowerCase() === m.toLowerCase());
    if (key) return providerEntry[key];
  }
  return null;
}

// ── External API pricing ───────────────────────────────────────────────────
// IMPORTANT: Do NOT assume every ExternalApiLog has a cost.
// A call count is NOT a billable unit. Only services with known pricing
// and usage units should be configured. Defaults are null (unavailable).
// Set env vars to enable:
//   TAVILY_PRICE_PER_1K_SEARCHES — Tavily search API price per 1000 searches (USD)

function getExternalApiPricing() {
  const tavilyRaw = process.env.TAVILY_PRICE_PER_1K_SEARCHES;
  const tavilyPer1k = tavilyRaw != null && tavilyRaw !== '' ? parseFloat(tavilyRaw) : null;
  const tavily =
    tavilyPer1k != null && Number.isFinite(tavilyPer1k)
      ? { perCall: tavilyPer1k / 1000, per1k: tavilyPer1k, currency: 'USD', unit: 'search' }
      : null;

  return {
    tavily,
    // All repository connectors (openneuro, dandi, etc.) use free public APIs
    // Repository search is heuristic/no-cost; no pricing configured.
    // Explicitly null to indicate "no billable usage known"
    openneuro: null,
    dandi: null,
    zenodo: null,
    figshare: null,
    dryad: null,
    osf: null,
    nitrc: null,
    neurovault: null,
    ebrains: null,
    repository_search: null,
    fallback: null,
  };
}

function getExternalPricingForService(service) {
  if (!service) return null;
  const table = getExternalApiPricing();
  const key = String(service).toLowerCase().trim();
  // Direct match
  if (table[key] != null) return table[key];
  // Unknown service -> null (unavailable)
  return null;
}

module.exports = {
  getLlmPricing,
  getLlmPricingTable,
  getExternalApiPricing,
  getExternalPricingForService,
  // For testing / introspection
  _buildLlmPricing: buildLlmPricing,
};
