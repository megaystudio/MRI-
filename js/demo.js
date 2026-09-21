/*
 * Demo data generator (port of backend/demo_data.py).
 * Creates a realistic, internally consistent dataset — candidates, vacancies,
 * screenings, HR decisions, stage assessments, talent pool entries and
 * employees — using the SAME screening engine as production. Every row is
 * flagged is_demo=true so it can be removed cleanly without touching real
 * data. Names are fictional. A fixed seed keeps the demo repeatable.
 */
import * as DB from './db.js';
import * as engine from './engine.js';
import { candidateToScoringDict } from './core.js';
import { blankEmployee } from './svc_employees.js';
import { pyRound } from './util.js';

const FIRST_NAMES = ['Budi', 'Siti', 'Andi', 'Dewi', 'Rudi', 'Rina', 'Agus', 'Sri', 'Hendra', 'Wati', 'Dedi', 'Ani', 'Bambang', 'Fitri', 'Joko', 'Nur', 'Eko', 'Yuni', 'Wawan', 'Lina', 'Fajar', 'Indah', 'Yusuf', 'Ratna', 'Anton', 'Dian', 'Hadi', 'Maya', 'Iwan', 'Tuti', 'Arief', 'Sinta', 'Dodi', 'Wulan', 'Rian', 'Erna', 'Taufik', 'Melati', 'Gunawan', 'Puspa'];
const LAST_NAMES = ['Santoso', 'Wijaya', 'Kurniawan', 'Setiawan', 'Nugroho', 'Pratama', 'Saputra', 'Susanto', 'Hidayat', 'Gunawan', 'Purnomo', 'Handoko', 'Wibowo', 'Halim', 'Kusuma', 'Suryadi', 'Firmansyah', 'Rahayu', 'Utami', 'Permata', 'Marlina', 'Lestari', 'Anggraini', 'Puspita'];

const VACANCY_TEMPLATES = [
  { position: 'Production Supervisor', department: 'Manufacturing', min_education: 'S1', min_experience_years: 3, technical_skills: ['Six Sigma', 'Production Planning', 'Quality Control'], soft_skills: ['Leadership', 'Communication'], certifications_required: ['Six Sigma Green Belt'], leadership_required: true, passing_score: 75, minimum_score: 60 },
  { position: 'Production Manager', department: 'Manufacturing', min_education: 'S1', min_experience_years: 6, technical_skills: ['Six Sigma', 'Lean Manufacturing', 'Supply Chain'], soft_skills: ['Leadership', 'Negotiation'], certifications_required: [], leadership_required: true, passing_score: 78, minimum_score: 62 },
  { position: 'Finance Staff', department: 'Finance', min_education: 'S1', min_experience_years: 1, technical_skills: ['Accounting', 'Financial Analysis', 'Excel'], soft_skills: ['Communication'], certifications_required: [], leadership_required: false, passing_score: 65, minimum_score: 50 },
  { position: 'HR Recruiter', department: 'Human Resources', min_education: 'S1', min_experience_years: 2, technical_skills: ['Recruitment', 'HRIS'], soft_skills: ['Communication', 'Negotiation'], certifications_required: [], leadership_required: false, passing_score: 65, minimum_score: 50 },
  { position: 'IT Support Specialist', department: 'IT', min_education: 'D3', min_experience_years: 1, technical_skills: ['Network Administration', 'Cybersecurity'], soft_skills: ['Problem Solving'], certifications_required: ['CCNA'], leadership_required: false, passing_score: 65, minimum_score: 50 },
  { position: 'Sales Executive', department: 'Sales', min_education: 'S1', min_experience_years: 2, technical_skills: ['Sales Forecasting', 'CRM', 'Negotiation'], soft_skills: ['Communication', 'Negotiation'], certifications_required: [], leadership_required: false, passing_score: 65, minimum_score: 50 },
  { position: 'Digital Marketing Specialist', department: 'Marketing', min_education: 'S1', min_experience_years: 2, technical_skills: ['Digital Marketing', 'SEO', 'Content Marketing'], soft_skills: ['Collaboration'], certifications_required: [], leadership_required: false, passing_score: 65, minimum_score: 50 },
  { position: 'Quality Assurance Manager', department: 'Quality', min_education: 'S1', min_experience_years: 5, technical_skills: ['Quality Assurance', 'Auditing', 'Compliance'], soft_skills: ['Leadership'], certifications_required: ['ISO 9001'], leadership_required: true, passing_score: 75, minimum_score: 60 },
];

