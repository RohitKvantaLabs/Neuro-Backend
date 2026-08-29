'use strict';

const { buildLiteratureQuery } = require('../src/modules/literature/literatureQuery');
const { normalizeOpenAlexWork, normalizeTavilyHit } = require('../src/modules/literature/literatureNormalizer');
const { deduplicateLiterature, normalizeDoi, normalizeUrl } = require('../src/modules/literature/literatureDedup');
const { rankLiterature, signalMatch } = require('../src/modules/literature/literatureRanker');
const {
  extractCandidateTasks,
  extractCandidateModalities,
  extractCandidateAgeGroups,
} = require('../src/modules/literature/literatureSemantics');
const { orchestrateLiterature } = require('../src/modules/literature/literatureOrchestrator');

describe('LiteratureQuery', () => {
  it('builds literature search from QueryFilters', () => {
    const q = buildLiteratureQuery({ raw_query: 'Resting-state fMRI in children with ADHD', modality: ['fMRI'], condition: ['ADHD'], age_range: 'child', task: 'resting-state', species: ['human'] });
    expect(q.raw_query).toBe('Resting-state fMRI in children with ADHD');
    expect(q.concepts.modality).toContain('fMRI');
    expect(q.literatureSearch).toBe('Resting-state fMRI in children with ADHD');
  });
  it('handles empty query', () => {
    const q = buildLiteratureQuery({});
    expect(q.literatureSearch).toBe('');
  });
});

describe('LiteratureNormalizer', () => {
  it('normalizes OpenAlex work with DOI and PMID', () => {
    const work = {
      id: 'https://openalex.org/W123', doi: 'https://doi.org/10.1234/test', title: 'Test paper on ADHD fMRI',
      abstract_inverted_index: { Test: [0], paper: [1] },
      authorships: [{ author: { display_name: 'Alice' } }],
      host_venue: { display_name: 'Nature' }, publication_year: 2022, cited_by_count: 42,
      ids: { pmid: 'https://pubmed.ncbi.nlm.nih.gov/12345' }, primary_location: { landing_page_url: 'https://doi.org/10.1234/test' },
      type: 'journal-article',
    };
    const c = normalizeOpenAlexWork(work);
    expect(c.doi).toBe('10.1234/test');
    expect(c.pmid).toBe('12345');
    expect(c.provider).toBe('openalex');
    expect(c.abstract).toBe('Test paper');
  });
  it('normalizes Tavily hit', () => {
    const hit = { title: 'ADHD fMRI review', url: 'https://pubmed.ncbi.nlm.nih.gov/98765', snippet: 'abstract here' };
    const c = normalizeTavilyHit(hit);
    expect(c.pmid).toBe('98765');
    expect(c.provider).toBe('tavily');
  });
});

describe('LiteratureDedup', () => {
  it('dedups by DOI normalized', () => {
    const a = { title: 'A', doi: '10.1234/Test', pmid: null, url: 'https://example.com/a', provider: 'openalex' };
    const b = { title: 'A duplicate', doi: 'https://doi.org/10.1234/test', pmid: null, url: 'https://example.com/b', provider: 'tavily' };
    const out = deduplicateLiterature([a, b]);
    expect(out.length).toBe(1);
    expect(out[0].provider).toBe('openalex');
  });
  it('dedups by PMID', () => {
    const a = { title: 'A', doi: null, pmid: '123', url: 'https://a.com', provider: 'openalex' };
    const b = { title: 'B', doi: null, pmid: '123', url: 'https://b.com', provider: 'tavily' };
    expect(deduplicateLiterature([a, b]).length).toBe(1);
  });
  it('dedups by URL normalized', () => {
    const a = { title: 'A', doi: null, pmid: null, url: 'https://example.com/paper/', provider: 'openalex' };
    const b = { title: 'A', doi: null, pmid: null, url: 'https://example.com/paper', provider: 'tavily' };
    expect(deduplicateLiterature([a, b]).length).toBe(1);
  });
  it('dedups by title 0.95', () => {
    const a = { title: 'Resting state fMRI in children with ADHD: a comprehensive review', doi: null, pmid: null, url: 'https://a.com/1', provider: 'openalex' };
    const b = { title: 'Resting state fMRI in children with ADHD: a comprehensive review', doi: null, pmid: null, url: 'https://b.com/2', provider: 'tavily' };
    expect(deduplicateLiterature([a, b]).length).toBe(1);
  });
  it('normalizeDoi strips prefix', () => {
    expect(normalizeDoi('DOI:10.1234/ABC')).toBe('10.1234/abc');
    expect(normalizeDoi('https://doi.org/10.1234/abc')).toBe('10.1234/abc');
  });
});

