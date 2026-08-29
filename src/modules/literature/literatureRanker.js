'use strict';

/**
 * Literature relevance ranking — NOT dataset ranking.
 * Phase 1: Candidate Condition & Task Semantics.
 * Phase 2: Candidate Modality & Age Group Semantics.
 * Location weights: title = 1.5, abstract = 1.0, snippet = 0.5.
 * UNKNOWN != MISMATCH (sparse fields neutral).
 */

const {
  extractCandidateConditions,
  extractCandidateTasks,
  extractCandidateModalities,
  extractCandidateAgeGroups,
  canonicalizeCondition,
  canonicalizeTask,
  canonicalizeModality,
  canonicalizeAgeGroup,
  matchSynonyms,
} = require('./literatureSemantics');

const EVIDENCE_WEIGHTS = {
  title: 1.5,
  abstract: 1.0,
  snippet: 0.5,
  unknown: 0.0,
};

const CONTRADICTION_PENALTY = 0.30;

function normalize(str) {
  return String(str || '').toLowerCase().trim();
}

function contains(haystack, needle) {
  if (!haystack || !needle) return false;
  if (haystack === needle) return true;
  if (!needle) return false;
  const normHaystack = normalize(haystack).replace(/[-_]/g, ' ');
  const normNeedle = normalize(needle).replace(/[-_]/g, ' ');
  return normHaystack.includes(normNeedle);
}