const EDU_LEVELS_WEIGHTED = ['SMA/SMK', 'D3', 'D3', 'S1', 'S1', 'S1', 'S1', 'S1', 'S1', 'S2'];
const ALL_SKILLS = [...new Set(VACANCY_TEMPLATES.flatMap(v => [...v.technical_skills, ...v.soft_skills]))].sort();
const ALL_CERTS = ['Six Sigma Green Belt', 'Six Sigma Black Belt', 'PMP', 'ISO 9001', 'CCNA', 'K3', 'TOEFL'];
const EDU_RANK = { 'SMA/SMK': 1, D3: 2, S1: 3, S2: 4, S3: 5 };
const HR_REJECT_REASONS = ['Pengalaman belum memenuhi kebutuhan posisi', 'Keahlian teknis kurang sesuai', 'Ekspektasi gaji di luar anggaran', 'Lokasi kerja tidak sesuai preferensi kandidat'];
const HR_PASS_REASONS = ['Kriteria teknis dan pengalaman terpenuhi', 'Hasil wawancara meyakinkan', 'Rekam jejak kuat di posisi serupa'];
const HR_HOLD_REASONS = ['Menunggu konfirmasi anggaran headcount', 'Perlu wawancara tambahan dengan user'];
const HR_POOL_REASONS = ['Profil kuat, disimpan untuk kebutuhan mendatang', 'Cocok untuk posisi serupa yang akan dibuka'];

/** Small deterministic PRNG (mulberry32) so the demo is repeatable. */
function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const randint = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  const choice = (arr) => arr[Math.floor(next() * arr.length)];
  const sample = (arr, k) => {
    const pool = [...arr], out = [];
    for (let i = 0; i < k && pool.length; i++) out.push(pool.splice(Math.floor(next() * pool.length), 1)[0]);
    return out;
  };
  const choices = (arr, weights) => {
    const total = weights.reduce((s, w) => s + w, 0);
    let r = next() * total;
    for (let i = 0; i < arr.length; i++) { r -= weights[i]; if (r < 0) return arr[i]; }
    return arr[arr.length - 1];
  };
  const uniform = (lo, hi) => lo + (hi - lo) * next();
  return { random: next, randint, choice, sample, choices, uniform };
}

function randomProfile(R, target) {
  const rankToLevel = (r) => Object.keys(EDU_RANK).find(k => EDU_RANK[k] === r) || 'S1';
  const minRank = EDU_RANK[target.min_education] || 3;
  const edu = R.random() < 0.8
    ? rankToLevel(Math.min(minRank + R.choice([0, 0, 1]), 5))
    : rankToLevel(Math.max(minRank - 1, 1));
  const baseExp = target.min_experience_years || 1;
  const exp = pyRound(Math.max(0, baseExp + R.choice([-1, -0.5, 0, 0.5, 1, 2, 3])), 1);
  const required = [...new Set([...target.technical_skills, ...target.soft_skills])];
  const nHave = Math.max(0, Math.round(required.length * R.uniform(0.5, 1.0)));
  const skills = R.sample(required, Math.min(nHave, required.length));
  const extraPool = ALL_SKILLS.filter(s => !skills.includes(s));
  skills.push(...R.sample(extraPool, Math.min(R.randint(0, 2), extraPool.length)));
  const reqCerts = target.certifications_required || [];
  let certs = reqCerts.length && R.random() < 0.55 ? [...reqCerts] : [];
  if (!certs.length && R.random() < 0.2) certs = R.sample(ALL_CERTS, 1);
  const leadership = target.leadership_required ? R.random() < 0.65 : R.random() < 0.2;
  return { edu, exp, skills, certs, leadership };
}

const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