describe('LiteratureRanker evidence location matching', () => {
  it('identifies title, abstract, snippet, and title+abstract evidence locations', () => {
    const q = { concepts: { modality: ['fMRI'], condition: ['ADHD'] } };
    const titleMatch = { title: 'fMRI in ADHD', abstract: null, snippet: null };
    const abstractMatch = { title: 'Study of brain', abstract: 'fMRI in ADHD patients', snippet: null };
    const snippetMatch = { title: 'Web article', abstract: null, snippet: 'fMRI in ADHD' };
    const titleAndAbstractMatch = { title: 'fMRI in ADHD', abstract: 'fMRI in ADHD patients', snippet: null };

    expect(signalMatch(q.concepts, titleMatch).evidence.modality).toBe('title');
    expect(signalMatch(q.concepts, abstractMatch).evidence.modality).toBe('abstract');
    expect(signalMatch(q.concepts, snippetMatch).evidence.modality).toBe('snippet');
    expect(signalMatch(q.concepts, titleAndAbstractMatch).evidence.modality).toBe('title+abstract');
  });

  it('ranks title matches higher than abstract and snippet matches', () => {
    const q = { raw_query: 'ADHD fMRI', concepts: { modality: ['fMRI'], condition: ['ADHD'] } };
    const inTitle = { title: 'ADHD fMRI paper', abstract: null, snippet: null, citation_count: 0, year: 2023 };
    const inAbstract = { title: 'Brain paper', abstract: 'ADHD fMRI study', snippet: null, citation_count: 0, year: 2023 };
    const inSnippet = { title: 'Web hit', abstract: null, snippet: 'ADHD fMRI review', citation_count: 0, year: 2023 };

    const ranked = rankLiterature([inSnippet, inAbstract, inTitle], q);
    expect(ranked[0].title).toBe('ADHD fMRI paper');
    expect(ranked[1].title).toBe('Brain paper');
    expect(ranked[2].title).toBe('Web hit');
  });

  it('handles missing abstract and missing snippet gracefully', () => {
    const q = { concepts: { modality: ['fMRI'] } };
    const noAbstractNoSnippet = { title: 'fMRI study', abstract: null, snippet: null };
    const res = signalMatch(q.concepts, noAbstractNoSnippet);
    expect(res.matched).toBe(1);
    expect(res.evidence.modality).toBe('title');
  });

  it('differentiates Autism Tavily snippet match from title condition match', () => {
    const q = { concepts: { modality: ['fMRI'], condition: ['Autism'], task: 'resting-state', age_range: 'child' } };
    const adhdPaperWithAutismSnippet = {
      title: 'Functional network connectivity in children with ADHD: A resting-state fMRI study',
      abstract: null,
      snippet: 'Related articles on Autism spectrum disorder',
    };
    const res = signalMatch(q.concepts, adhdPaperWithAutismSnippet);
    expect(res.evidence.condition).toBe('snippet');
    expect(res.evidence.task).toBe('title');
    expect(res.evidence.modality).toBe('title');
    expect(res.evidence.age_range).toBe('title');
  });
});

describe('Phase 1 Candidate Condition Semantics', () => {
  it('C1: Primary condition in title produces MATCH with title evidence', () => {
    const q = { concepts: { condition: ['Autism'] } };
    const cand = { title: 'Resting-state connectivity in children with autism', abstract: null };
    const res = signalMatch(q.concepts, cand);
    expect(res.matched).toBe(1);
    expect(res.evidence.condition).toBe('title');
  });

  it('C2: Secondary autism mention in abstract produces abstract evidence, not title', () => {
    const q = { concepts: { condition: ['Autism'] } };
    const cand = {
      title: 'Resting-state connectivity in children with ADHD',
      abstract: 'Previous autism studies have demonstrated executive dysfunction...',
    };
    const res = signalMatch(q.concepts, cand);
    expect(res.matched).toBe(1);
    expect(res.evidence.condition).toBe('abstract');
    expect(res.evidence.condition).not.toBe('title');
  });

  it('C3: Multiple conditions in candidate produce MATCH without contradiction penalty', () => {
    const q = { concepts: { condition: ['Autism'] } };
    const cand = { title: 'Autism and ADHD comorbidity in children', abstract: null };
    const res = signalMatch(q.concepts, cand);
    expect(res.matched).toBe(1);
    expect(res.evidence.condition).toBe('title');
  });

  it('C4: Unknown condition when no condition metadata or text exists', () => {
    const q = { concepts: { condition: ['Autism'] } };
    const cand = { title: 'General brain atlas paper', abstract: 'Methods for brain segmentation' };
    const res = signalMatch(q.concepts, cand);
    expect(res.evidence.condition).toBe('unknown');
    expect(res.unknown).toBe(1);
  });
});

