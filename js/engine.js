/*
 * MRI — AI / Intelligence Layer (browser port of backend/ai_engine.py).
 *
 * DESIGN PRINCIPLE (unchanged from the server version):
 * AI never makes the final decision. It only produces Extraction, Matching,
 * Score, Evidence, Matched/Missing Criteria, Gap Analysis, Recommendation
 * and Confidence. HR always confirms the actual decision.
 *
 * NO-HALLUCINATION RULE: if a field cannot be found in the CV text it is
 * returned as null / empty — never invented.
 *
 * This is a line-by-line port, deliberately preserving the behaviour of the
 * Python implementation (keyword libraries, heuristics, scoring formulas,
 * rounding). tests/parity_engine.py + tests/parity.test.mjs check that both
 * implementations produce the same output on the same input.
 *
 * Regex note: Python's \b / \w are Unicode-aware while JavaScript's are
 * ASCII-only, so word boundaries are expressed with explicit Unicode
 * look-arounds (BL / BR below).
 */
import { pyRound, splitlines, pylen, isDigitChar, pySplitWords, snippetOf } from './util.js';

export const NOT_DETECTED = 'Not detected in CV';
export const INSUFFICIENT_EVIDENCE = 'Insufficient evidence';
export const AI_MODEL_VERSION = 'rule-based-v1';

const W = '[\\p{L}\\p{N}_]';           // a "word" character
const BL = `(?<!${W})`;                 // left word boundary before a word char
const BR = `(?!${W})`;                  // right word boundary after a word char

export const EDUCATION_LEVELS = [
  ['S3', ['s3', 'doktor', 'phd', 'doctorate']],
  ['S2', ['s2', 'magister', 'master']],
  ['S1', ['s1', 'sarjana', 'bachelor', 'b.eng', 'b.sc', 'st,', 'se,']],
  ['D3', ['d3', 'diploma']],
  ['SMA/SMK', ['sma', 'smk', 'high school']],
];

export const TECHNICAL_SKILL_LIBRARY = [
  'Six Sigma', 'Lean Manufacturing', 'SAP', 'Production Planning', 'Kaizen',
  '5S', 'TPM', 'Quality Control', 'Quality Assurance', 'Supply Chain',
  'Procurement', 'Inventory Management', 'Warehouse Management', 'Logistics',
  'Python', 'Java', 'JavaScript', 'SQL', 'Excel', 'Power BI', 'Tableau',
  'AutoCAD', 'SolidWorks', 'PLC', 'SCADA', 'Machine Learning', 'Data Analysis',
  'Financial Analysis', 'Accounting', 'Taxation', 'Budgeting', 'Auditing',
  'Digital Marketing', 'SEO', 'Social Media Marketing', 'Content Marketing',
  'Sales Forecasting', 'CRM', 'Salesforce', 'Negotiation',
  'Recruitment', 'Payroll', 'Talent Management', 'HRIS', 'Labor Law',
  'Project Management', 'Agile', 'Scrum', 'Risk Management',
  'Civil Engineering', 'Structural Analysis', 'Electrical Engineering',
  'Network Administration', 'Cybersecurity', 'Cloud Computing', 'DevOps',
  'Customer Service', 'Public Relations', 'Legal Drafting', 'Compliance',
];

export const SOFT_SKILL_KEYWORDS = [
  'leadership', 'communication', 'teamwork', 'problem solving',
  'kepemimpinan', 'komunikasi', 'kerja tim', 'negosiasi', 'negotiation',
  'adaptability', 'time management', 'manajemen waktu', 'kolaborasi',
  'collaboration', 'critical thinking', 'public speaking',
];

export const LEADERSHIP_KEYWORDS = [
  'manager', 'supervisor', 'lead', 'head of', 'kepala', 'manajer',
  'leader', 'chief', 'director', 'direktur', 'koordinator', 'coordinator',
];

