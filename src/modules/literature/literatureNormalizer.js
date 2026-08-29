'use strict';

/**
 * Literature normalization — provider-specific → LiteratureCandidate
 * Candidate fields VERIFIED against OpenAlex + Tavily actual responses.
 */

// OpenAlex inverted index → text
function reconstructAbstract(inverted) {
  if (!inverted || typeof inverted !== 'object') return null;
  const words = [];
  for (const [term, indices] of Object.entries(inverted)) {
    for (const idx of indices) {
      words[idx] = term;
    }
  }
  return words.filter(Boolean).join(' ');
}

function normalizeOpenAlexWork(work) {
  if (!work || typeof work !== 'object') return null;
  const title = String(work.title || work.display_name || '').trim() || 'Untitled';
  const doi = work.doi ? String(work.doi).replace(/^https?:\/\/doi\.org\//i, '').trim().toLowerCase() : null;
  const ids = work.ids || {};
  const pmid = ids.pmid ? String(ids.pmid).replace(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//i,'').trim() : null;
  const pmcid = ids.pmcid ? String(ids.pmcid).trim() : null;
  const openAlexId = work.id ? String(work.id).replace('https://openalex.org/','').trim() : null;
  const url = work.doi ? `https://doi.org/${doi}` : (work.primary_location?.landing_page_url || work.id || null);
  const authors = Array.isArray(work.authorships) ? work.authorships.map(a => a.author?.display_name || '').filter(Boolean) : [];
  const journal = work.host_venue?.display_name || work.primary_location?.source?.display_name || null;
  const year = work.publication_year || (work.publication_date ? new Date(work.publication_date).getFullYear() : null);
  const abstract = reconstructAbstract(work.abstract_inverted_index);
  const citationCount = typeof work.cited_by_count === 'number' ? work.cited_by_count : null;
  const type = work.type || null;
  const concepts = Array.isArray(work.concepts)
    ? work.concepts.map(c => ({
        name: String(c.display_name || '').toLowerCase(),
        score: typeof c.score === 'number' ? c.score : 0,
        level: c.level,
      }))
    : [];

  if (!title || title === 'Untitled') return null;

  return {
    title,
    abstract,
    snippet: null,
    concepts,
    authors,
    journal,
    year,
    doi,
    pmid,
    pmcid,
    openalex_id: openAlexId,
    url,
    provider: 'openalex',
    provider_id: openAlexId || doi || pmid || url,
    citation_count: citationCount,
    publication_type: type,
    is_preprint: type === 'preprint',
    raw: work,
  };
}

function normalizeTavilyHit(hit) {
  if (!hit || !hit.url) return null;
  const title = String(hit.title || 'Untitled').trim();
  if (!title || title === 'Untitled') return null;
  const snippet = hit.snippet || hit.content || null;
  return {
    title,
    abstract: null,
    snippet,
    authors: [],
    journal: null,
    year: null,
    doi: extractDoi(hit.url) || null,
    pmid: extractPmid(hit.url),
    pmcid: null,
    openalex_id: null,
    url: hit.url,
    provider: 'tavily',
    provider_id: hit.url,
    citation_count: null,
    publication_type: 'web',
    is_preprint: false,
    raw: hit,
  };
}

function extractDoi(url) {
  const m = String(url).match(/10\.\d{4,9}\/[-._;()\/:A-Z0-9]+/i);
  return m ? m[0].toLowerCase() : null;
}
function extractPmid(url) {
  const m = String(url).match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i);
  return m ? m[1] : null;
}

function normalizeLiteratureResults(provider, rawResults) {
  if (!Array.isArray(rawResults)) return [];
  const normalized = [];
  for (const raw of rawResults) {
    let cand = null;
    if (provider === 'openalex') cand = normalizeOpenAlexWork(raw);
    else if (provider === 'tavily') cand = normalizeTavilyHit(raw);
    else {
      // generic fallback
      cand = normalizeTavilyHit(raw) || normalizeOpenAlexWork(raw);
    }
    if (cand && cand.title && cand.url) normalized.push(cand);
  }
  return normalized;
}

module.exports = { normalizeOpenAlexWork, normalizeTavilyHit, normalizeLiteratureResults, reconstructAbstract };