describe('Phase 1 Candidate Task Semantics', () => {
  it('T1: Primary task in title produces MATCH with title evidence', () => {
    const q = { concepts: { task: 'working-memory' } };
    const cand = { title: 'Working Memory fMRI Study', abstract: null };
    const res = signalMatch(q.concepts, cand);
    expect(res.matched).toBe(1);
    expect(res.evidence.task).toBe('title');
  });

  it('T2: Hyphen vs space normalization matches working-memory with working memory', () => {
    const q = { concepts: { task: 'working-memory' } };
    const cand = { title: 'Neural correlates of working memory in health and disease', abstract: null };
    const res = signalMatch(q.concepts, cand);
    expect(res.matched).toBe(1);
    expect(res.evidence.task).toBe('title');
  });

  it('T3: Resting-state normalization matches resting-state with resting state', () => {
    const q = { concepts: { task: 'resting-state' } };
    const cand = { title: 'Altered resting state networks in Alzheimer disease', abstract: null };
    const res = signalMatch(q.concepts, cand);
    expect(res.matched).toBe(1);
    expect(res.evidence.task).toBe('title');
  });

  it('T4: Secondary task mention in abstract produces abstract evidence, not title', () => {
    const q = { concepts: { task: 'working-memory' } };
    const cand = {
      title: 'Resting-state functional connectivity in dementia',
      abstract: 'Additionally, working memory performance was evaluated...',
    };
    const res = signalMatch(q.concepts, cand);
    expect(res.matched).toBe(1);
    expect(res.evidence.task).toBe('abstract');
  });

  it('T5: Unknown task when no task evidence exists', () => {
    const q = { concepts: { task: 'working-memory' } };
    const cand = { title: 'Structural MRI analysis of cortex', abstract: null };
    const res = signalMatch(q.concepts, cand);
    expect(res.evidence.task).toBe('unknown');
  });
});

describe('Phase 1 Corrective Ranking Invariants & Task Evidence Strength (R1-R6)', () => {
  it('R1: Coverage, termCoverage, and relevanceBase cannot exceed 1.0', () => {
    const q = {
      raw_query: 'Resting-state fMRI in children with ADHD',
      concepts: { modality: ['fMRI'], condition: ['ADHD'], age_range: 'child', task: 'resting-state' },
    };
    const cand = {
      title: 'Resting-state fMRI study in children with ADHD',
      abstract: 'fMRI resting state ADHD children',
      year: 2023,
      citation_count: 100,
    };
    const ranked = rankLiterature([cand], q);
    expect(ranked[0]._relevance.coverage).toBeLessThanOrEqual(1.0);
    expect(ranked[0]._relevance.termCoverage).toBeLessThanOrEqual(1.0);
    expect(ranked[0]._literatureScore).toBeLessThanOrEqual(1.0);
  });

  it('R2: Primary task in title outranks secondary abstract task when competing title task exists', () => {
    const q = {
      raw_query: 'Working memory fMRI in Alzheimer\'s disease',
      concepts: { modality: ['fMRI'], condition: ["Alzheimer's disease"], task: 'working-memory' },
    };
    const candPrimary = {
      title: "Working Memory fMRI Study in Alzheimer's Disease",
      abstract: 'fMRI working memory alzheimers',
      year: 2020,
      citation_count: 50,
    };
    const candSecondary = {
      title: "Resting-State Functional Connectivity in Alzheimer's Disease: An fMRI study",
      abstract: 'Additionally, working memory performance was evaluated in alzheimers patients...',
      year: 2020,
      citation_count: 50,
    };

    const ranked = rankLiterature([candSecondary, candPrimary], q);
    expect(ranked[0].title).toBe(candPrimary.title);
    expect(ranked[0]._literatureScore).toBeGreaterThan(ranked[1]._literatureScore);
  });

  it('R3: Secondary task in abstract still receives valid secondary score (0.6)', () => {
    const candSecondary = {
      title: "Resting-State Functional Connectivity in Alzheimer's Disease",
      abstract: 'working memory performance was assessed...',
    };
    const candTasks = extractCandidateTasks(candSecondary);
    const wmTask = candTasks.find(t => t.value === 'working-memory');
    expect(wmTask).toBeDefined();
    expect(wmTask.evidence).toBe('abstract');
    expect(wmTask.strength).toBe('secondary');
    expect(wmTask.score).toBe(0.6);
  });

  it('R4: Abstract task without competing title task retains normal abstract score (1.0)', () => {
    const candNormal = {
      title: "Neuroimaging Study in Alzheimer's Disease",
      abstract: 'working memory performance was assessed...',
    };
    const candTasks = extractCandidateTasks(candNormal);
    const wmTask = candTasks.find(t => t.value === 'working-memory');
    expect(wmTask).toBeDefined();
    expect(wmTask.evidence).toBe('abstract');
    expect(wmTask.strength).toBe('normal');
    expect(wmTask.score).toBe(1.0);
  });

  it('R5: Existing evidence hierarchy title > abstract > snippet is preserved', () => {
    const q = { concepts: { task: 'working-memory' } };
    const titleCand = { title: 'Working Memory Study', abstract: null, snippet: null };
    const abstractCand = { title: 'General Brain Study', abstract: 'working memory test', snippet: null };
    const snippetCand = { title: 'Web Page', abstract: null, snippet: 'working memory article' };

    const titleMatch = signalMatch(q.concepts, titleCand);
    const abstractMatch = signalMatch(q.concepts, abstractCand);
    const snippetMatch = signalMatch(q.concepts, snippetCand);

    expect(titleMatch.weightedMatched).toBeGreaterThan(abstractMatch.weightedMatched);
    expect(abstractMatch.weightedMatched).toBeGreaterThan(snippetMatch.weightedMatched);
  });

  it('R6: Condition matching preserves title > abstract evidence without hard mismatch penalty', () => {
    const q = { concepts: { condition: ['Autism'] } };
    const titleCand = { title: 'Autism Study', abstract: null };
    const abstractCand = { title: 'ADHD Study', abstract: 'Compared with autism...' };

    const titleRes = signalMatch(q.concepts, titleCand);
    const abstractRes = signalMatch(q.concepts, abstractCand);

    expect(titleRes.evidence.condition).toBe('title');
    expect(abstractRes.evidence.condition).toBe('abstract');
    expect(abstractRes.matched).toBe(1);
  });
});