function signalMatch(concepts, candidate) {
  let matched = 0;
  let mismatched = 0;
  let unknown = 0;
  let total = 0;
  let weightedMatched = 0;
  let weightedPenalty = 0;
  const evidence = {};
  const evidenceDetails = {};

  const candConditions = extractCandidateConditions(candidate);
  const candTasks = extractCandidateTasks(candidate);
  const candModalities = extractCandidateModalities(candidate);
  const candAgeGroups = extractCandidateAgeGroups(candidate);

  const MODALITY_PARENTS = {
    'resting-state-fmri': ['fmri', 'mri'],
    fmri: ['mri'],
    'structural-mri': ['mri'],
    'diffusion-mri': ['mri'],
    dti: ['diffusion-mri', 'mri'],
    dwi: ['diffusion-mri', 'mri'],
  };

  const checkModality = (values) => {
    if (!values || (Array.isArray(values) && values.length === 0) || (!Array.isArray(values) && !values)) return;
    const vals = Array.isArray(values) ? values : [values];
    total += vals.length;
    for (const v of vals) {
      const canonicalV = canonicalizeModality(v);
      const matchObj = candModalities.find(m => m.value === canonicalV) ||
                       candModalities.find(m => matchSynonyms(m.value, [v])) ||
                       candModalities.find(m => (MODALITY_PARENTS[m.value] || []).includes(canonicalV));
      if (matchObj) {
        matched++;
        weightedMatched += matchObj.score;
        evidence['modality'] = matchObj.evidence;
        evidenceDetails['modality'] = {
          status: 'MATCH',
          requested: canonicalV,
          candidate: matchObj.value,
          evidence: matchObj.evidence,
          score: matchObj.score,
        };
      } else if (candModalities.length > 0 && !candModalities.some(m => m.value === canonicalV || (MODALITY_PARENTS[m.value] || []).includes(canonicalV))) {
        mismatched++;
        weightedPenalty += CONTRADICTION_PENALTY;
        const competing = candModalities[0];
        evidence['modality'] = competing.evidence;
        evidenceDetails['modality'] = {
          status: 'MISMATCH',
          requested: canonicalV,
          candidate: competing.value,
          evidence: competing.evidence,
          score: -CONTRADICTION_PENALTY,
        };
      } else {
        const normV = normalize(v);
        const inTitle = contains(candidate.title, normV);
        const inAbstract = contains(candidate.abstract, normV);
        const inSnippet = contains(candidate.snippet, normV);
        if (inTitle) {
          matched++;
          weightedMatched += EVIDENCE_WEIGHTS.title;
          evidence['modality'] = inAbstract ? 'title+abstract' : (inSnippet ? 'title+snippet' : 'title');
          evidenceDetails['modality'] = { status: 'MATCH', requested: canonicalV, candidate: canonicalV, evidence: evidence['modality'], score: EVIDENCE_WEIGHTS.title };
        } else if (inAbstract) {
          matched++;
          weightedMatched += EVIDENCE_WEIGHTS.abstract;
          evidence['modality'] = 'abstract';
          evidenceDetails['modality'] = { status: 'MATCH', requested: canonicalV, candidate: canonicalV, evidence: 'abstract', score: EVIDENCE_WEIGHTS.abstract };
        } else if (inSnippet) {
          matched++;
          weightedMatched += EVIDENCE_WEIGHTS.snippet;
          evidence['modality'] = 'snippet';
          evidenceDetails['modality'] = { status: 'MATCH', requested: canonicalV, candidate: canonicalV, evidence: 'snippet', score: EVIDENCE_WEIGHTS.snippet };
        } else {
          unknown++;
          evidence['modality'] = 'unknown';
          evidenceDetails['modality'] = { status: 'UNKNOWN', requested: canonicalV, candidate: null, evidence: 'unknown', score: 0.0 };
        }
      }
    }
  };

  const checkCondition = (values) => {
    if (!values || (Array.isArray(values) && values.length === 0) || (!Array.isArray(values) && !values)) return;
    const vals = Array.isArray(values) ? values : [values];
    total += vals.length;
    for (const v of vals) {
      const canonicalV = canonicalizeCondition(v);
      const matchObj = candConditions.find(c => c.value === canonicalV) ||
                       candConditions.find(c => matchSynonyms(c.value, [v]));
      if (matchObj) {
        matched++;
        weightedMatched += matchObj.score;
        evidence['condition'] = matchObj.evidence;
        evidenceDetails['condition'] = {
          status: 'MATCH',
          requested: canonicalV,
          candidate: matchObj.value,
          evidence: matchObj.evidence,
          score: matchObj.score,
        };
      } else if (candConditions.length > 0 && !candConditions.some(c => c.value === canonicalV)) {
        mismatched++;
        weightedPenalty += CONTRADICTION_PENALTY;
        const competing = candConditions[0];
        evidence['condition'] = competing.evidence;
        evidenceDetails['condition'] = {
          status: 'MISMATCH',
          requested: canonicalV,
          candidate: competing.value,
          evidence: competing.evidence,
          score: -CONTRADICTION_PENALTY,
        };
      } else {
        const normV = normalize(v);
        const inTitle = contains(candidate.title, normV);
        const inAbstract = contains(candidate.abstract, normV);
        const inSnippet = contains(candidate.snippet, normV);
        if (inTitle) {
          matched++;
          weightedMatched += EVIDENCE_WEIGHTS.title;
          evidence['condition'] = inAbstract ? 'title+abstract' : (inSnippet ? 'title+snippet' : 'title');
          evidenceDetails['condition'] = { status: 'MATCH', requested: canonicalV, candidate: canonicalV, evidence: evidence['condition'], score: EVIDENCE_WEIGHTS.title };
        } else if (inAbstract) {
          matched++;
          weightedMatched += EVIDENCE_WEIGHTS.abstract;
          evidence['condition'] = 'abstract';
          evidenceDetails['condition'] = { status: 'MATCH', requested: canonicalV, candidate: canonicalV, evidence: 'abstract', score: EVIDENCE_WEIGHTS.abstract };
        } else if (inSnippet) {
          matched++;
          weightedMatched += EVIDENCE_WEIGHTS.snippet;
          evidence['condition'] = 'snippet';
          evidenceDetails['condition'] = { status: 'MATCH', requested: canonicalV, candidate: canonicalV, evidence: 'snippet', score: EVIDENCE_WEIGHTS.snippet };
        } else {
          unknown++;
          evidence['condition'] = 'unknown';
          evidenceDetails['condition'] = { status: 'UNKNOWN', requested: canonicalV, candidate: null, evidence: 'unknown', score: 0.0 };
        }
      }
    }
  };

  const checkTask = (values) => {
    if (!values || (Array.isArray(values) && values.length === 0) || (!Array.isArray(values) && !values)) return;
    const vals = Array.isArray(values) ? values : [values];
    total += vals.length;
    for (const v of vals) {
      const canonicalV = canonicalizeTask(v);
      const matchObj = candTasks.find(t => t.value === canonicalV) ||
                       candTasks.find(t => matchSynonyms(t.value, [v]));
      if (matchObj) {
        matched++;
        weightedMatched += matchObj.score;
        evidence['task'] = matchObj.evidence;
        evidenceDetails['task'] = {
          status: 'MATCH',
          requested: canonicalV,
          candidate: matchObj.value,
          evidence: matchObj.evidence,
          score: matchObj.score,
          strength: matchObj.strength || 'normal',
        };
      } else if (candTasks.length > 0 && !candTasks.some(t => t.value === canonicalV) && candTasks.some(t => t.inTitle || t.strength === 'strong')) {
        mismatched++;
        weightedPenalty += CONTRADICTION_PENALTY;
        const competing = candTasks.find(t => t.inTitle || t.strength === 'strong') || candTasks[0];
        evidence['task'] = competing.evidence;
        evidenceDetails['task'] = {
          status: 'MISMATCH',
          requested: canonicalV,
          candidate: competing.value,
          evidence: competing.evidence,
          score: -CONTRADICTION_PENALTY,
        };
      } else {
        const normV = normalize(v);
        const inTitle = contains(candidate.title, normV);
        const inAbstract = contains(candidate.abstract, normV);
        const inSnippet = contains(candidate.snippet, normV);
        if (inTitle) {
          matched++;
          weightedMatched += EVIDENCE_WEIGHTS.title;
          evidence['task'] = inAbstract ? 'title+abstract' : (inSnippet ? 'title+snippet' : 'title');
          evidenceDetails['task'] = { status: 'MATCH', requested: canonicalV, candidate: canonicalV, evidence: evidence['task'], score: EVIDENCE_WEIGHTS.title };
        } else if (inAbstract) {
          matched++;
          weightedMatched += EVIDENCE_WEIGHTS.abstract;
          evidence['task'] = 'abstract';
          evidenceDetails['task'] = { status: 'MATCH', requested: canonicalV, candidate: canonicalV, evidence: 'abstract', score: EVIDENCE_WEIGHTS.abstract };
        } else if (inSnippet) {
          matched++;
          weightedMatched += EVIDENCE_WEIGHTS.snippet;
          evidence['task'] = 'snippet';
          evidenceDetails['task'] = { status: 'MATCH', requested: canonicalV, candidate: canonicalV, evidence: 'snippet', score: EVIDENCE_WEIGHTS.snippet };
        } else {
          unknown++;
          evidence['task'] = 'unknown';
          evidenceDetails['task'] = { status: 'UNKNOWN', requested: canonicalV, candidate: null, evidence: 'unknown', score: 0.0 };
        }
      }
    }
  };

  const checkAgeGroup = (values) => {
    if (!values || (Array.isArray(values) && values.length === 0) || (!Array.isArray(values) && !values)) return;
    const vals = Array.isArray(values) ? values : [values];
    total += vals.length;
    for (const v of vals) {
      const canonicalV = canonicalizeAgeGroup(v);
      const matchObj = candAgeGroups.find(a => a.value === canonicalV) ||
                       candAgeGroups.find(a => matchSynonyms(a.value, [v]));
      if (matchObj) {
        matched++;
        weightedMatched += matchObj.score;
        evidence['age_range'] = matchObj.evidence;
        evidenceDetails['age_range'] = {
          status: 'MATCH',
          requested: canonicalV,
          candidate: matchObj.value,
          evidence: matchObj.evidence,
          score: matchObj.score,
        };
      } else if (candAgeGroups.length > 0 && !candAgeGroups.some(a => a.value === canonicalV)) {
        mismatched++;
        weightedPenalty += CONTRADICTION_PENALTY;
        const competing = candAgeGroups[0];
        evidence['age_range'] = competing.evidence;
        evidenceDetails['age_range'] = {
          status: 'MISMATCH',
          requested: canonicalV,
          candidate: competing.value,
          evidence: competing.evidence,
          score: -CONTRADICTION_PENALTY,
        };
      } else {
        const normV = normalize(v);
        const inTitle = contains(candidate.title, normV);
        const inAbstract = contains(candidate.abstract, normV);
        const inSnippet = contains(candidate.snippet, normV);
        if (inTitle) {
          matched++;
          weightedMatched += EVIDENCE_WEIGHTS.title;
          evidence['age_range'] = inAbstract ? 'title+abstract' : (inSnippet ? 'title+snippet' : 'title');
          evidenceDetails['age_range'] = { status: 'MATCH', requested: canonicalV, candidate: canonicalV, evidence: evidence['age_range'], score: EVIDENCE_WEIGHTS.title };
        } else if (inAbstract) {
          matched++;
          weightedMatched += EVIDENCE_WEIGHTS.abstract;
          evidence['age_range'] = 'abstract';
          evidenceDetails['age_range'] = { status: 'MATCH', requested: canonicalV, candidate: canonicalV, evidence: 'abstract', score: EVIDENCE_WEIGHTS.abstract };
        } else if (inSnippet) {
          matched++;
          weightedMatched += EVIDENCE_WEIGHTS.snippet;
          evidence['age_range'] = 'snippet';
          evidenceDetails['age_range'] = { status: 'MATCH', requested: canonicalV, candidate: canonicalV, evidence: 'snippet', score: EVIDENCE_WEIGHTS.snippet };
        } else {
          unknown++;
          evidence['age_range'] = 'unknown';
          evidenceDetails['age_range'] = { status: 'UNKNOWN', requested: canonicalV, candidate: null, evidence: 'unknown', score: 0.0 };
        }
      }
    }
  };

  const checkGeneric = (field, values) => {
    if (!values || (Array.isArray(values) && values.length === 0) || (!Array.isArray(values) && !values)) return;
    const vals = Array.isArray(values) ? values : [values];
    total += vals.length;
    for (const v of vals) {
      const normV = normalize(v);
      const inTitle = contains(candidate.title, normV);
      const inAbstract = contains(candidate.abstract, normV);
      const inSnippet = contains(candidate.snippet, normV);

      if (inTitle) {
        matched++;
        weightedMatched += EVIDENCE_WEIGHTS.title;
        evidence[field] = inAbstract ? 'title+abstract' : (inSnippet ? 'title+snippet' : 'title');
      } else if (inAbstract) {
        matched++;
        weightedMatched += EVIDENCE_WEIGHTS.abstract;
        evidence[field] = 'abstract';
      } else if (inSnippet) {
        matched++;
        weightedMatched += EVIDENCE_WEIGHTS.snippet;
        evidence[field] = 'snippet';
      } else {
        unknown++;
        evidence[field] = 'unknown';
      }
    }
  };

  checkModality(concepts.modality);
  checkCondition(concepts.condition);
  if (concepts.task) checkTask([concepts.task]);
  if (concepts.region) checkGeneric('region', [concepts.region]);
  if (concepts.age_range) checkAgeGroup(concepts.age_range);

  return { matched, mismatched, weightedMatched, weightedPenalty, unknown, total, evidence, evidenceDetails, candConditions, candTasks, candModalities, candAgeGroups };
}