export const KNOWN_CERTIFICATIONS = [
  'Six Sigma Green Belt', 'Six Sigma Black Belt', 'Six Sigma Yellow Belt',
  'Lean Six Sigma', 'Lean Six Sigma GB', 'Lean Six Sigma Green Belt',
  'PMP', 'Project Management Professional', 'PRINCE2',
  'CAPM', 'Scrum Master', 'CSM', 'PSM',
  'ISO 9001', 'ISO 14001', 'ISO 45001', 'ISO Auditor', 'Lead Auditor',
  'ISO 9001 Lead Auditor',
  'AWS Certified', 'AWS Certified Solutions Architect', 'AWS Solutions Architect',
  'Microsoft Certified', 'Azure Fundamentals', 'CCNA', 'CCNP', 'CompTIA',
  'CISSP', 'CISA', 'CEH',
  'BNSP', 'K3', 'Ahli K3', 'SMK3',
  'CPA', 'CFA', 'CMA', 'Brevet Pajak', 'Brevet A', 'Brevet B',
  'SHRM', 'PHR', 'SPHR',
  'TOEFL', 'IELTS', 'TOEIC',
];

const YEAR = '(?:19|20)[0-9]{2}';
const DATE_TOKEN = `(${BL}${YEAR}${BR}|${BL}present${BR}|${BL}sekarang${BR})`;
const DATE_RANGE_SRC = `${DATE_TOKEN}\\s*[-\\u2013\\u2014]\\s*${DATE_TOKEN}`;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(?:\+?62|0)8[0-9]{8,11}/;
const YEAR_RE = new RegExp(`${BL}(?:19|20)[0-9]{2}${BR}`, 'u');
const EDU_NEGATION_RE = new RegExp(`${BL}(bukan|tidak|belum|not\\s+a|not\\s+from)${BR}[^.]{0,25}$`, 'iu');

const EDUCATION_CONTEXT_KEYWORDS = [
  'universitas', 'institut', 'politeknik', 'sekolah', 'smk', 'sma',
  's1', 's2', 's3', 'd3', 'diploma', 'lulus', 'graduated', 'jurusan',
  'fakultas', 'faculty', 'major', 'gpa', 'ipk', 'bachelor', 'master',
];
const ORG_CONTEXT_KEYWORDS = [
  'organisasi', 'himpunan', 'ukm', 'unit kegiatan mahasiswa', 'volunteer',
  'kepanitiaan', 'panitia', 'relawan', 'student organization', 'committee',
];
const COMPANY_INDICATORS = ['pt ', 'pt.', 'cv ', 'cv.', 'inc', 'ltd', 'corp', 'llc', 'group', 'tbk'];

const SECTION_HEADER_WORDS = new Set([
  'sertifikasi', 'certification', 'certifications', 'certificate', 'certificates',
]);

function reEscape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const isAsciiDigits = (s) => /^[0-9]+$/.test(s);

// ------------------------------------------------------------------
// Candidate profile extraction
// ------------------------------------------------------------------

function guessName(text) {
  for (let line of splitlines(text).slice(0, 8)) {
    line = line.trim();
    const words = pySplitWords(line);
    if (words.length >= 2 && words.length <= 5 && pylen(line) < 60 && !EMAIL_RE.test(line)) {
      if (![...line].some(isDigitChar)) return line;
    }
  }
  return null;
}

function extractEducation(text) {
  const lower = text.toLowerCase();
  const found = [];
  let highest = null;
  for (const [level, keywords] of EDUCATION_LEVELS) {
    for (const kw of keywords) {
      const idx = lower.indexOf(kw);
      if (idx !== -1) {
        const before = text.slice(Math.max(0, idx - 30), idx);
        if (EDU_NEGATION_RE.test(before)) continue;
        const snippet = snippetOf(text, idx - 40, idx + 60);
        found.push({ level, major: null, institution: null, graduation_year: null, evidence_text: snippet });
        if (highest === null) highest = level;
        break;
      }
    }
  }
  return [found, highest];
}

function looksLikeEducationContext(text, idx) {
  const windowText = text.slice(Math.max(0, idx - 70), idx + 10).toLowerCase();
  return EDUCATION_CONTEXT_KEYWORDS.some(kw => windowText.includes(kw));
}

function looksLikeOrgContext(text, idx) {
  const windowText = text.slice(Math.max(0, idx - 100), idx + 10).toLowerCase();
  return ORG_CONTEXT_KEYWORDS.some(kw => windowText.includes(kw));
}