describe('Phase 2 Candidate Modality Semantics (M1-M8)', () => {
  it('M1: fMRI in title produces candidate_modality = fmri with title evidence', () => {
    const cand = { title: 'Functional MRI study of autism', abstract: null };
    const mods = extractCandidateModalities(cand);
    const fmriMod = mods.find(m => m.value === 'fmri');
    expect(fmriMod).toBeDefined();
    expect(fmriMod.evidence).toBe('title');
    expect(fmriMod.score).toBe(1.5);
  });

  it('M2: Functional magnetic resonance imaging maps to canonical fmri', () => {
    const cand = { title: 'Functional magnetic resonance imaging study', abstract: null };
    const mods = extractCandidateModalities(cand);
    const fmriMod = mods.find(m => m.value === 'fmri');
    expect(fmriMod).toBeDefined();
  });

  it('M3: Structural MRI does not become exact fMRI match and registers MISMATCH', () => {
    const q = { concepts: { modality: ['fMRI'] } };
    const cand = { title: 'Structural MRI study', abstract: null };
    const mods = extractCandidateModalities(cand);
    const structMod = mods.find(m => m.value === 'structural-mri');
    const fmriMod = mods.find(m => m.value === 'fmri');

    expect(structMod).toBeDefined();
    expect(fmriMod).toBeUndefined();

    const res = signalMatch(q.concepts, cand);
    expect(res.evidenceDetails.modality.status).toBe('MISMATCH');
    expect(res.mismatched).toBeGreaterThan(0);
  });

  it('M4: Abstract modality produces abstract evidence', () => {
    const cand = { title: 'Neuroimaging study in autism', abstract: 'Functional magnetic resonance imaging was used...' };
    const mods = extractCandidateModalities(cand);
    const fmriMod = mods.find(m => m.value === 'fmri');
    expect(fmriMod).toBeDefined();
    expect(fmriMod.evidence).toBe('abstract');
    expect(fmriMod.score).toBe(1.0);
  });

  it('M5: Snippet modality produces snippet evidence', () => {
    const cand = { title: 'Generic title', abstract: null, snippet: 'EEG recordings...' };
    const mods = extractCandidateModalities(cand);
    const eegMod = mods.find(m => m.value === 'eeg');
    expect(eegMod).toBeDefined();
    expect(eegMod.evidence).toBe('snippet');
    expect(eegMod.score).toBe(0.5);
  });

  it('M6: Resting-state fMRI phrase span suppresses duplicate fmri sub-span match', () => {
    const cand = { title: 'Resting-state fMRI connectivity in autism', abstract: null };
    const mods = extractCandidateModalities(cand);
    expect(mods.some(m => m.value === 'resting-state-fmri')).toBe(true);
    expect(mods.some(m => m.value === 'fmri')).toBe(false);
  });

  it('M7: fMRI query matches candidate with resting-state-fmri through parent relationship without double-counting', () => {
    const q = { concepts: { modality: ['fMRI'] } };
    const cand = { title: 'Resting-state fMRI connectivity', abstract: null };
    const res = signalMatch(q.concepts, cand);
    expect(res.evidence.modality).toBe('title');
    expect(res.matched).toBe(1);
  });

  it('M8: Separate non-overlapping modalities in same candidate remain distinct', () => {
    const cand = { title: 'EEG and fMRI study', abstract: null };
    const mods = extractCandidateModalities(cand);
    expect(mods.some(m => m.value === 'eeg')).toBe(true);
    expect(mods.some(m => m.value === 'fmri')).toBe(true);
  });
});

