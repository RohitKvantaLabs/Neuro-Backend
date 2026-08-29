'use strict';

/**
 * Literature Candidate Semantics — Phase 1 (Condition + Task) + Phase 2 (Modality + Age Group)
 * Deterministic candidate-side semantic extraction with evidence provenance & span-overlap resolution.
 */

const CONDITION_SYNONYMS = {
  autism: ['autism', 'autistic', 'autism spectrum disorder', 'autism spectrum', 'asd'],
  adhd: ['adhd', 'attention deficit hyperactivity disorder', 'attention-deficit/hyperactivity disorder', 'attention deficit'],
  alzheimer: ['alzheimer', "alzheimer's", "alzheimer's disease", 'alzheimers', 'dementia', 'mci', 'mild cognitive impairment'],
  parkinson: ['parkinson', "parkinson's", "parkinson's disease", 'parkinsons'],
  epilepsy: ['epilepsy', 'seizure', 'seizures', 'epileptic'],
  depression: ['depression', 'depressive', 'major depressive disorder', 'mdd'],
  'multiple sclerosis': ['multiple sclerosis', 'ms'],
};

const TASK_SYNONYMS = {
  'resting-state': ['resting-state', 'resting state', 'resting state fmri', 'resting-state fmri', 'rs-fmri', 'rsfmri', 'resting'],
  'working-memory': ['working-memory', 'working memory', 'n-back', 'nback', 'working memory task'],
  motor: ['motor', 'motor task', 'finger tapping', 'motor imagery', 'motor execution', 'movement'],
  attention: ['attention', 'attention task', 'visual attention', 'sustained attention'],
  memory: ['memory', 'memory task', 'associative memory', 'episodic memory', 'memory retrieval'],
  'seizure-detection': ['seizure detection', 'seizure detection eeg', 'seizure prediction', 'spike detection'],
};

const MODALITY_SYNONYMS = {
  'resting-state-fmri': ['resting-state fmri', 'resting state fmri', 'rs-fmri', 'rsfmri'],
  fmri: ['fmri', 'functional mri', 'functional magnetic resonance imaging'],
  mri: ['mri', 'magnetic resonance imaging'],
  eeg: ['eeg', 'electroencephalography', 'electroencephalogram'],
  meg: ['meg', 'magnetoencephalography'],
  pet: ['pet', 'positron emission tomography'],
  dti: ['dti', 'diffusion tensor imaging'],
  'diffusion-mri': ['diffusion mri', 'diffusion-weighted mri', 'dmri'],
  'structural-mri': ['structural mri', 'smri', 'structural magnetic resonance imaging'],
  asl: ['asl', 'arterial spin labeling', 'arterial spin labelling'],
  dwi: ['dwi', 'diffusion weighted imaging', 'diffusion-weighted imaging'],
};

const AGE_SYNONYMS = {
  infant: ['infant', 'infants', 'baby', 'babies'],
  toddler: ['toddler', 'toddlers'],
  child: ['child', 'children', 'childhood', 'pediatric', 'paediatric'],
  adolescent: ['adolescent', 'adolescents', 'teenager', 'teenagers', 'youth'],
  'young-adult': ['young adult', 'young adults'],
  adult: ['adult', 'adults'],
  'middle-aged': ['middle-aged', 'middle aged'],
  'older-adult': ['older adult', 'older adults', 'elderly', 'aged', 'older people', 'older participants'],
};

function normalizeText(str) {
  return String(str || '').toLowerCase().replace(/[-_]/g, ' ');
}

function matchSynonyms(text, synonymList) {
  if (!text || !synonymList) return false;
  const normText = normalizeText(text);
  return synonymList.some(syn => {
    const normSyn = normalizeText(syn);
    return normText.includes(normSyn);
  });
}

/**
 * Find all non-overlapping vocabulary matches in text.
 * Prefers the longest/most specific matching phrase span, suppressing sub-spans.
 */
function findMatchingSpans(text, synonymMap) {
  if (!text) return [];
  const normText = normalizeText(text);
  const matches = [];

  for (const [canonical, synonyms] of Object.entries(synonymMap)) {
    for (const syn of synonyms) {
      const normSyn = normalizeText(syn);
      if (!normSyn) continue;
      let pos = 0;
      while ((pos = normText.indexOf(normSyn, pos)) !== -1) {
        const start = pos;
        const end = pos + normSyn.length;
        matches.push({ canonical, synonym: normSyn, start, end, len: normSyn.length });
        pos += Math.max(1, normSyn.length);
      }
    }
  }

  const nonOverlapping = matches.filter(matchA => {
    const isSubSpan = matches.some(matchB => {
      if (matchA === matchB) return false;
      const contained = matchA.start >= matchB.start && matchA.end <= matchB.end;
      const strictlyLonger = matchB.len > matchA.len;
      return contained && strictlyLonger;
    });
    return !isSubSpan;
  });

  return nonOverlapping;
}