export function generateDemoData(numCandidates = 40, seed = 42) {
  const R = makeRng(seed);
  const now = new Date();
  const vacancies = VACANCY_TEMPLATES.map(t => DB.insert('job_requirements', {
    ...t, location: null, job_level: null, industry_experience: null, languages_required: [], salary_min: null, salary_max: null,
    mandatory_criteria: [], preferred_criteria: [], criteria_weights: {}, status: 'OPEN', is_demo: true, created_at: now.toISOString(),
  }));
  const stageCfg = Object.fromEntries(DB.all('stage_config').map(c => [c.stage_code, c]));
  const seq = (code) => (stageCfg[code] ? stageCfg[code].sequence : 0);
  let createdEmployees = 0;

  for (let i = 0; i < numCandidates; i++) {
    const name = `${R.choice(FIRST_NAMES)} ${R.choice(LAST_NAMES)}`;
    const target = R.choice(vacancies);
    const prof = randomProfile(R, target);
    const candidate = DB.insert('candidates', {
      name, email: `${name.toLowerCase().replace(/ /g, '.')}.demo${i}@example.com`, phone: `08${R.randint(100000000, 999999999)}`,
      location: null, total_experience_years: prof.exp, highest_education: prof.edu, availability: null,
      source: R.choice(['Job Portal', 'LinkedIn', 'Employee Referral', 'Recruitment Agency', 'Manual Upload']),
      is_internal_candidate: false, is_demo: true, created_at: now.toISOString(),
      educations: [], skills: prof.skills.map(s => ({ skill_name: s, skill_type: 'technical', evidence_text: null })),
      certifications: prof.certs.map(c => ({ name: c, issuer: null, year: null, evidence_text: null })),
      experiences: prof.leadership ? [{ company: null, position: 'Team Lead', industry: null, start_date: null, end_date: null, is_leadership: true, description: null, evidence_text: null }] : [],
    });

    const chosen = [target];
    if (R.random() < 0.3) chosen.push(R.choice(vacancies.filter(v => v.id !== target.id)));

    for (const vac of chosen) {
      const result = engine.screenCandidate(candidateToScoringDict(candidate), vac);
      const processed = addDays(now, -R.randint(0, 60));
      const screening = DB.insert('screenings', {
        candidate_id: candidate.id, vacancy_id: vac.id, processed_at: processed.toISOString(), ai_model_version: result.ai_model_version,
        overall_score: result.overall_score, criteria_scores: result.criteria_scores, evidence: result.evidence,
        matched_criteria: result.matched_criteria, missing_criteria: result.missing_criteria, gap_analysis: result.gap_analysis,
        summary: result.summary, recommendation: result.recommendation, confidence: result.confidence, hr_decision: null,
      });

      if (R.random() < 0.75) {
        let decision;
        if (result.recommendation === 'STRONG_MATCH') decision = R.choices(['PASS', 'TALENT_POOL', 'HOLD'], [70, 15, 15]);
        else if (result.recommendation === 'POSSIBLE_MATCH') decision = R.choices(['PASS', 'HOLD', 'TALENT_POOL', 'REJECT'], [35, 30, 20, 15]);
        else decision = R.choices(['REJECT', 'HOLD', 'TALENT_POOL'], [70, 15, 15]);
        const reason = { PASS: () => R.choice(HR_PASS_REASONS), REJECT: () => R.choice(HR_REJECT_REASONS), HOLD: () => R.choice(HR_HOLD_REASONS), TALENT_POOL: () => R.choice(HR_POOL_REASONS) }[decision]();
        screening.hr_decision = { decision, reason, remarks: null, reviewer: R.choice(['Siti (HR)', 'Budi (HR)', 'Rina (HR)']), review_date: addDays(processed, R.randint(1, 5)).toISOString() };
        DB.save('screenings', screening);

        if (decision === 'TALENT_POOL') {
          DB.insert('talent_pool', { candidate_id: candidate.id, status: 'ACTIVE', added_by: 'HR', added_date: now.toISOString(), source_vacancy_id: vac.id, notes: reason, last_reactivated_at: null });
        }

        if (decision === 'PASS' && R.random() < 0.7) {
          const hrScore = pyRound(R.uniform(60, 95), 1);
          DB.insert('recruitment_stages', {
            candidate_id: candidate.id, vacancy_id: vac.id, stage_code: 'HR_INTERVIEW', stage_sequence: seq('HR_INTERVIEW'),
            criteria_scores: { Communication: hrScore, Motivation: pyRound(R.uniform(60, 95), 1) }, overall_score: hrScore, evidence: {},
            reason: 'Wawancara berjalan baik', remarks: null, reviewer: 'Budi (HR)', decision: 'PASS', status: 'COMPLETED',
            event_date: addDays(processed, R.randint(6, 12)).toISOString(),
          });
          if (R.random() < 0.7) {
            const assess = pyRound(R.uniform(60, 95), 1);
            DB.insert('recruitment_stages', {
              candidate_id: candidate.id, vacancy_id: vac.id, stage_code: 'ASSESSMENT', stage_sequence: seq('ASSESSMENT'),
              criteria_scores: { 'Technical Test': assess }, overall_score: assess, evidence: {}, reason: 'Hasil tes memenuhi standar',
              remarks: null, reviewer: 'Assessor Center', decision: 'PASS', status: 'COMPLETED',
              event_date: addDays(processed, R.randint(13, 20)).toISOString(),
            });
            if (R.random() < 0.65) {
              const hireDate = addDays(processed, R.randint(21, 35));
              const hired = DB.insert('recruitment_stages', {
                candidate_id: candidate.id, vacancy_id: vac.id, stage_code: 'HIRED', stage_sequence: seq('HIRED'),
                criteria_scores: {}, overall_score: null, evidence: {}, reason: 'Kandidat hired', remarks: null,
                reviewer: 'Siti (HR)', decision: null, status: 'COMPLETED', event_date: hireDate.toISOString(),
              });
              const type = R.choices(['Permanent', 'Contract', 'Probation'], [40, 40, 20]);
              let contractEnd = null;
              if (type !== 'Permanent') contractEnd = addDays(now, R.choice([5, 6, 15, 25, 45, 55, 120, 200])).toISOString().slice(0, 10);
              DB.insert('employees', blankEmployee({
                candidate_id: candidate.id, source_vacancy_id: vac.id, hired_stage_id: hired.id,
                employee_number: `EMP-${1000 + createdEmployees}`, full_name: candidate.name, phone: candidate.phone, email: candidate.email,
                department: vac.department, position: vac.position, supervisor: R.choice(['Andi Wijaya', 'Rina Kurniawan', 'Dedi Santoso']),
                join_date: hireDate.toISOString().slice(0, 10), employment_type: type, employment_status: 'Active',
                contract_start_date: type !== 'Permanent' ? hireDate.toISOString().slice(0, 10) : null, contract_end_date: contractEnd,
                location: R.choice(['Jakarta', 'Tangerang', 'Bekasi', 'Surabaya']), education: candidate.highest_education, is_demo: true,
              }));
              createdEmployees++;
            }
          }
        }
      }
    }
  }
  return { candidates: numCandidates, vacancies: vacancies.length, employees: createdEmployees };
}