describe('Phase 2 Candidate Age Group Semantics (A1-A8)', () => {
  it('A1: Child in title produces candidate_age_group = child with title evidence', () => {
    const cand = { title: 'Resting-state fMRI in children with autism', abstract: null };
    const ages = extractCandidateAgeGroups(cand);
    const childAge = ages.find(a => a.value === 'child');
    expect(childAge).toBeDefined();
    expect(childAge.evidence).toBe('title');
    expect(childAge.score).toBe(1.5);
  });

  it('A2: Pediatric synonym maps to canonical child', () => {
    const cand = { title: 'Pediatric autism neuroimaging study', abstract: null };
    const ages = extractCandidateAgeGroups(cand);
    const childAge = ages.find(a => a.value === 'child');
    expect(childAge).toBeDefined();
  });

  it('A3: Adolescent in title maps to canonical adolescent', () => {
    const cand = { title: 'Adolescent working memory study', abstract: null };
    const ages = extractCandidateAgeGroups(cand);
    const adolAge = ages.find(a => a.value === 'adolescent');
    expect(adolAge).toBeDefined();
  });

  it('A4: Elderly synonym maps to canonical older-adult', () => {
    const cand = { title: 'MRI study in elderly participants', abstract: null };
    const ages = extractCandidateAgeGroups(cand);
    const olderAge = ages.find(a => a.value === 'older-adult');
    expect(olderAge).toBeDefined();
  });

  it('A5: Abstract age produces abstract evidence', () => {
    const cand = { title: 'Neuroimaging study of autism', abstract: 'The study included children aged 8-12 years...' };
    const ages = extractCandidateAgeGroups(cand);
    const childAge = ages.find(a => a.value === 'child');
    expect(childAge).toBeDefined();
    expect(childAge.evidence).toBe('abstract');
  });

  it('A6: Older adults phrase span suppresses duplicate adult sub-span match', () => {
    const cand = { title: 'MRI study in older adults with Alzheimer\'s disease', abstract: null };
    const ages = extractCandidateAgeGroups(cand);
    expect(ages.some(a => a.value === 'older-adult')).toBe(true);
    expect(ages.some(a => a.value === 'adult')).toBe(false);
  });

  it('A7: Young adults phrase span suppresses duplicate adult sub-span match', () => {
    const cand = { title: 'Working memory in young adults', abstract: null };
    const ages = extractCandidateAgeGroups(cand);
    expect(ages.some(a => a.value === 'young-adult')).toBe(true);
    expect(ages.some(a => a.value === 'adult')).toBe(false);
  });

  it('A8: Separate age groups in text remain distinct', () => {
    const cand = { title: 'Comparison of children and older adults', abstract: null };
    const ages = extractCandidateAgeGroups(cand);
    expect(ages.some(a => a.value === 'child')).toBe(true);
    expect(ages.some(a => a.value === 'older-adult')).toBe(true);
  });
});

describe('Phase 2 Ranking Integration & UNKNOWN Neutrality (R7-R8)', () => {
  it('R7: Primary modality in title beats abstract modality evidence', () => {
    const q = { raw_query: 'fMRI study in autism', concepts: { modality: ['fMRI'], condition: ['Autism'] } };
    const titleCand = { title: 'fMRI study in autism', abstract: null, year: 2022, citation_count: 10 };
    const abstractCand = { title: 'Neuroimaging study in autism', abstract: 'fMRI was used...', year: 2022, citation_count: 10 };

    const ranked = rankLiterature([abstractCand, titleCand], q);
    expect(ranked[0].title).toBe('fMRI study in autism');
    expect(ranked[0]._literatureScore).toBeGreaterThan(ranked[1]._literatureScore);
  });

  it('R8: Primary age evidence in title beats abstract age evidence', () => {
    const q = { raw_query: 'Autism in children', concepts: { condition: ['Autism'], age_range: 'child' } };
    const titleCand = { title: 'Autism study in children', abstract: null, year: 2022, citation_count: 10 };
    const abstractCand = { title: 'Autism neuroimaging study', abstract: 'The participants were children...', year: 2022, citation_count: 10 };

    const ranked = rankLiterature([abstractCand, titleCand], q);
    expect(ranked[0].title).toBe('Autism study in children');
    expect(ranked[0]._literatureScore).toBeGreaterThan(ranked[1]._literatureScore);
  });

  it('Controlled Modality & Age Ranking Comparison (No artificial score inflation from duplicate sub-spans)', () => {
    const q = { raw_query: 'fMRI older adults Alzheimer\'s', concepts: { modality: ['fMRI'], condition: ["Alzheimer's disease"], age_range: 'older-adult' } };
    const candA = { title: 'fMRI study in older adults with Alzheimer\'s disease', abstract: null, year: 2022, citation_count: 10 };
    const candB = { title: 'MRI study in older adults with Alzheimer\'s disease', abstract: null, year: 2022, citation_count: 10 };

    const ranked = rankLiterature([candB, candA], q);
    expect(ranked[0].title).toBe(candA.title);
    expect(ranked[0]._relevance.coverage).toBeLessThanOrEqual(1.0);
    expect(ranked[1]._relevance.coverage).toBeLessThanOrEqual(1.0);
  });

  it('UNKNOWN Neutrality: Missing explicit age or modality does not produce negative penalty or mismatch', () => {
    const q = { raw_query: 'fMRI in children', concepts: { modality: ['fMRI'], age_range: 'child' } };
    const candWithAgeMod = { title: 'fMRI study in children', abstract: null, year: 2022, citation_count: 0 };
    const candSparse = { title: 'General brain study', abstract: null, year: 2022, citation_count: 0 };

    const ranked = rankLiterature([candSparse, candWithAgeMod], q);
    expect(ranked[0].candidate_modality.length).toBeGreaterThan(0);
    expect(ranked[0].candidate_age_group.length).toBeGreaterThan(0);
    expect(ranked[1].candidate_modality.length).toBe(0);
    expect(ranked[1].candidate_age_group.length).toBe(0);
    expect(ranked[1]._literatureScore).toBeGreaterThanOrEqual(0);
  });
});