function splitPositionCompany(line) {
  if (!line || !line.trim()) return [null, null];
  let parts = line.split(/[|,\u2013\u2014-]/).map(p => p.trim()).filter(Boolean);
  const dateRe = new RegExp(DATE_RANGE_SRC, 'iu');
  parts = parts.filter(p => !dateRe.test(p) && !/^(?:19|20)[0-9]{2}$/.test(p));
  if (!parts.length) return [null, null];

  if (parts.length === 1) {
    const single = parts[0];
    const low = single.toLowerCase();
    let splitAt = null;
    for (const ind of COMPANY_INDICATORS) {
      const m = new RegExp(`(?<!${W})${reEscape(ind.trim())}(?!${W})`, 'u').exec(low);
      if (m && (splitAt === null || m.index < splitAt)) splitAt = m.index;
    }
    if (splitAt !== null && splitAt > 0) return [single.slice(0, splitAt).trim(), single.slice(splitAt).trim()];
    return [single, null];
  }

  let position = null, company = null;
  for (const p of parts) {
    const pl = p.toLowerCase();
    if (COMPANY_INDICATORS.some(ind => pl.startsWith(ind) || pl.includes(` ${ind}`)) && company === null) company = p;
    else if (position === null) position = p;
  }
  if (position === null && parts.length) position = parts[0];
  return [position, company];
}

function extractExperience(text) {
  const experiences = [];
  let totalYears = 0.0;
  const lines = splitlines(text);
  const offsets = [];
  let pos = 0;
  for (const ln of lines) { offsets.push(pos); pos += ln.length + 1; } // UTF-16 units, same domain as m.index

  const re = new RegExp(DATE_RANGE_SRC, 'giu');
  for (const m of text.matchAll(re)) {
    const idx = m.index;
    if (looksLikeEducationContext(text, idx)) continue;
    const isOrgActivity = looksLikeOrgContext(text, idx);

    const startRaw = m[1], endRaw = m[2];
    const startYear = isAsciiDigits(startRaw) ? parseInt(startRaw, 10) : null;
    const endYear = !isAsciiDigits(endRaw) ? new Date().getFullYear() : parseInt(endRaw, 10);
    if (startYear && !isOrgActivity) totalYears += Math.max(0, endYear - startYear);

    const snippet = snippetOf(text, idx - 100, idx + 60);
    const isLead = LEADERSHIP_KEYWORDS.some(kw => snippet.toLowerCase().includes(kw));

    let lineIdx = 0;
    for (let i = 0; i < offsets.length; i++) {
      if (offsets[i] <= idx) lineIdx = i; else break;
    }
    const candidateLines = [(lines[lineIdx] || '').trim()];
    if (lineIdx > 0 && (lines[lineIdx - 1] || '').trim()) candidateLines.unshift(lines[lineIdx - 1].trim());

    let position = null, company = null;
    for (const cl of [...candidateLines].reverse()) {
      [position, company] = splitPositionCompany(cl);
      if (position || company) break;
    }

    experiences.push({
      company, position, industry: null, start_date: startRaw, end_date: endRaw,
      is_leadership: isLead, evidence_text: snippet,
    });
  }
  return [experiences, pyRound(totalYears, 1)];
}

function precededByCompanyPrefix(text, idx) {
  const before = text.slice(Math.max(0, idx - 6), idx).toLowerCase();
  const stripped = before.replace(/\s+$/, '');
  return COMPANY_INDICATORS.some(ind => stripped.endsWith(ind.trim()));
}

function extractSkills(text) {
  const lower = text.toLowerCase();
  const skills = [];
  const seen = new Set();
  for (const kw of TECHNICAL_SKILL_LIBRARY) {
    const k = kw.toLowerCase();
    if (lower.includes(k) && !seen.has(k)) {
      const idx = lower.indexOf(k);
      if (precededByCompanyPrefix(text, idx)) continue;
      seen.add(k);
      skills.push({ skill_name: kw, skill_type: 'technical', evidence_text: snippetOf(text, idx - 30, idx + 40) });
    }
  }
  for (const kw of SOFT_SKILL_KEYWORDS) {
    const k = kw.toLowerCase();
    if (lower.includes(k) && !seen.has(k)) {
      seen.add(k);
      const idx = lower.indexOf(k);
      skills.push({ skill_name: kw, skill_type: 'soft', evidence_text: snippetOf(text, idx - 30, idx + 40) });
    }
  }
  return skills;
}