export function resetDemoData() {
  const demoCandidates = DB.filter('candidates', c => c.is_demo);
  const demoIds = new Set(demoCandidates.map(c => c.id));
  for (const cv of DB.filter('cvs', c => demoIds.has(c.candidate_id))) { DB.deleteFile(cv.id); DB.remove('cvs', cv.id); }
  for (const s of DB.filter('screenings', s => demoIds.has(s.candidate_id))) DB.remove('screenings', s.id);
  for (const p of DB.filter('talent_pool', p => demoIds.has(p.candidate_id))) DB.remove('talent_pool', p.id);
  for (const st of DB.filter('recruitment_stages', s => demoIds.has(s.candidate_id))) DB.remove('recruitment_stages', st.id);
  for (const c of demoCandidates) DB.remove('candidates', c.id);

  const demoEmployees = DB.filter('employees', e => e.is_demo);
  for (const e of demoEmployees) DB.remove('employees', e.id);

  const demoVacancies = DB.filter('job_requirements', v => v.is_demo);
  const vacIds = new Set(demoVacancies.map(v => v.id));
  // a real candidate may have been screened against a demo vacancy — remove those rows too
  for (const s of DB.filter('screenings', s => vacIds.has(s.vacancy_id))) DB.remove('screenings', s.id);
  for (const st of DB.filter('recruitment_stages', s => vacIds.has(s.vacancy_id))) DB.remove('recruitment_stages', st.id);
  for (const p of DB.filter('talent_pool', p => vacIds.has(p.source_vacancy_id))) { p.source_vacancy_id = null; DB.save('talent_pool', p); }
  for (const v of demoVacancies) DB.remove('job_requirements', v.id);

  return { candidates_deleted: demoCandidates.length, vacancies_deleted: demoVacancies.length, employees_deleted: demoEmployees.length };
}