describe('Phase 3 Contradiction Semantics & Controlled Ordering (C5-C6, M9-M10, A9-A10, T6)', () => {
  it('C5: Condition MISMATCH produces controlled negative contribution and status MISMATCH', () => {
    const q = { raw_query: 'Autism study', concepts: { condition: ['Autism'] } };
    const cand = { title: 'ADHD resting-state study', abstract: 'ADHD participants...' };
    const res = signalMatch(q.concepts, cand);
    expect(res.evidenceDetails.condition).toBeDefined();
    expect(res.evidenceDetails.condition.status).toBe('MISMATCH');
    expect(res.evidenceDetails.condition.requested).toBe('autism');
    expect(res.evidenceDetails.condition.candidate).toBe('adhd');
    expect(res.mismatched).toBeGreaterThan(0);
  });

  it('C6: Condition UNKNOWN produces zero penalty and status UNKNOWN', () => {
    const q = { raw_query: 'Autism study', concepts: { condition: ['Autism'] } };
    const cand = { title: 'Neuroimaging methodology study', abstract: null };
    const res = signalMatch(q.concepts, cand);
    expect(res.evidenceDetails.condition).toBeDefined();
    expect(res.evidenceDetails.condition.status).toBe('UNKNOWN');
    expect(res.evidenceDetails.condition.score).toBe(0.0);
    expect(res.mismatched).toBe(0);
  });

  it('M9: Modality MISMATCH produces controlled negative contribution when explicit competing modality present', () => {
    const q = { raw_query: 'EEG seizure study', concepts: { modality: ['EEG'] } };
    const cand = { title: 'fMRI study in epilepsy', abstract: null };
    const res = signalMatch(q.concepts, cand);
    expect(res.evidenceDetails.modality).toBeDefined();
    expect(res.evidenceDetails.modality.status).toBe('MISMATCH');
    expect(res.evidenceDetails.modality.requested).toBe('eeg');
    expect(res.evidenceDetails.modality.candidate).toBe('fmri');
    expect(res.mismatched).toBeGreaterThan(0);
  });

  it('M10: Modality UNKNOWN produces zero penalty for sparse modality metadata', () => {
    const q = { raw_query: 'EEG seizure study', concepts: { modality: ['EEG'] } };
    const cand = { title: 'Epilepsy study', abstract: null };
    const res = signalMatch(q.concepts, cand);
    expect(res.evidenceDetails.modality).toBeDefined();
    expect(res.evidenceDetails.modality.status).toBe('UNKNOWN');
    expect(res.evidenceDetails.modality.score).toBe(0.0);
    expect(res.mismatched).toBe(0);
  });

  it('A9: Age MISMATCH produces controlled negative contribution when explicit competing age present', () => {
    const q = { raw_query: 'Autism in children', concepts: { age_range: 'child' } };
    const cand = { title: 'Autism study in older adults', abstract: null };
    const res = signalMatch(q.concepts, cand);
    expect(res.evidenceDetails.age_range).toBeDefined();
    expect(res.evidenceDetails.age_range.status).toBe('MISMATCH');
    expect(res.evidenceDetails.age_range.requested).toBe('child');
    expect(res.evidenceDetails.age_range.candidate).toBe('older-adult');
    expect(res.mismatched).toBeGreaterThan(0);
  });

  it('A10: Age UNKNOWN produces zero penalty for sparse age metadata', () => {
    const q = { raw_query: 'Autism in children', concepts: { age_range: 'child' } };
    const cand = { title: 'Alzheimer\'s MRI study', abstract: null };
    const res = signalMatch(q.concepts, cand);
    expect(res.evidenceDetails.age_range).toBeDefined();
    expect(res.evidenceDetails.age_range.status).toBe('UNKNOWN');
    expect(res.evidenceDetails.age_range.score).toBe(0.0);
    expect(res.mismatched).toBe(0);
  });

  it('T6: Task MISMATCH produces controlled negative contribution when explicit competing task in title', () => {
    const q = { raw_query: 'Working memory fMRI', concepts: { task: 'working-memory' } };
    const cand = { title: 'Resting-state fMRI study', abstract: null };
    const res = signalMatch(q.concepts, cand);
    expect(res.evidenceDetails.task).toBeDefined();
    expect(res.evidenceDetails.task.status).toBe('MISMATCH');
    expect(res.evidenceDetails.task.requested).toBe('working-memory');
    expect(res.evidenceDetails.task.candidate).toBe('resting-state');
  });

  it('C7: Multiple-condition coexistence preserves MATCH for requested condition without contradiction penalty', () => {
    const q = { raw_query: 'Autism study', concepts: { condition: ['Autism'] } };
    const cand = { title: 'Autism and ADHD comorbidity study', abstract: 'Autism and ADHD participants...' };
    const res = signalMatch(q.concepts, cand);
    expect(res.evidenceDetails.condition).toBeDefined();
    expect(res.evidenceDetails.condition.status).toBe('MATCH');
    expect(res.evidenceDetails.condition.candidate).toBe('autism');
    expect(res.mismatched).toBe(0);
  });

  it('C8: Condition UNKNOWN remains neutral with zero penalty for sparse metadata', () => {
    const q = { raw_query: 'Autism study', concepts: { condition: ['Autism'] } };
    const cand = { title: 'Generic neuroimaging methodology study', abstract: null };
    const res = signalMatch(q.concepts, cand);
    expect(res.evidenceDetails.condition.status).toBe('UNKNOWN');
    expect(res.evidenceDetails.condition.score).toBe(0.0);
    expect(res.mismatched).toBe(0);
  });

  it('C9: Condition MISMATCH triggered only when requested condition absent and competing condition present', () => {
    const q = { raw_query: 'Autism study', concepts: { condition: ['Autism'] } };
    const cand = { title: 'ADHD neuroimaging study', abstract: null };
    const res = signalMatch(q.concepts, cand);
    expect(res.evidenceDetails.condition.status).toBe('MISMATCH');
    expect(res.evidenceDetails.condition.requested).toBe('autism');
    expect(res.evidenceDetails.condition.candidate).toBe('adhd');
  });

  it('T7: Multiple-task coexistence preserves MATCH for requested task without contradiction penalty', () => {
    const q = { raw_query: 'Working memory fMRI', concepts: { task: 'working-memory' } };
    const cand = { title: 'Working memory and resting-state fMRI study', abstract: null };
    const res = signalMatch(q.concepts, cand);
    expect(res.evidenceDetails.task).toBeDefined();
    expect(res.evidenceDetails.task.status).toBe('MATCH');
    expect(res.evidenceDetails.task.candidate).toBe('working-memory');
    expect(res.mismatched).toBe(0);
  });

  it('T8: Task UNKNOWN remains neutral with zero penalty for sparse task metadata', () => {
    const q = { raw_query: 'Working memory fMRI', concepts: { task: 'working-memory' } };
    const cand = { title: 'fMRI connectivity study', abstract: null };
    const res = signalMatch(q.concepts, cand);
    expect(res.evidenceDetails.task.status).toBe('UNKNOWN');
    expect(res.evidenceDetails.task.score).toBe(0.0);
    expect(res.mismatched).toBe(0);
  });

  it('T9: Task MISMATCH triggered only when requested task absent and title explicitly concerns competing task', () => {
    const q = { raw_query: 'Working memory fMRI', concepts: { task: 'working-memory' } };
    const cand = { title: 'Resting-state fMRI study', abstract: null };
    const res = signalMatch(q.concepts, cand);
    expect(res.evidenceDetails.task.status).toBe('MISMATCH');
    expect(res.evidenceDetails.task.requested).toBe('working-memory');
    expect(res.evidenceDetails.task.candidate).toBe('resting-state');
  });

  it('Critical Regression Test 1: Autism resting-state fMRI in children with ADHD comorbidity', () => {
    const q = { raw_query: 'autism resting-state fMRI in children', concepts: { condition: ['Autism'], task: 'resting-state', modality: ['fMRI'], age_range: 'child' } };
    const cand = { title: 'Autism and ADHD comorbidity study with resting-state fMRI in children', abstract: null, year: 2023, citation_count: 5 };
    const res = signalMatch(q.concepts, cand);
    expect(res.evidenceDetails.condition.status).toBe('MATCH');
    expect(res.evidenceDetails.task.status).toBe('MATCH');
    expect(res.evidenceDetails.modality.status).toBe('MATCH');
    expect(res.evidenceDetails.age_range.status).toBe('MATCH');
    expect(res.mismatched).toBe(0);
  });

  it('Critical Regression Test 2: Working-memory and resting-state fMRI study for working-memory query', () => {
    const q = { raw_query: 'working-memory fMRI', concepts: { task: 'working-memory', modality: ['fMRI'] } };
    const cand = { title: 'Working-memory and resting-state fMRI study', abstract: null, year: 2023, citation_count: 5 };
    const res = signalMatch(q.concepts, cand);
    expect(res.evidenceDetails.task.status).toBe('MATCH');
    expect(res.evidenceDetails.modality.status).toBe('MATCH');
    expect(res.mismatched).toBe(0);
  });

  it('Phase 3 Controlled Ranking Test: MATCH candidate > UNKNOWN candidate > MISMATCH candidate', () => {
    const q = { raw_query: 'EEG in children with epilepsy', concepts: { modality: ['EEG'], condition: ['Epilepsy'], age_range: 'child' } };

    const candMatch = { title: 'EEG study in children with epilepsy', abstract: null, year: 2022, citation_count: 10 };
    const candUnknown = { title: 'Epilepsy study', abstract: null, year: 2022, citation_count: 10 };
    const candMismatch = { title: 'fMRI study in older adults with multiple sclerosis', abstract: null, year: 2022, citation_count: 10 };

    const ranked = rankLiterature([candMismatch, candUnknown, candMatch], q);

    expect(ranked[0].title).toBe(candMatch.title);
    expect(ranked[1].title).toBe(candUnknown.title);
    expect(ranked[2].title).toBe(candMismatch.title);

    expect(ranked[0]._literatureScore).toBeGreaterThan(ranked[1]._literatureScore);
    expect(ranked[1]._literatureScore).toBeGreaterThan(ranked[2]._literatureScore);

    expect(ranked[0]._relevance.matched).toBe(3);
    expect(ranked[1]._relevance.unknown).toBe(2);
    expect(ranked[2]._relevance.mismatched).toBeGreaterThan(0);
  });
});