const NEGATION_CERT_RE = new RegExp(
  `${BL}(tidak ada|belum ada|no\\s+certif${W}*|none|not\\s+applicable|n/a|` +
  `not\\s+certified|belum\\s+bersertifikat|currently\\s+pursuing|` +
  `sedang\\s+menempuh|working\\s+towards|candidate\\s+for|kandidat\\s+untuk|` +
  `in\\s+progress|dalam\\s+proses)${BR}`, 'iu');
const CERT_WORD_RE = new RegExp(`${BL}certif|sertifikas|certified${BR}`, 'iu');
const CERT_WORD_STRIP_RE = new RegExp(`${BL}certif${W}*${BR}|${BL}sertifikas${W}*${BR}|${BL}certified${BR}`, 'giu');

function extractCertifications(text) {
  const lower = text.toLowerCase();
  const certs = [];
  const seen = new Set();
  const claimed = [];
  const overlaps = (a, b) => claimed.some(([s, e]) => !(b <= s || a >= e));

  const sorted = [...KNOWN_CERTIFICATIONS].sort((a, b) => b.length - a.length); // stable, longest first
  for (const name of sorted) {
    if (seen.has(name.toLowerCase())) continue;
    const idx = lower.indexOf(name.toLowerCase());
    if (idx === -1) continue;
    const endIdx = idx + name.length;
    if (overlaps(idx, endIdx)) continue;
    const windowText = text.slice(Math.max(0, idx - 40), endIdx + 10);
    if (NEGATION_CERT_RE.test(windowText)) continue;
    seen.add(name.toLowerCase());
    claimed.push([idx, endIdx]);
    const snippet = snippetOf(text, idx - 40, idx + 60);
    const ym = YEAR_RE.exec(snippet);
    certs.push({ name, issuer: null, year: ym ? parseInt(ym[0], 10) : null, evidence_text: snippet });
  }

  for (const line of splitlines(text)) {
    const clean = line.trim();
    if (!clean || SECTION_HEADER_WORDS.has(clean.toLowerCase().replace(/:+$/, ''))) continue;
    const letters = [...clean].filter(ch => /\p{L}/u.test(ch));
    if (letters.length && letters.every(ch => ch === ch.toUpperCase() && ch !== ch.toLowerCase()) && pySplitWords(clean).length > 1) continue;
    if (NEGATION_CERT_RE.test(clean)) continue;
    const cl = clean.toLowerCase();
    if (COMPANY_INDICATORS.some(ind => cl.includes(ind))) continue;
    if (CERT_WORD_RE.test(clean)) {
      const stripped = clean.replace(CERT_WORD_STRIP_RE, '');
      const remaining = (stripped.match(/[\p{L}\p{N}_]+/gu) || []).filter(w => pylen(w) > 2);
      if (remaining.length <= 1) continue;
      const key = cl.slice(0, 120);
      if (seen.has(key) || [...seen].some(s => key.includes(s) || s.includes(key))) continue;
      seen.add(key);
      const ym = YEAR_RE.exec(clean);
      certs.push({ name: clean.slice(0, 120), issuer: null, year: ym ? parseInt(ym[0], 10) : null, evidence_text: clean });
    }
  }
  return certs;
}

/** GENERAL, vacancy-independent extraction. Takes only raw CV text. */
export function extractCandidateProfile(text) {
  const [educations, highestEdu] = extractEducation(text);
  const [experiences, totalYears] = extractExperience(text);
  const skills = extractSkills(text);
  const certifications = extractCertifications(text);
  const emailMatch = EMAIL_RE.exec(text);
  const phoneMatch = PHONE_RE.exec(text);
  return {
    name: guessName(text),
    email: emailMatch ? emailMatch[0] : null,
    phone: phoneMatch ? phoneMatch[0] : null,
    location: null,
    educations, experiences, skills, certifications,
    total_experience_years: totalYears,
    highest_education: highestEdu,
  };
}