function canonicalizeCondition(queryCond) {
  const normQuery = normalizeText(queryCond);
  for (const [canonical, synonyms] of Object.entries(CONDITION_SYNONYMS)) {
    if (synonyms.some(syn => normalizeText(syn) === normQuery || normQuery.includes(normalizeText(syn)))) {
      return canonical;
    }
  }
  return normQuery;
}

function canonicalizeTask(queryTask) {
  const normQuery = normalizeText(queryTask);
  for (const [canonical, synonyms] of Object.entries(TASK_SYNONYMS)) {
    if (synonyms.some(syn => normalizeText(syn) === normQuery || normQuery.includes(normalizeText(syn)))) {
      return canonical;
    }
  }
  return normQuery;
}

function canonicalizeModality(queryModality) {
  const normQuery = normalizeText(queryModality);
  for (const [canonical, synonyms] of Object.entries(MODALITY_SYNONYMS)) {
    if (synonyms.some(syn => normalizeText(syn) === normQuery || normQuery.includes(normalizeText(syn)))) {
      return canonical;
    }
  }
  return normQuery;
}

function canonicalizeAgeGroup(queryAge) {
  const normQuery = normalizeText(queryAge);
  for (const [canonical, synonyms] of Object.entries(AGE_SYNONYMS)) {
    if (synonyms.some(syn => normalizeText(syn) === normQuery || normQuery.includes(normalizeText(syn)))) {
      return canonical;
    }
  }
  return normQuery;
}

/**
 * Extract candidate conditions with evidence location.
 * @param {Object} candidate - normalized LiteratureCandidate
 * @returns {Array<{ value: string, evidence: string, score: number }>}
 */
function extractCandidateConditions(candidate) {
  const conditions = [];
  const concepts = Array.isArray(candidate.concepts) ? candidate.concepts : [];

  for (const [canonical, synonyms] of Object.entries(CONDITION_SYNONYMS)) {
    const inTitle = matchSynonyms(candidate.title, synonyms);
    const inAbstract = matchSynonyms(candidate.abstract, synonyms);
    const inSnippet = matchSynonyms(candidate.snippet, synonyms);
    const inConcept = concepts.some(c => matchSynonyms(c.name || c.display_name, synonyms) && (c.score || 0) >= 0.3);

    if (inTitle || inAbstract || inSnippet || inConcept) {
      let evidence = 'unknown';
      let score = 0.0;
      if (inTitle) {
        evidence = inAbstract ? 'title+abstract' : (inSnippet ? 'title+snippet' : 'title');
        score = 1.5;
      } else if (inAbstract) {
        evidence = 'abstract';
        score = 1.0;
      } else if (inConcept) {
        evidence = 'concept';
        score = 1.0;
      } else if (inSnippet) {
        evidence = 'snippet';
        score = 0.5;
      }

      conditions.push({ value: canonical, evidence, score, inTitle, inAbstract, inSnippet, inConcept });
    }
  }

  return conditions;
}

/**
 * Extract candidate tasks with evidence location and strength.
 * @param {Object} candidate - normalized LiteratureCandidate
 * @returns {Array<{ value: string, evidence: string, score: number, strength: string }>}
 */
function extractCandidateTasks(candidate) {
  const tasks = [];
  const hasTitleTask = Object.values(TASK_SYNONYMS).some(synonyms => matchSynonyms(candidate.title, synonyms));

  for (const [canonical, synonyms] of Object.entries(TASK_SYNONYMS)) {
    const inTitle = matchSynonyms(candidate.title, synonyms);
    const inAbstract = matchSynonyms(candidate.abstract, synonyms);
    const inSnippet = matchSynonyms(candidate.snippet, synonyms);

    if (inTitle || inAbstract || inSnippet) {
      let evidence = 'unknown';
      let score = 0.0;
      let strength = 'normal';

      if (inTitle) {
        evidence = inAbstract ? 'title+abstract' : (inSnippet ? 'title+snippet' : 'title');
        score = 1.5;
        strength = 'strong';
      } else if (inAbstract) {
        evidence = 'abstract';
        if (hasTitleTask) {
          // Candidate title explicitly contains a DIFFERENT recognized task
          strength = 'secondary';
          score = 0.6;
        } else {
          strength = 'normal';
          score = 1.0;
        }
      } else if (inSnippet) {
        evidence = 'snippet';
        score = 0.5;
        strength = 'weak';
      }

      tasks.push({ value: canonical, evidence, score, strength, inTitle, inAbstract, inSnippet });
    }
  }

  return tasks;
}