describe('LiteratureRanker UNKNOWN handling', () => {
  it('UNKNOWN not equal MISMATCH — sparse age neutral', () => {
    const q = { raw_query: 'fMRI in children with ADHD', concepts: { modality: ['fMRI'], condition: ['ADHD'], age_range: 'child', task: null, region: null, species: [] } };
    const withAge = { title: 'fMRI ADHD in children study', abstract: 'children fMRI adhd', authors: [], journal: null, year: 2023, doi: null, pmid: null, url: 'https://a.com', provider: 'openalex', citation_count: 0 };
    const withoutAge = { title: 'fMRI ADHD study', abstract: 'fMRI adhd', authors: [], journal: null, year: 2023, doi: null, pmid: null, url: 'https://b.com', provider: 'openalex', citation_count: 0 };
    const ranked = rankLiterature([withoutAge, withAge], q);
    // withAge should rank higher but withoutAge not penalized as mismatch — both have relevance >0
    expect(ranked[0].title).toBe(withAge.title);
    expect(ranked[1]._literatureScore).toBeGreaterThan(0);
  });
  it('ranks by relevance then citations', () => {
    const q = { raw_query: 'EEG Parkinson', concepts: { modality: ['EEG'], condition: ['Parkinson'], age_range: null, task: null, region: null, species: [] } };
    const c1 = { title: 'EEG in Parkinson disease highly cited', abstract: 'EEG Parkinson', authors: [], journal: 'Brain', year: 2022, doi: null, pmid: null, url: 'https://a.com', provider: 'openalex', citation_count: 100 };
    const c2 = { title: 'Unrelated paper', abstract: 'something else', authors: [], journal: null, year: 2020, doi: null, pmid: null, url: 'https://b.com', provider: 'openalex', citation_count: 0 };
    const ranked = rankLiterature([c2, c1], q);
    expect(ranked[0].title).toBe(c1.title);
  });
});