// ------------------------------------------------------------------
// AI CV Screening / Matching
// ------------------------------------------------------------------

export const EDU_RANK = { 'SMA/SMK': 1, D3: 2, S1: 3, S2: 4, S3: 5 };

export const DEFAULT_WEIGHTS = {
  education: 0.15, experience: 0.25, technical_skills: 0.30,
  soft_skills: 0.10, leadership: 0.10, certification: 0.10,
};

function scoreEducation(candidateLevel, minLevel, ranks = EDU_RANK) {
  if (!minLevel) return [100.0, 'Tidak ada syarat pendidikan minimum.'];
  const candRank = ranks[candidateLevel] || 0;
  const minRank = ranks[minLevel] || 0;
  if (candRank >= minRank && candRank > 0) return [100.0, `Pendidikan kandidat (${candidateLevel}) memenuhi minimum (${minLevel}).`];
  if (candRank === 0) return [40.0, 'Tingkat pendidikan tidak terdeteksi jelas dari CV.'];
  return [Math.max(0.0, 100.0 - (minRank - candRank) * 25), `Pendidikan kandidat (${candidateLevel}) di bawah minimum (${minLevel}).`];
}

/** Python prints floats like 2.0 / 3 / 1.5 — mirror it so summaries read identically. */
function pyNum(n) {
  if (typeof n !== 'number') return String(n);
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

function scoreExperience(candidateYears, minYears) {
  if (minYears <= 0) return [100.0, 'Tidak ada syarat pengalaman minimum.'];
  // The server did `total_experience_years or 0`, which turns 0.0 into the
  // int 0 — so zero experience has always been printed as "0", not "0.0".
  const candStr = candidateYears === 0 ? '0' : pyNum(candidateYears);
  if (candidateYears >= minYears) {
    return [100.0, `Pengalaman kandidat (${candStr} thn) memenuhi minimum (${pyNum(minYears)} thn).`];
  }
  const ratio = minYears ? candidateYears / minYears : 1;
  return [pyRound(Math.max(0.0, ratio * 100), 1), `Pengalaman kandidat (${candStr} thn) di bawah minimum (${pyNum(minYears)} thn).`];
}

function scoreListOverlap(candidateItems, requiredItems, label) {
  if (!requiredItems.length) return [100.0, [], `Tidak ada syarat ${label} spesifik.`];
  const candLower = new Set(candidateItems.map(c => c.toLowerCase()));
  const matched = requiredItems.filter(r => candLower.has(r.toLowerCase()));
  const score = pyRound((matched.length / requiredItems.length) * 100, 1);
  return [score, matched, `${matched.length}/${requiredItems.length} ${label} yang disyaratkan ditemukan pada CV.`];
}

/**
 * candidate: {highest_education, total_experience_years, skills:[names],
 *             certifications:[names], has_leadership_experience: bool}
 * vacancy:   JobRequirement-shaped dict.
 */
export function screenCandidate(candidate, vacancy, educationRanks = null) {
  // educationRanks (optional): {level: rank} from the Knowledge Center, so extra levels such as 'D4' are ranked too.
  // Built-in levels always win, so the default behaviour (and parity with the original engine) is unchanged.
  const ranks = educationRanks ? { ...educationRanks, ...EDU_RANK } : EDU_RANK;
  const rawWeights = vacancy.criteria_weights && Object.keys(vacancy.criteria_weights).length ? vacancy.criteria_weights : DEFAULT_WEIGHTS;
  const weights = { ...DEFAULT_WEIGHTS };
  for (const [k, v] of Object.entries(rawWeights)) if (v !== null && v !== undefined) weights[k] = v;

  const candYears = candidate.total_experience_years || 0;
  const minYears = vacancy.min_experience_years || 0;
  const [eduScore, eduNote] = scoreEducation(candidate.highest_education, vacancy.min_education, ranks);
  const [expScore, expNote] = scoreExperience(candYears, minYears);
  const [techScore, techMatched, techNote] = scoreListOverlap(candidate.skills || [], vacancy.technical_skills || [], 'keahlian teknis');
  const [softScore, softMatched, softNote] = scoreListOverlap(candidate.skills || [], vacancy.soft_skills || [], 'soft skill');
  const [certScore, certMatched, certNote] = scoreListOverlap(candidate.certifications || [], vacancy.certifications_required || [], 'sertifikasi');

  let leadScore, leadNote;
  if (vacancy.leadership_required) {
    leadScore = candidate.has_leadership_experience ? 100.0 : 20.0;
    leadNote = candidate.has_leadership_experience
      ? 'Pengalaman kepemimpinan terdeteksi.'
      : 'Posisi mensyaratkan kepemimpinan namun tidak terdeteksi pada CV.';
  } else {
    leadScore = 100.0; leadNote = 'Tidak ada syarat kepemimpinan.';
  }

  const criteriaScores = {
    education: eduScore, experience: expScore, technical_skills: techScore,
    soft_skills: softScore, leadership: leadScore, certification: certScore,
  };

  let overall = 0;
  for (const k of Object.keys(criteriaScores)) overall += criteriaScores[k] * (weights[k] === undefined ? 0 : weights[k]);
  overall = pyRound(overall, 1);

  const matchedTechLower = new Set(techMatched.map(m => m.toLowerCase()));
  const missingTech = (vacancy.technical_skills || []).filter(s => !matchedTechLower.has(s.toLowerCase()));
  const requiredCerts = vacancy.certifications_required || [];
  const matchedCertsLower = new Set(certMatched.map(m => m.toLowerCase()));
  const missingCerts = requiredCerts.filter(c => !matchedCertsLower.has(c.toLowerCase()));

  const matchedCriteria = [...techMatched, ...softMatched, ...certMatched];
  const missingCriteria = [...missingTech, ...missingCerts];
  if (eduScore < 100) missingCriteria.push(`Pendidikan minimum: ${pyNone(vacancy.min_education)}`);
  if (expScore < 100) missingCriteria.push(`Pengalaman minimum: ${pyNumOrNone(vacancy.min_experience_years)} tahun`);
  if (vacancy.leadership_required && leadScore < 100) missingCriteria.push('Pengalaman kepemimpinan');

  const passing = vacancy.passing_score === undefined || vacancy.passing_score === null ? 75 : vacancy.passing_score;
  const minimum = vacancy.minimum_score === undefined || vacancy.minimum_score === null ? 60 : vacancy.minimum_score;
  let recommendation;
  if (overall >= passing) recommendation = 'STRONG_MATCH';
  else if (overall >= minimum) recommendation = 'POSSIBLE_MATCH';
  else if (overall >= 40) recommendation = 'WEAK_MATCH';
  else recommendation = 'NOT_MATCH';

  const signalsPresent = [
    !!candidate.highest_education,
    (candidate.total_experience_years || 0) > 0,
    (candidate.skills || []).length > 0,
  ].filter(Boolean).length;
  const confidence = pyRound(0.4 + 0.2 * signalsPresent, 2);

  const summary =
    `Kandidat memiliki skor keseluruhan ${pyNum(overall)} terhadap posisi ${pyNone(vacancy.position)}. ` +
    `${techNote} ${expNote} ${eduNote} ` +
    `Rekomendasi AI: ${recommendation} (bukan keputusan akhir — HR yang memutuskan).`;

  const gapAnalysis = missingCriteria.length
    ? 'Kriteria yang belum terpenuhi: ' + missingCriteria.join(', ') + '.'
    : 'Tidak ada gap signifikan terhadap kriteria yang disyaratkan.';

  return {
    overall_score: overall,
    criteria_scores: criteriaScores,
    evidence: {
      technical_skills: techNote, soft_skills: softNote, experience: expNote,
      education: eduNote, certification: certNote, leadership: leadNote,
    },
    matched_criteria: matchedCriteria,
    missing_criteria: missingCriteria,
    gap_analysis: gapAnalysis,
    summary,
    recommendation,
    confidence,
    ai_model_version: AI_MODEL_VERSION,
  };
}

function pyNone(v) { return v === null || v === undefined ? 'None' : String(v); }
function pyNumOrNone(v) { return v === null || v === undefined ? 'None' : pyNum(v); }