/**
 * Extract candidate modalities with evidence location & span-overlap resolution.
 * @param {Object} candidate - normalized LiteratureCandidate
 * @returns {Array<{ value: string, evidence: string, score: number }>}
 */
function extractCandidateModalities(candidate) {
  const modalities = [];
  const concepts = Array.isArray(candidate.concepts) ? candidate.concepts : [];

  const titleSpans = findMatchingSpans(candidate.title, MODALITY_SYNONYMS);
  const abstractSpans = findMatchingSpans(candidate.abstract, MODALITY_SYNONYMS);
  const snippetSpans = findMatchingSpans(candidate.snippet, MODALITY_SYNONYMS);

  for (const [canonical, synonyms] of Object.entries(MODALITY_SYNONYMS)) {
    const inTitle = titleSpans.some(s => s.canonical === canonical);
    const inAbstract = abstractSpans.some(s => s.canonical === canonical);
    const inSnippet = snippetSpans.some(s => s.canonical === canonical);
    const inConcept = concepts.some(c => matchSynonyms(c.name || c.display_name, synonyms) && (c.score || 0) >= 0.3);

    if (inTitle || inAbstract || inSnippet || inConcept) {
      let evidence = 'unknown';
      let score = 0.0;
      if (inTitle) {
        evidence = inAbstract ? 'title+abstract' : (inSnippet ? 'title+snippet' : 'title');
        score = 1.5;
      } else if (inAbstract) {
        evidence = 'abstract';
        score = 1.0;
      } else if (inConcept) {
        evidence = 'concept';
        score = 1.0;
      } else if (inSnippet) {
        evidence = 'snippet';
        score = 0.5;
      }

      modalities.push({ value: canonical, evidence, score, inTitle, inAbstract, inSnippet, inConcept });
    }
  }

  return modalities;
}

/**
 * Extract candidate age groups with evidence location & span-overlap resolution.
 * @param {Object} candidate - normalized LiteratureCandidate
 * @returns {Array<{ value: string, evidence: string, score: number }>}
 */
function extractCandidateAgeGroups(candidate) {
  const ageGroups = [];
  const concepts = Array.isArray(candidate.concepts) ? candidate.concepts : [];

  const titleSpans = findMatchingSpans(candidate.title, AGE_SYNONYMS);
  const abstractSpans = findMatchingSpans(candidate.abstract, AGE_SYNONYMS);
  const snippetSpans = findMatchingSpans(candidate.snippet, AGE_SYNONYMS);

  for (const [canonical, synonyms] of Object.entries(AGE_SYNONYMS)) {
    const inTitle = titleSpans.some(s => s.canonical === canonical);
    const inAbstract = abstractSpans.some(s => s.canonical === canonical);
    const inSnippet = snippetSpans.some(s => s.canonical === canonical);
    const inConcept = concepts.some(c => matchSynonyms(c.name || c.display_name, synonyms) && (c.score || 0) >= 0.3);

    if (inTitle || inAbstract || inSnippet || inConcept) {
      let evidence = 'unknown';
      let score = 0.0;
      if (inTitle) {
        evidence = inAbstract ? 'title+abstract' : (inSnippet ? 'title+snippet' : 'title');
        score = 1.5;
      } else if (inAbstract) {
        evidence = 'abstract';
        score = 1.0;
      } else if (inConcept) {
        evidence = 'concept';
        score = 1.0;
      } else if (inSnippet) {
        evidence = 'snippet';
        score = 0.5;
      }

      ageGroups.push({ value: canonical, evidence, score, inTitle, inAbstract, inSnippet, inConcept });
    }
  }

  return ageGroups;
}

module.exports = {
  CONDITION_SYNONYMS,
  TASK_SYNONYMS,
  MODALITY_SYNONYMS,
  AGE_SYNONYMS,
  normalizeText,
  matchSynonyms,
  findMatchingSpans,
  canonicalizeCondition,
  canonicalizeTask,
  canonicalizeModality,
  canonicalizeAgeGroup,
  extractCandidateConditions,
  extractCandidateTasks,
  extractCandidateModalities,
  extractCandidateAgeGroups,
};
