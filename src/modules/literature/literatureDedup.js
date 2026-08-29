'use strict';

/**
 * Literature deduplication — hierarchy: DOI > PMID > URL > title similarity fallback
 */

function normalizeDoi(doi) {
  return String(doi || '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//i,'').replace(/^doi:\s*/i,'').trim();
}

function normalizeUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(String(url).trim());
    // lower host, remove trailing slash, strip utm params
    u.hostname = u.hostname.toLowerCase();
    u.searchParams.delete('utm_source');
    u.searchParams.delete('utm_medium');
    u.searchParams.delete('utm_campaign');
    if (u.pathname.endsWith('/') && u.pathname.length > 1) u.pathname = u.pathname.slice(0,-1);
    return u.toString().toLowerCase();
  } catch {
    return String(url).trim().toLowerCase();
  }
}

function titleKey(title) {
  return String(title || '').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}

function jaccard(a, b) {
  const setA = new Set(a.split(' ').filter(Boolean));
  const setB = new Set(b.split(' ').filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Deduplicate literature candidates.
 * @param {Object[]} candidates - normalized LiteratureCandidate[]
 * @returns {Object[]} deduped, first occurrence wins (openalex > tavily if openalex first)
 */
function deduplicateLiterature(candidates) {
  const seenDoi = new Set();
  const seenPmid = new Set();
  const seenUrl = new Set();
  const seenTitles = [];
  const out = [];

  for (const c of candidates) {
    const doi = c.doi ? normalizeDoi(c.doi) : null;
    const pmid = c.pmid ? String(c.pmid).trim() : null;
    const url = c.url ? normalizeUrl(c.url) : null;
    const tKey = titleKey(c.title);

    if (doi && seenDoi.has(doi)) continue;
    if (pmid && seenPmid.has(pmid)) continue;
    if (url && seenUrl.has(url)) continue;

    // Title fallback: if no DOI/PMID/URL match but title >0.95 Jaccard, consider dup
    let isTitleDup = false;
    for (const prev of seenTitles) {
      if (jaccard(tKey, prev) >= 0.95) { isTitleDup = true; break; }
    }
    if (isTitleDup) continue;

    if (doi) seenDoi.add(doi);
    if (pmid) seenPmid.add(pmid);
    if (url) seenUrl.add(url);
    if (tKey) seenTitles.push(tKey);
    out.push(c);
  }
  return out;
}

module.exports = { deduplicateLiterature, normalizeDoi, normalizeUrl, titleKey, jaccard };