function computeCitationScore(citationCount) {
  if (citationCount == null) return 0.5;
  if (citationCount >= 100) return 1.0;
  if (citationCount >= 20) return 0.8;
  if (citationCount >= 5) return 0.6;
  return 0.4;
}

function computeRecencyScore(year) {
  if (!year) return 0.5;
  const age = new Date().getFullYear() - year;
  if (age <= 2) return 1.0;
  if (age <= 5) return 0.8;
  if (age <= 10) return 0.6;
  return 0.4;
}

/**
 * Rank literature candidates.
 * @param {Object[]} candidates - normalized LiteratureCandidate[]
 * @param {Object} literatureQuery - from buildLiteratureQuery()
 * @returns {Object[]} ranked with _literatureScore
 */
function rankLiterature(candidates, literatureQuery) {
  if (!candidates || candidates.length === 0) return [];
  const concepts = literatureQuery.concepts || {};

  const scored = candidates.map(c => {
    const cov = signalMatch(concepts, c);
    const maxCoveragePossible = cov.total > 0 ? cov.total * EVIDENCE_WEIGHTS.title : 1.0;
    const rawCoverage = cov.total > 0 ? (cov.weightedMatched - cov.weightedPenalty) / maxCoveragePossible : 0.5;
    const coverage = Math.min(1.0, Math.max(0.0, rawCoverage));

    const titleHit = (concepts.condition || []).some(v => contains(c.title, v)) || (concepts.modality || []).some(v => contains(c.title, v));
    const queryTerms = String(literatureQuery.raw_query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const titleTerms = String(c.title || '').toLowerCase();
    const abstractTerms = String(c.abstract || '').toLowerCase();
    const snippetTerms = String(c.snippet || '').toLowerCase();
    let termCoverage = 0;
    if (queryTerms.length > 0) {
      let weightedHits = 0;
      for (const t of queryTerms) {
        if (t.length >= 3) {
          if (titleTerms.includes(t)) weightedHits += EVIDENCE_WEIGHTS.title;
          else if (abstractTerms.includes(t)) weightedHits += EVIDENCE_WEIGHTS.abstract;
          else if (snippetTerms.includes(t)) weightedHits += EVIDENCE_WEIGHTS.snippet;
        }
      }
      const rawTermCoverage = weightedHits / (queryTerms.length * EVIDENCE_WEIGHTS.title);
      termCoverage = Math.min(1.0, Math.max(0.0, rawTermCoverage));
    }

    const citationScore = computeCitationScore(c.citation_count);
    const recencyScore = computeRecencyScore(c.year);

    // Literature weights: relevance dominant, recency/citation secondary
    const relevanceBase = Math.min(1.0, Math.max(0.0, coverage * 0.6 + termCoverage * 0.4));
    const score = (
      relevanceBase * 0.6 +
      recencyScore * 0.2 +
      citationScore * 0.15 +
      (titleHit ? 0.05 : 0)
    );

    return {
      ...c,
      candidate_condition: cov.candConditions,
      candidate_task: cov.candTasks,
      candidate_modality: cov.candModalities,
      candidate_age_group: cov.candAgeGroups,
      _literatureScore: Math.round(Math.min(Math.max(score, 0), 1) * 10000) / 10000,
      _relevance: {
        coverage,
        termCoverage,
        titleHit,
        matched: cov.matched,
        mismatched: cov.mismatched,
        unknown: cov.unknown,
        total: cov.total,
        evidence: cov.evidence,
        evidenceDetails: cov.evidenceDetails,
      },
      _citationScore: citationScore,
      _recencyScore: recencyScore,
    };
  });

  scored.sort((a, b) => {
    if (b._literatureScore !== a._literatureScore) return b._literatureScore - a._literatureScore;
    if ((b.citation_count || 0) !== (a.citation_count || 0)) return (b.citation_count || 0) - (a.citation_count || 0);
    if ((b.year || 0) !== (a.year || 0)) return (b.year || 0) - (a.year || 0);
    return String(a.title).localeCompare(String(b.title));
  });

  return scored.slice(0, 30);
}

module.exports = { rankLiterature, signalMatch, computeCitationScore, computeRecencyScore, EVIDENCE_WEIGHTS, CONTRADICTION_PENALTY };