describe('LiteratureOrchestrator isolation', () => {
  it('provider failure does not throw', async () => {
    const failing = { name: 'FailingProvider', search: async () => { throw new Error('timeout'); } };
    const filters = { raw_query: 'test', modality: [], condition: [] };
    const res = await orchestrateLiterature(filters, { providers: [failing], limit: 5 });
    expect(res.results).toEqual([]);
    expect(res.metrics.providerErrors.length).toBe(1);
  }, 10000);

  it('literature lane timeout isolated (8s race)', async () => {
    const slow = { name: 'SlowProvider', search: async () => new Promise(() => {}) };
    const filters = { raw_query: 'slow unique query ' + Date.now(), modality: [], condition: [] };
    const res = await orchestrateLiterature(filters, { providers: [slow], limit: 5 });
    expect(res.metrics.providerErrors.length).toBe(1);
    expect(res.metrics.providerErrors[0].error).toMatch(/timeout/);
  }, 10000);

  it('OpenAlex success + Tavily 401 failure leaves OpenAlex results available', async () => {
    const openAlexMock = {
      name: 'OpenAlexProvider',
      search: async () => [
        {
          id: 'https://openalex.org/W999',
          title: 'OpenAlex Paper On ADHD',
          doi: 'https://doi.org/10.1000/openalex1',
          publication_year: 2023,
          cited_by_count: 10,
        },
      ],
    };
    const tavily401Mock = {
      name: 'TavilyLiteratureProvider',
      search: async () => {
        throw new Error('Request failed with status code 401');
      },
    };
    const filters = { raw_query: 'ADHD study', modality: [], condition: ['ADHD'] };
    const res = await orchestrateLiterature(filters, { providers: [openAlexMock, tavily401Mock], limit: 5 });

    expect(res.results.length).toBe(1);
    expect(res.results[0].title).toBe('OpenAlex Paper On ADHD');
    expect(res.metrics.providerErrors.length).toBe(1);
    expect(res.metrics.providerErrors[0]).toEqual({
      provider: 'TavilyLiteratureProvider',
      error: 'Request failed with status code 401',
    });
  });

  it('Tavily success with zero results produces empty errors array', async () => {
    const tavilyZeroMock = {
      name: 'TavilyLiteratureProvider',
      search: async () => [],
    };
    const filters = { raw_query: 'UnlikelyQuery123', modality: [], condition: [] };
    const res = await orchestrateLiterature(filters, { providers: [tavilyZeroMock], limit: 5 });

    expect(res.results).toEqual([]);
    expect(res.metrics.providerErrors).toEqual([]);
  });
});
