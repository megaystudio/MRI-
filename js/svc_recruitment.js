/*
 * Recruitment services — port of the core endpoints of backend/main.py
 * (CV intake, CV Bank, Candidate 360, Job Requirement, AI Screening,
 * Screening Center, HR decisions, Talent Pool, Recruitment stages,
 * Executive dashboard, Audit trail).
 */
import * as DB from './db.js';
import {
  route, HttpError, ilike, byNewest, requireFound, ownerName, logAudit, checkCountLimit, planLimits,
  candidateToScoringDict, vacancyToDict, candidateSummary, toFloatOrThrow,
  fileResult, XLSX_MIME, rowIsBlank, cellText,
} from './core.js';
import * as engine from './engine.js';
import { registerMasterValues, educationRanks, ensureMasterData, seedMasterNow, normKey } from './svc_master.js';
import { buildMultiSheetTemplate, readWorkbookRows } from './reports.js';
import { extractTextFromBuffer } from './extract.js';
import { sha256Hex, pyRound, pyFloatStr, nowIso, fileExt, daysBetween, contractDaysRemaining } from './util.js';

export const MAX_UPLOAD_SIZE_BYTES = 8 * 1024 * 1024;
const MB = 1024 * 1024;

// ------------------------------------------------------------ CV intake ----

async function prepareUpload(file) {
  const ext = fileExt(file.name);
  if (!['.pdf', '.docx', '.txt'].includes(ext)) throw new HttpError(400, 'Format harus PDF, DOCX, atau TXT.');
  if (file.size > MAX_UPLOAD_SIZE_BYTES) throw new HttpError(400, `Ukuran file melebihi batas ${MAX_UPLOAD_SIZE_BYTES / MB}MB.`);
  const buf = await file.arrayBuffer();
  if (buf.byteLength === 0) throw new HttpError(400, 'File kosong (0 byte) — pastikan file CV valid sebelum diunggah.');
  const fileHash = await sha256Hex(buf);

  let text;
  try {
    text = await extractTextFromBuffer(buf, ext);
  } catch (exc) {
    throw new HttpError(400, `Gagal membaca isi file — kemungkinan file rusak atau bukan ${ext} yang valid. Detail: ${exc && exc.message ? exc.message : exc}`);
  }
  if (!text || !text.trim()) {
    throw new HttpError(400,
      'Tidak ada teks yang dapat diekstrak dari file ini. Kemungkinan file adalah hasil ' +
      'scan/gambar tanpa lapisan teks (OCR belum didukung) — coba unggah versi CV yang berbasis teks.');
  }
  return { ext, buf, fileHash, text, name: file.name, size: buf.byteLength };
}

/** All failure-prone work is done in prepareUpload(); this part only mutates memory. */
async function applyUpload(prep, source) {
  const actor = ownerName();
  const profile = engine.extractCandidateProfile(prep.text);

  let existing = null, duplicateSignal = null;
  const cvWithHash = DB.find('cvs', c => c.file_hash === prep.fileHash);
  if (cvWithHash) { existing = DB.get('candidates', cvWithHash.candidate_id) || null; if (existing) duplicateSignal = 'file_hash'; }
  if (!existing && !cvWithHash && profile.email) {
    existing = DB.find('candidates', c => c.email === profile.email) || null;
    if (existing) duplicateSignal = 'email';
  }
  if (!existing && profile.phone) {
    existing = DB.find('candidates', c => c.phone === profile.phone) || null;
    if (existing) duplicateSignal = 'phone';
  }
  const isDuplicate = existing !== null;

  let candidate;
  if (existing) {
    candidate = existing;
    const before = { name: candidate.name, highest_education: candidate.highest_education, total_experience_years: candidate.total_experience_years };
    candidate.total_experience_years = Math.max(candidate.total_experience_years || 0, profile.total_experience_years);
    if (profile.highest_education && !candidate.highest_education) candidate.highest_education = profile.highest_education;
    if (profile.name && !candidate.name) candidate.name = profile.name;
    DB.save('candidates', candidate);
    logAudit('Candidate', candidate.id, 'CANDIDATE_UPDATED', actor, `Enriched from re-uploaded CV (matched by ${duplicateSignal})`, { before });
  } else {
    const { limits } = await planLimits();
    const realCount = DB.filter('candidates', c => !c.is_demo).length;
    if (limits.max_candidates !== null && realCount >= limits.max_candidates) {
      throw new HttpError(402, limits.label === 'Demo'
        ? `Batas paket Demo tercapai (${limits.max_candidates} kandidat nyata). Masukkan kode aktivasi Premium/VIP di menu Paket & Upgrade untuk membuka batas ini.`
        : `Batas paket ${limits.label} tercapai (${limits.max_candidates} kandidat nyata). Upgrade ke VIP untuk kapasitas tanpa batas.`);
    }
    candidate = DB.insert('candidates', {
      name: profile.name, email: profile.email, phone: profile.phone, location: null,
      total_experience_years: profile.total_experience_years, highest_education: profile.highest_education,
      availability: null, source, is_internal_candidate: false, is_demo: false, created_at: nowIso(),
      educations: profile.educations, experiences: profile.experiences,
      skills: profile.skills, certifications: profile.certifications,
    });
    logAudit('Candidate', candidate.id, 'CANDIDATE_CREATED', actor, 'New CV uploaded', { filename: prep.name });
  }

  const cv = DB.insert('cvs', {
    candidate_id: candidate.id, filename: prep.name, has_file: true, file_hash: prep.fileHash,
    file_size_bytes: prep.size, raw_text: prep.text, source, is_duplicate_of: null, uploaded_at: nowIso(),
  });
  DB.putFile(cv.id, prep.name, ({ '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.txt': 'text/plain' })[prep.ext], prep.buf);
  logAudit('CV', cv.id, 'CV_INTAKE', actor, 'CV file stored', { duplicate_detected: isDuplicate, duplicate_signal: duplicateSignal, filename: prep.name });

  return {
    candidate: candidateSummary(candidate),
    duplicate_detected: isDuplicate,
    duplicate_signal: duplicateSignal,
    upload_count_for_candidate: DB.filter('cvs', c => c.candidate_id === candidate.id).length,
    extraction: {
      name_detected: profile.name !== null, email_detected: profile.email !== null, phone_detected: profile.phone !== null,
      educations: profile.educations.map(e => e.evidence_text).filter(Boolean).map(t => t.trim()),
      experiences_found: profile.experiences.length,
      skills_found: profile.skills.map(s => s.skill_name),
      certifications_found: profile.certifications.map(c => c.name),
    },
  };
}

route('POST', '/api/cv/upload', async ({ body }) => {
  const file = body.get('file');
  if (!file) throw new HttpError(400, 'File tidak ditemukan pada permintaan.');
  const prep = await prepareUpload(file);
  return applyUpload(prep, body.get('source') || 'Manual Upload');
});

// -------------------------------------------------------- batch upload -----

route('POST', '/api/batch-upload/start', async ({ query }) => {
  const total = parseInt(query.total_files, 10);
  if (!(total > 0)) throw new HttpError(400, 'total_files harus lebih dari 0.');
  const job = DB.insert('batch_upload_jobs', {
    uploaded_by: ownerName(), source: query.source || 'Manual Upload', upload_date: nowIso(),
    total_files: total, processed: 0, failed: 0, duplicate: 0, new_candidates: 0,
    status: 'RUNNING', duration_seconds: null, files: [],
  });
  logAudit('BatchUploadJob', job.id, 'BATCH_STARTED', ownerName(), `${total} file(s) queued`);
  return { batch_id: job.id };
});

route('POST', '/api/batch-upload/:id/file', async ({ params, body }) => {
  const job = requireFound(DB.get('batch_upload_jobs', params.id), 'Batch tidak ditemukan.');
  const file = body.get('file');
  const row = { filename: file.name, status: null, reason: null, candidate_id: null, candidate_name: null, processed_at: nowIso() };
  let outcome;
  try {
    const prep = await prepareUpload(file);           // may throw HttpError — nothing has been written yet
    const result = await applyUpload(prep, job.source);
    row.candidate_id = result.candidate.id;
    row.candidate_name = result.candidate.name;
    if (result.duplicate_detected) {
      row.status = 'DUPLICATE'; row.reason = `Matched existing candidate via ${result.duplicate_signal}`; job.duplicate += 1;
    } else { row.status = 'SUCCESS'; job.new_candidates += 1; }
    job.processed += 1;
    outcome = result;
  } catch (exc) {
    row.status = 'FAILED';
    row.reason = exc instanceof HttpError ? exc.detail : `Unexpected error: ${exc && exc.message ? exc.message : exc}`;
    job.failed += 1; job.processed += 1;
    outcome = { error: row.reason };
  }
  job.files.push(row);
  DB.save('batch_upload_jobs', job);
  return { batch_id: job.id, filename: file.name, status: row.status, reason: row.reason, progress: { processed: job.processed, total: job.total_files }, result: outcome };
});

route('POST', '/api/batch-upload/:id/finish', async ({ params, query }) => {
  const job = requireFound(DB.get('batch_upload_jobs', params.id), 'Batch tidak ditemukan.');
  job.status = 'COMPLETED';
  job.duration_seconds = parseFloat(query.duration_seconds || 0);
  DB.save('batch_upload_jobs', job);
  logAudit('BatchUploadJob', job.id, 'BATCH_COMPLETED', job.uploaded_by,
    `${job.processed}/${job.total_files} processed, ${job.new_candidates} new, ${job.duplicate} duplicate, ${job.failed} failed`);
  return { status: 'ok' };
});

route('GET', '/api/batch-upload/:id', async ({ params }) => {
  const job = requireFound(DB.get('batch_upload_jobs', params.id), 'Batch tidak ditemukan.');
  return {
    batch_id: job.id, uploaded_by: job.uploaded_by, source: job.source, upload_date: job.upload_date,
    total_files: job.total_files, processed: job.processed, failed: job.failed, duplicate: job.duplicate,
    new_candidates: job.new_candidates, status: job.status, duration_seconds: job.duration_seconds,
    files: job.files.map(f => ({ filename: f.filename, status: f.status, reason: f.reason, candidate_id: f.candidate_id, candidate_name: f.candidate_name })),
  };
});

route('GET', '/api/batch-upload', async () => DB.all('batch_upload_jobs')
  .sort((a, b) => byNewest(a, b, 'upload_date')).slice(0, 50)
  .map(j => ({
    batch_id: j.id, upload_date: j.upload_date, uploaded_by: j.uploaded_by, total_files: j.total_files,
    processed: j.processed, failed: j.failed, duplicate: j.duplicate, new_candidates: j.new_candidates, status: j.status,
  })));

// ------------------------------------------------------------ CV bank ------

route('GET', '/api/candidates', async ({ query }) => {
  let rows = DB.all('candidates');
  if (query.q) rows = rows.filter(c => ilike(c.name, query.q));
  if (query.min_experience !== undefined && query.min_experience !== '') {
    const m = parseFloat(query.min_experience);
    rows = rows.filter(c => (c.total_experience_years || 0) >= m);
  }
  if (query.education) rows = rows.filter(c => c.highest_education === query.education);
  if (query.source) rows = rows.filter(c => c.source === query.source);
  rows.sort((a, b) => byNewest(a, b));
  if (query.skill) rows = rows.filter(c => c.skills.map(s => s.skill_name.toLowerCase()).includes(query.skill.toLowerCase()));
  // include=extras (used by the CV Bank screen): CV files + screening results per candidate. Off by default so the base shape is unchanged.
  if (query.include === 'extras') {
    return rows.map(c => {
      const cvs = cvList(c.id);
      const scr = DB.filter('screenings', s => s.candidate_id === c.id).sort((a, b) => byNewest(a, b, 'processed_at'));
      return {
        ...candidateSummary(c),
        cv_count: cvs.length, latest_cv_id: cvs.length ? cvs[0].id : null, latest_cv_filename: cvs.length ? cvs[0].filename : null,
        screenings: scr.map(s => ({
          id: s.id, vacancy_id: s.vacancy_id, vacancy_position: DB.get('job_requirements', s.vacancy_id) ? DB.get('job_requirements', s.vacancy_id).position : null,
          overall_score: s.overall_score, recommendation: s.recommendation, hr_decision: s.hr_decision ? s.hr_decision.decision : null,
        })),
      };
    });
  }
  return rows.map(candidateSummary);
});

/** CV files of one candidate, newest first. */
function cvList(candidateId) {
  return DB.filter('cvs', v => v.candidate_id === candidateId).sort((a, b) => byNewest(a, b, 'uploaded_at'))
    .map(v => ({ id: v.id, filename: v.filename, uploaded_at: v.uploaded_at, source: v.source, has_file: !!v.has_file, file_size_bytes: v.file_size_bytes ?? null }));
}

route('GET', '/api/candidates/:id/cv-list', async ({ params }) => {
  const c = requireFound(DB.get('candidates', params.id), 'Kandidat tidak ditemukan.');
  return { candidate: { id: c.id, name: c.name, email: c.email }, cvs: cvList(c.id) };
}, { tx: false });

/** Extracted text + metadata of one CV (the viewer shows this for DOCX/TXT, and as a fallback for PDF). */
route('GET', '/api/cv/:id/text', async ({ params }) => {
  const cv = requireFound(DB.get('cvs', params.id), 'File CV tidak ditemukan.');
  const c = DB.get('candidates', cv.candidate_id);
  const f = await DB.getFile(cv.id);
  return {
    id: cv.id, candidate_id: cv.candidate_id, candidate_name: c ? c.name : null, filename: cv.filename,
    uploaded_at: cv.uploaded_at, source: cv.source, raw_text: cv.raw_text || '', has_file: !!f,
    file_type: (f && f.type) || null,
  };
}, { tx: false });

route('GET', '/api/cv/:id/download', async ({ params }) => {
  const cv = requireFound(DB.get('cvs', params.id), 'File CV tidak ditemukan.');
  const f = await DB.getFile(cv.id);
  if (!f) throw new HttpError(404, 'File fisik CV tidak ditemukan di penyimpanan (mungkin tidak ikut di-backup atau sudah dihapus).');
  return { __file: true, blob: new Blob([f.data], { type: f.type }), filename: cv.filename, type: f.type };
}, { tx: false });

route('GET', '/api/candidates/:id', async ({ params }) => {
  const c = requireFound(DB.get('candidates', params.id), 'Kandidat tidak ditemukan.');
  const vac = (id) => DB.get('job_requirements', id);
  const screenings = DB.filter('screenings', s => s.candidate_id === c.id).sort((a, b) => byNewest(a, b, 'processed_at'));
  const stages = DB.filter('recruitment_stages', s => s.candidate_id === c.id).sort((a, b) => byNewest(a, b, 'event_date'));
  const pool = DB.filter('talent_pool', p => p.candidate_id === c.id);
  return {
    profile: candidateSummary(c),
    educations: c.educations.map(e => ({ level: e.level, major: e.major, institution: e.institution, graduation_year: e.graduation_year, evidence_text: e.evidence_text })),
    experiences: c.experiences.map(e => ({ company: e.company, position: e.position, start_date: e.start_date, end_date: e.end_date, is_leadership: e.is_leadership, evidence_text: e.evidence_text })),
    certifications: c.certifications.map(x => ({ name: x.name, year: x.year, evidence_text: x.evidence_text })),
    cvs: DB.filter('cvs', v => v.candidate_id === c.id).map(v => ({ id: v.id, filename: v.filename, uploaded_at: v.uploaded_at, source: v.source })),
    screening_history: screenings.map(s => ({
      id: s.id, vacancy_id: s.vacancy_id, vacancy_position: vac(s.vacancy_id) ? vac(s.vacancy_id).position : null,
      overall_score: s.overall_score, recommendation: s.recommendation, processed_at: s.processed_at,
      hr_decision: s.hr_decision ? { decision: s.hr_decision.decision, reason: s.hr_decision.reason, reviewer: s.hr_decision.reviewer, remarks: s.hr_decision.remarks, review_date: s.hr_decision.review_date } : null,
    })),
    recruitment_journey: stages.map(st => ({
      stage_code: st.stage_code, status: st.status, event_date: st.event_date,
      vacancy_position: vac(st.vacancy_id) ? vac(st.vacancy_id).position : null,
      overall_score: st.overall_score, criteria_scores: st.criteria_scores, decision: st.decision, reason: st.reason, reviewer: st.reviewer,
    })),
    talent_pool_status: pool.map(p => ({ status: p.status, added_date: p.added_date, notes: p.notes })),
  };
});

// ------------------------------------------------- Job Requirement ---------

export const VACANCY_STATUSES = ['OPEN', 'ON_HOLD', 'CLOSED'];
const VACANCY_EDITABLE = [
  'position', 'department', 'job_level', 'location', 'min_education', 'min_experience_years', 'industry_experience',
  'technical_skills', 'soft_skills', 'leadership_required', 'certifications_required', 'languages_required',
  'salary_min', 'salary_max', 'mandatory_criteria', 'preferred_criteria', 'criteria_weights', 'minimum_score', 'passing_score',
];

/** Validation + normalisation shared by create (POST), edit (PUT) and Excel import. Error messages are the original ones. */
function buildVacancyFields(body) {
  if (!body.position || !String(body.position).trim()) throw new HttpError(400, 'Nama posisi tidak boleh kosong.');
  const minExp = body.min_experience_years === undefined || body.min_experience_years === null ? 0 : toFloatOrThrow(body.min_experience_years, 'Pengalaman minimum harus berupa angka.');
  if (minExp < 0) throw new HttpError(400, 'Pengalaman minimum tidak boleh negatif.');
  const minimum = body.minimum_score === undefined ? 60 : toFloatOrThrow(body.minimum_score, 'Minimum score harus berupa angka.');
  const passing = body.passing_score === undefined ? 75 : toFloatOrThrow(body.passing_score, 'Passing score harus berupa angka.');
  if (passing < minimum) throw new HttpError(400, 'Passing score tidak boleh lebih kecil dari minimum score.');
  const weights = body.criteria_weights || {};
  if (Object.keys(weights).length) {
    const total = Object.values(weights).reduce((s, x) => s + x, 0);
    if (Math.abs(total - 1.0) > 0.01) throw new HttpError(400, `Total bobot kriteria harus 100% (1.0). Saat ini: ${pyFloatStr(pyRound(total * 100, 1))}%.`);
  }
  return {
    position: body.position, department: body.department ?? null, job_level: body.job_level ?? null,
    location: body.location ?? null, min_education: body.min_education ?? null, min_experience_years: minExp,
    industry_experience: body.industry_experience ?? null,
    technical_skills: body.technical_skills || [], soft_skills: body.soft_skills || [],
    leadership_required: !!body.leadership_required, certifications_required: body.certifications_required || [],
    languages_required: body.languages_required || [], salary_min: body.salary_min ?? null, salary_max: body.salary_max ?? null,
    mandatory_criteria: body.mandatory_criteria || [], preferred_criteria: body.preferred_criteria || [],
    criteria_weights: weights, minimum_score: minimum, passing_score: passing,
  };
}

/** PUT/import only: trims text, blank text => null, cleans list items. */
function tidyVacancyFields(f) {
  const t = (x) => { const v = x === null || x === undefined ? '' : String(x).trim().replace(/\s+/g, ' '); return v || null; };
  const list = (a) => [...new Set((a || []).map(x => String(x).trim().replace(/\s+/g, ' ')).filter(Boolean))];
  return {
    ...f, position: String(f.position).trim().replace(/\s+/g, ' '),
    department: t(f.department), job_level: t(f.job_level), location: t(f.location), min_education: t(f.min_education),
    industry_experience: t(f.industry_experience),
    technical_skills: list(f.technical_skills), soft_skills: list(f.soft_skills), certifications_required: list(f.certifications_required),
    languages_required: list(f.languages_required), mandatory_criteria: list(f.mandatory_criteria), preferred_criteria: list(f.preferred_criteria),
  };
}

/** Keeps the Knowledge Center master lists complete: adds only values that are missing. Returns {category: [added…]}. */
function registerVacancyMaster(v) {
  const added = {};
  const add = (cat, val) => { const r = registerMasterValues(cat, val); if (r.length) added[cat] = (added[cat] || []).concat(r); };
  add('positions', v.position); add('departments', v.department); add('job-levels', v.job_level); add('locations', v.location);
  add('hard-skills', v.technical_skills); add('soft-skills', v.soft_skills); add('certifications', v.certifications_required);
  return added;
}

function vacancyDependents(id) {
  return {
    screenings: DB.filter('screenings', s => s.vacancy_id === id).length,
    stages: DB.filter('recruitment_stages', s => s.vacancy_id === id).length,
    talent_pool: DB.filter('talent_pool', p => p.source_vacancy_id === id).length,
    employees: DB.filter('employees', e => e.source_vacancy_id === id).length,
  };
}

function vacancyFull(v) {
  const out = { id: v.id, status: v.status, is_demo: !!v.is_demo, created_at: v.created_at, updated_at: v.updated_at || null };
  for (const k of VACANCY_EDITABLE) out[k] = v[k] ?? (Array.isArray(DEFAULT_LISTS[k]) ? [] : null);
  out.criteria_weights = v.criteria_weights || {};
  out.usage = vacancyDependents(v.id);
  return out;
}
const DEFAULT_LISTS = { technical_skills: [], soft_skills: [], certifications_required: [], languages_required: [], mandatory_criteria: [], preferred_criteria: [] };

route('POST', '/api/vacancies', async ({ body, query }) => {
  const fields = buildVacancyFields(body);
  await checkCountLimit(DB.filter('job_requirements', v => !v.is_demo).length, 'max_job_requirements', 'jumlah lowongan');

  const v = DB.insert('job_requirements', { ...fields, status: body.status || 'OPEN', is_demo: false, created_at: nowIso() });
  registerVacancyMaster(v);
  let why = 'New vacancy created';
  const fromId = parseInt(query.from_knowledge_id, 10);
  if (fromId) {
    const t = DB.get('knowledge_job_criteria', fromId);
    if (t) { t.times_used = (t.times_used || 0) + 1; DB.save('knowledge_job_criteria', t); why = `New vacancy created from Knowledge Center template #${fromId} (${t.title})`; }
  }
  logAudit('JobRequirement', v.id, 'CREATE', ownerName(), why);
  return { id: v.id, position: v.position };
});

route('GET', '/api/vacancies', async ({ query }) => {
  let rows = DB.all('job_requirements');
  if (query.status) rows = rows.filter(v => v.status === query.status);
  const stats = query.include === 'stats';
  return rows.sort((a, b) => byNewest(a, b)).map(v => ({
    id: v.id, position: v.position, department: v.department, job_level: v.job_level, location: v.location,
    status: v.status, min_education: v.min_education, min_experience_years: v.min_experience_years,
    technical_skills: v.technical_skills, passing_score: v.passing_score, minimum_score: v.minimum_score, created_at: v.created_at,
    ...(stats ? {
      soft_skills: v.soft_skills || [], certifications_required: v.certifications_required || [], leadership_required: !!v.leadership_required,
      mandatory_count: (v.mandatory_criteria || []).length, is_demo: !!v.is_demo,
      screening_count: DB.filter('screenings', s => s.vacancy_id === v.id).length,
    } : {}),
  }));
});

/** Import template registered BEFORE the :id routes purely for readability (patterns never overlap: ids are digits). */
const VACANCY_IMPORT_HEADERS = [
  'Position', 'Department', 'Job Level', 'Location', 'Min Education', 'Min Experience Years',
  'Technical Skills (comma separated)', 'Soft Skills (comma separated)', 'Certifications Required (comma separated)',
  'Leadership Required (Yes/No)', 'Mandatory Criteria (comma separated)', 'Passing Score', 'Minimum Score', 'Status',
];
const splitList = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

route('GET', '/api/vacancies/import-template.xlsx', async () => {
  await ensureMasterData();
  const ms = (cat) => DB.filter('knowledge_master', m => m.category === cat && m.active).sort((a, b) => a.name.localeCompare(b.name)).map(m => m.name);
  const eduNames = DB.filter('knowledge_master', m => m.category === 'education-levels' && m.active).sort((a, b) => (a.value ?? 0) - (b.value ?? 0)).map(m => m.name);
  const example = [
    'Production Supervisor', 'Manufacturing', 'Supervisor', 'Tangerang', 'S1', 3,
    'Six Sigma, Production Planning, Quality Control', 'Leadership, Communication', 'Six Sigma Green Belt',
    'Yes', 'Usia maksimal 35 tahun, Bersedia kerja shift', 75, 60, 'OPEN',
  ];
  const notes = [
    'PETUNJUK IMPORT JOB REQUIREMENT — MRI', '',
    '1. Jangan mengubah nama sheet maupun urutan/nama kolom pada baris pertama.',
    '2. Baris kedua adalah CONTOH — hapus atau timpa sebelum import. Satu baris = satu Job Requirement.',
    '3. Kolom wajib: Position.',
    `4. Min Education harus salah satu dari: ${eduNames.join(', ')} (kosongkan bila tidak ada syarat).`,
    '5. Kolom bertanda "comma separated" diisi beberapa nilai dipisahkan koma, mis. "Six Sigma, SAP".',
    '6. Leadership Required: Yes / No. Status: OPEN, ON_HOLD, atau CLOSED (kosong = OPEN). Passing Score default 75, Minimum Score default 60.',
    '7. Mandatory Criteria adalah catatan untuk ditinjau HR secara manual (mis. usia, domisili) — TIDAK dinilai otomatis oleh AI Screening.',
    '8. PERHATIAN: kriteria berbasis atribut yang dilindungi hukum (agama, ras, suku, jenis kelamin tanpa alasan pekerjaan yang sah) berisiko melanggar UU Ketenagakerjaan Pasal 5-6.',
    '9. Sheet "Referensi Knowledge Center" berisi nilai yang sudah ada di Knowledge Center. Nilai baru (posisi, departemen, skill, dst.) tetap bisa diimport dan otomatis ditambahkan ke Knowledge Center.',
    '10. Baris dengan Position + Department + Location yang sama dengan Job Requirement yang sudah ada ditandai Duplicate dan dilewati.',
  ];
  const bytes = await buildMultiSheetTemplate(
    [{ title: 'Job Requirements', headers: VACANCY_IMPORT_HEADERS, example, validations: [{ col: 5, list: eduNames }, { col: 10, list: ['Yes', 'No'] }, { col: 14, list: VACANCY_STATUSES }] }],
    notes,
    { title: 'Referensi Knowledge Center', columns: [
      { header: 'Posisi', values: ms('positions') }, { header: 'Departemen', values: ms('departments') }, { header: 'Job Level', values: ms('job-levels') },
      { header: 'Lokasi', values: ms('locations') }, { header: 'Level Pendidikan', values: eduNames }, { header: 'Hard Skill', values: ms('hard-skills') },
      { header: 'Soft Skill', values: ms('soft-skills') }, { header: 'Sertifikasi', values: ms('certifications') },
    ] },
  );
  return fileResult(bytes, 'MRI_JobRequirement_Import_Template.xlsx', XLSX_MIME);
}, { tx: false });

route('POST', '/api/vacancies/import', async ({ body }) => {
  seedMasterNow();   // already inside a transaction (POST) — must not open another one
  const file = body.get('file');
  if (!file || (!file.name.toLowerCase().endsWith('.xlsx') && !file.name.toLowerCase().endsWith('.xlsm'))) throw new HttpError(400, 'File harus berformat .xlsx');
  const buf = await file.arrayBuffer();
  if (buf.byteLength === 0) throw new HttpError(400, 'File kosong.');
  let rows;
  try { rows = await readWorkbookRows(buf, 'Job Requirements', VACANCY_IMPORT_HEADERS.length); } catch (exc) { throw new HttpError(400, `Gagal membaca file Excel: ${exc.message || exc}`); }

  const eduByKey = new Map(DB.filter('knowledge_master', m => m.category === 'education-levels' && m.active).map(m => [normKey(m.name), m.name]));
  const { limits } = await planLimits();
  let realCount = DB.filter('job_requirements', v => !v.is_demo).length;
  const sig = (v) => [v.position, v.department, v.location].map(normKey).join('|');
  const existing = new Set(DB.all('job_requirements').map(sig));

  let total = 0, valid = 0, dup = 0, invalid = 0;
  const errors = [], imported = [], masterAdded = {};
  const bad = (row, reason) => { invalid++; errors.push({ row, status: 'INVALID', reason }); };
  const num = (raw, dflt) => (raw === null || raw === undefined || String(raw).trim() === '' ? dflt : Number(String(raw).trim().replace(',', '.')));

  for (const { row: idx, cells } of rows) {
    if (rowIsBlank(cells)) continue;
    total++;
    const position = cellText(cells, 0);
    if (!position) { bad(idx, 'Position wajib diisi'); continue; }

    const eduRaw = cellText(cells, 4);
    let minEdu = null;
    if (eduRaw) {
      minEdu = eduByKey.get(normKey(eduRaw)) || null;
      if (!minEdu) { bad(idx, `Min Education '${eduRaw}' tidak dikenal. Pilihan: ${[...eduByKey.values()].join(', ')}`); continue; }
    }
    const minExp = num(cells[5], 0), passing = num(cells[11], 75), minimum = num(cells[12], 60);
    if (![minExp, passing, minimum].every(Number.isFinite)) { bad(idx, 'Min Experience Years / Passing Score / Minimum Score harus angka'); continue; }
    if (minExp < 0) { bad(idx, 'Min Experience Years tidak boleh negatif'); continue; }
    if (passing < minimum) { bad(idx, 'Passing Score tidak boleh lebih kecil dari Minimum Score'); continue; }

    const leadRaw = normKey(cellText(cells, 9));
    let leadership = false;
    if (['yes', 'y', 'ya', 'true', '1', 'wajib'].includes(leadRaw)) leadership = true;
    else if (!['', 'no', 'n', 'tidak', 'false', '0'].includes(leadRaw)) { bad(idx, `Leadership Required '${cellText(cells, 9)}' harus Yes atau No`); continue; }

    const statusRaw = cellText(cells, 13).toUpperCase().replace(/[\s-]+/g, '_');
    const status = statusRaw || 'OPEN';
    if (!VACANCY_STATUSES.includes(status)) { bad(idx, `Status '${cellText(cells, 13)}' harus salah satu dari ${VACANCY_STATUSES.join(', ')}`); continue; }

    const fields = tidyVacancyFields({
      position, department: cellText(cells, 1), job_level: cellText(cells, 2), location: cellText(cells, 3), min_education: minEdu,
      min_experience_years: minExp, technical_skills: splitList(cellText(cells, 6)), soft_skills: splitList(cellText(cells, 7)),
      certifications_required: splitList(cellText(cells, 8)), leadership_required: leadership, mandatory_criteria: splitList(cellText(cells, 10)),
      passing_score: passing, minimum_score: minimum, criteria_weights: {},
    });
    if (existing.has(sig(fields))) { dup++; errors.push({ row: idx, status: 'DUPLICATE', reason: `Job Requirement '${fields.position}' (departemen/lokasi sama) sudah ada` }); continue; }
    if (limits.max_job_requirements !== null && realCount >= limits.max_job_requirements) {
      bad(idx, `Batas jumlah lowongan paket ${limits.label} tercapai (${limits.max_job_requirements}). Upgrade ke Premium/VIP.`); continue;
    }
    const v = DB.insert('job_requirements', { ...buildVacancyFields(fields), status, is_demo: false, created_at: nowIso() });
    for (const [cat, names] of Object.entries(registerVacancyMaster(v))) masterAdded[cat] = (masterAdded[cat] || []).concat(names);
    existing.add(sig(fields)); realCount++;
    valid++; imported.push({ row: idx, id: v.id, position: v.position });
  }
  logAudit('JobRequirement', 0, 'EXCEL_IMPORT', ownerName(), `${valid} imported, ${dup} duplicate, ${invalid} invalid`, { filename: file.name });
  return {
    total_rows: total, valid, duplicate: dup, invalid, imported_count: imported.length, errors, imported,
    master_added: masterAdded, master_added_count: Object.values(masterAdded).reduce((n, a) => n + a.length, 0),
  };
});

route('GET', '/api/vacancies/:id', async ({ params }) => {
  const v = requireFound(DB.get('job_requirements', params.id), 'Lowongan tidak ditemukan.');
  return { ...vacancyToDict(v), id: v.id, department: v.department, status: v.status };
});

/** Full record for the Review / Edit screens (the base endpoint above keeps its original, smaller shape). */
route('GET', '/api/vacancies/:id/detail', async ({ params }) => {
  return vacancyFull(requireFound(DB.get('job_requirements', params.id), 'Lowongan tidak ditemukan.'));
});

route('GET', '/api/vacancies/:id/dependents', async ({ params }) => {
  const v = requireFound(DB.get('job_requirements', params.id), 'Lowongan tidak ditemukan.');
  return { id: v.id, position: v.position, ...vacancyDependents(v.id) };
});

route('PUT', '/api/vacancies/:id', async ({ params, body }) => {
  const v = requireFound(DB.get('job_requirements', params.id), 'Lowongan tidak ditemukan.');
  const current = {}; for (const k of VACANCY_EDITABLE) current[k] = v[k];
  const merged = { ...current, ...Object.fromEntries(Object.entries(body || {}).filter(([k]) => VACANCY_EDITABLE.includes(k))) };
  const fields = tidyVacancyFields(buildVacancyFields(merged));
  const status = body && body.status !== undefined ? body.status : v.status;
  if (!VACANCY_STATUSES.includes(status)) throw new HttpError(400, `Status harus salah satu dari ${VACANCY_STATUSES.join(', ')}.`);

  const beforeScoring = JSON.stringify(vacancyToDict(v));
  const changed = VACANCY_EDITABLE.filter(k => JSON.stringify(v[k] ?? null) !== JSON.stringify(fields[k] ?? null));
  if (status !== v.status) changed.push('status');
  Object.assign(v, fields, { status, updated_at: nowIso() });
  DB.save('job_requirements', v);
  registerVacancyMaster(v);
  const scoringChanged = JSON.stringify(vacancyToDict(v)) !== beforeScoring;
  logAudit('JobRequirement', v.id, 'UPDATE', ownerName(), changed.length ? `Diubah: ${changed.join(', ')}` : 'Disimpan tanpa perubahan', { changed_fields: changed });
  return { status: 'ok', id: v.id, position: v.position, changed_fields: changed, scoring_changed: scoringChanged, screenings_affected: scoringChanged ? vacancyDependents(v.id).screenings : 0 };
});

route('DELETE', '/api/vacancies/:id', async ({ params, query }) => {
  const v = requireFound(DB.get('job_requirements', params.id), 'Lowongan tidak ditemukan.');
  const dep = vacancyDependents(v.id);
  if ((dep.screenings || dep.stages) && query.cascade !== '1') {
    throw new HttpError(409, `Job Requirement '${v.position}' sudah dipakai: ${dep.screenings} hasil screening dan ${dep.stages} catatan tahapan rekrutmen. Konfirmasi penghapusan beserta data terkait.`);
  }
  const stageIds = new Set();
  for (const s of DB.filter('screenings', x => x.vacancy_id === v.id)) DB.remove('screenings', s.id);
  for (const st of DB.filter('recruitment_stages', x => x.vacancy_id === v.id)) { stageIds.add(st.id); DB.remove('recruitment_stages', st.id); }
  for (const p of DB.filter('talent_pool', x => x.source_vacancy_id === v.id)) { p.source_vacancy_id = null; DB.save('talent_pool', p); }
  for (const e of DB.filter('employees', x => x.source_vacancy_id === v.id)) {
    e.source_vacancy_id = null; if (stageIds.has(e.hired_stage_id)) e.hired_stage_id = null; DB.save('employees', e);
  }
  DB.remove('job_requirements', v.id);
  logAudit('JobRequirement', v.id, 'DELETE', ownerName(), `Job Requirement '${v.position}' dihapus`,
    { screenings_deleted: dep.screenings, stages_deleted: dep.stages, talent_pool_unlinked: dep.talent_pool, employees_unlinked: dep.employees });
  return { status: 'ok', deleted: { screenings: dep.screenings, stages: dep.stages }, unlinked: { talent_pool: dep.talent_pool, employees: dep.employees } };
});

/** Re-computes every screening of a vacancy against its CURRENT requirement (HR decisions are kept). */
route('POST', '/api/vacancies/:id/rescreen', async ({ params }) => {
  const v = requireFound(DB.get('job_requirements', params.id), 'Lowongan tidak ditemukan.');
  let n = 0, changed = 0;
  for (const s of DB.filter('screenings', x => x.vacancy_id === v.id)) {
    const cand = DB.get('candidates', s.candidate_id);
    if (!cand) continue;
    const r = engine.screenCandidate(candidateToScoringDict(cand), vacancyToDict(v), educationRanks());
    if (r.overall_score !== s.overall_score || r.recommendation !== s.recommendation) changed++;
    Object.assign(s, {
      processed_at: nowIso(), ai_model_version: r.ai_model_version, overall_score: r.overall_score, criteria_scores: r.criteria_scores,
      evidence: r.evidence, matched_criteria: r.matched_criteria, missing_criteria: r.missing_criteria, gap_analysis: r.gap_analysis,
      summary: r.summary, recommendation: r.recommendation, confidence: r.confidence, snapshot: buildSnapshot(cand, v),
    });
    DB.save('screenings', s); n++;
  }
  logAudit('JobRequirement', v.id, 'RESCREEN', ownerName(), `${n} screening dihitung ulang terhadap requirement terbaru (${changed} skor/rekomendasi berubah)`, { rescreened: n, changed });
  return { status: 'ok', rescreened: n, changed };
});

// -------------------------------------------------------- AI screening -----

/**
 * What the screening was computed FROM. Stored with every screening so the requirement-vs-CV comparison keeps
 * showing the numbers behind the score even after the vacancy is edited or the candidate is enriched later.
 */
function buildSnapshot(candidate, vacancy) {
  const skills = candidate.skills || [];
  return {
    vacancy: {
      ...vacancyToDict(vacancy), department: vacancy.department ?? null, job_level: vacancy.job_level ?? null, location: vacancy.location ?? null,
      preferred_criteria: vacancy.preferred_criteria || [],
    },
    candidate: {
      highest_education: candidate.highest_education ?? null, total_experience_years: candidate.total_experience_years || 0,
      skills: skills.map(x => x.skill_name),
      technical_skills: skills.filter(x => x.skill_type !== 'soft').map(x => x.skill_name),
      soft_skills: skills.filter(x => x.skill_type === 'soft').map(x => x.skill_name),
      certifications: (candidate.certifications || []).map(x => x.name),
      has_leadership: (candidate.experiences || []).some(e => e.is_leadership),
      leadership_positions: [...new Set((candidate.experiences || []).filter(e => e.is_leadership && e.position).map(e => e.position))].slice(0, 5),
      education_evidence: (candidate.educations || []).map(e => e.evidence_text).filter(Boolean).slice(0, 2).map(t => String(t).slice(0, 160)),
    },
    taken_at: nowIso(),
  };
}

function runScreeningCore(candidateId, vacancyId) {
  const candidate = DB.get('candidates', candidateId);
  const vacancy = DB.get('job_requirements', vacancyId);
  if (!candidate || !vacancy) throw new HttpError(404, 'Kandidat atau lowongan tidak ditemukan.');
  const result = engine.screenCandidate(candidateToScoringDict(candidate), vacancyToDict(vacancy), educationRanks());
  const s = DB.insert('screenings', {
    candidate_id: candidate.id, vacancy_id: vacancy.id, processed_at: nowIso(), ai_model_version: result.ai_model_version,
    overall_score: result.overall_score, criteria_scores: result.criteria_scores, evidence: result.evidence,
    matched_criteria: result.matched_criteria, missing_criteria: result.missing_criteria, gap_analysis: result.gap_analysis,
    summary: result.summary, recommendation: result.recommendation, confidence: result.confidence, hr_decision: null,
    snapshot: buildSnapshot(candidate, vacancy),
  });
  logAudit('Screening', s.id, 'AI_SCREENING_RUN', 'AI_ENGINE', `Screened against vacancy ${vacancy.position}`,
    { score: result.overall_score, recommendation: result.recommendation });
  return { id: s.id, ...result };
}

// ---- requirement vs CV comparison (Screening Center / Review) -------------

const CRITERIA_ORDER = [
  ['education', 'Pendidikan'], ['experience', 'Pengalaman'], ['technical_skills', 'Keahlian Teknis'],
  ['soft_skills', 'Soft Skill'], ['leadership', 'Kepemimpinan'], ['certification', 'Sertifikasi'],
];
const fmtYears = (n) => `${Number.isInteger(n) ? n : pyRound(n, 1)} tahun`;

/** Requirement + CV facts behind a stored screening. Older screenings (no snapshot) fall back to the current data. */
function screeningFacts(s) {
  if (s.snapshot) return { req: s.snapshot.vacancy, cv: s.snapshot.candidate, from: 'snapshot' };
  const cand = DB.get('candidates', s.candidate_id), vac = DB.get('job_requirements', s.vacancy_id);
  const skills = cand ? cand.skills || [] : [];
  return {
    req: { ...vacancyToDict(vac), preferred_criteria: vac.preferred_criteria || [] },
    cv: cand ? {
      highest_education: cand.highest_education ?? null, total_experience_years: cand.total_experience_years || 0,
      skills: skills.map(x => x.skill_name), technical_skills: skills.filter(x => x.skill_type !== 'soft').map(x => x.skill_name),
      soft_skills: skills.filter(x => x.skill_type === 'soft').map(x => x.skill_name), certifications: (cand.certifications || []).map(x => x.name),
      has_leadership: (cand.experiences || []).some(e => e.is_leadership),
      leadership_positions: [...new Set((cand.experiences || []).filter(e => e.is_leadership && e.position).map(e => e.position))].slice(0, 5),
      education_evidence: (cand.educations || []).map(e => e.evidence_text).filter(Boolean).slice(0, 2).map(t => String(t).slice(0, 160)),
    } : { highest_education: null, total_experience_years: 0, skills: [], technical_skills: [], soft_skills: [], certifications: [], has_leadership: false, leadership_positions: [], education_evidence: [] },
    from: 'current',
  };
}

function buildComparison(s) {
  const { req, cv, from } = screeningFacts(s);
  const scores = s.criteria_scores || {}, ev = s.evidence || {};
  const rawW = req.criteria_weights && Object.keys(req.criteria_weights).length ? req.criteria_weights : engine.DEFAULT_WEIGHTS;
  const weights = { ...engine.DEFAULT_WEIGHTS };
  for (const [k, v] of Object.entries(rawW)) if (v !== null && v !== undefined) weights[k] = v;

  const allSkills = new Set((cv.skills || []).map(x => x.toLowerCase()));
  const certSet = new Set((cv.certifications || []).map(x => x.toLowerCase()));
  const itemsFor = (required, haystack) => (required || []).map(label => ({ label, met: haystack.has(label.toLowerCase()) }));
  const applicable = {
    education: !!req.min_education, experience: (req.min_experience_years || 0) > 0,
    technical_skills: (req.technical_skills || []).length > 0, soft_skills: (req.soft_skills || []).length > 0,
    leadership: !!req.leadership_required, certification: (req.certifications_required || []).length > 0,
  };
  const techItems = itemsFor(req.technical_skills, allSkills), softItems = itemsFor(req.soft_skills, allSkills), certItems = itemsFor(req.certifications_required, certSet);
  const withMatched = (own, items) => [...new Set([...(own || []), ...items.filter(i => i.met).map(i => i.label)])];

  const detail = {
    education: {
      requirement: req.min_education ? `Minimal ${req.min_education}` : 'Tidak disyaratkan',
      cv: cv.highest_education || 'Tidak terdeteksi di CV', cv_notes: cv.education_evidence || [],
    },
    experience: {
      requirement: (req.min_experience_years || 0) > 0 ? `Minimal ${fmtYears(req.min_experience_years)}` : 'Tidak disyaratkan',
      cv: (cv.total_experience_years || 0) > 0 ? fmtYears(cv.total_experience_years) : 'Tidak terdeteksi di CV',
    },
    technical_skills: { requirement: applicable.technical_skills ? `${techItems.length} keahlian disyaratkan` : 'Tidak disyaratkan', requirement_items: techItems, cv: `${(cv.technical_skills || []).length} keahlian teknis terdeteksi`, cv_items: withMatched(cv.technical_skills, techItems) },
    soft_skills: { requirement: applicable.soft_skills ? `${softItems.length} soft skill disyaratkan` : 'Tidak disyaratkan', requirement_items: softItems, cv: `${(cv.soft_skills || []).length} soft skill terdeteksi`, cv_items: withMatched(cv.soft_skills, softItems) },
    leadership: {
      requirement: req.leadership_required ? 'Wajib berpengalaman memimpin' : 'Tidak disyaratkan',
      cv: cv.has_leadership ? `Terdeteksi${(cv.leadership_positions || []).length ? ` (${cv.leadership_positions.join(', ')})` : ''}` : 'Tidak terdeteksi di CV',
    },
    certification: { requirement: applicable.certification ? `${certItems.length} sertifikasi disyaratkan` : 'Tidak disyaratkan', requirement_items: certItems, cv: `${(cv.certifications || []).length} sertifikasi terdeteksi`, cv_items: cv.certifications || [] },
  };

  const rows = CRITERIA_ORDER.map(([key, label]) => {
    const score = typeof scores[key] === 'number' ? scores[key] : null;
    const status = !applicable[key] ? 'NA' : score === null ? 'NA' : score >= 100 ? 'MET' : score >= 50 ? 'PARTIAL' : 'NOT_MET';
    return { key, label, weight_pct: pyRound((weights[key] ?? 0) * 100, 1), score, status, note: ev[key] || null, ...detail[key] };
  });
  const manual = (key, label, list) => (list && list.length ? [{ key, label, manual: true, status: 'MANUAL', score: null, weight_pct: null, note: 'Catatan untuk ditinjau HR — tidak dinilai otomatis oleh AI.', requirement: `${list.length} kriteria`, requirement_items: list.map(l => ({ label: l, met: null })), cv: 'Tinjau manual pada dokumen CV', cv_items: [] }] : []);
  const all = [...rows, ...manual('mandatory', 'Kriteria Tambahan (Wajib)', req.mandatory_criteria), ...manual('preferred', 'Kriteria Preferensi', req.preferred_criteria)];

  // Did the vacancy change after this screening was computed? (only knowable when a snapshot exists)
  const vac = DB.get('job_requirements', s.vacancy_id);
  let outdated = false;
  if (from === 'snapshot' && vac) {
    const cur = vacancyToDict(vac);
    outdated = JSON.stringify(cur) !== JSON.stringify(pickKeys(req, Object.keys(cur)));
  }
  const counts = { met: 0, partial: 0, not_met: 0, na: 0 };
  for (const r of rows) counts[{ MET: 'met', PARTIAL: 'partial', NOT_MET: 'not_met', NA: 'na' }[r.status]]++;
  return { source: from, requirement_outdated: outdated, rows: all, counts };
}
const pickKeys = (o, keys) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]));

route('POST', '/api/screening/run', async ({ body }) => runScreeningCore(body.candidate_id, body.vacancy_id));

function screeningDetail(s) {
  return {
    id: s.id, candidate: candidateSummary(DB.get('candidates', s.candidate_id)), vacancy_id: s.vacancy_id,
    vacancy_position: DB.get('job_requirements', s.vacancy_id).position, overall_score: s.overall_score,
    criteria_scores: s.criteria_scores, evidence: s.evidence, matched_criteria: s.matched_criteria,
    missing_criteria: s.missing_criteria, gap_analysis: s.gap_analysis, summary: s.summary,
    recommendation: s.recommendation, confidence: s.confidence, processed_at: s.processed_at,
    hr_decision: s.hr_decision ? { decision: s.hr_decision.decision, reason: s.hr_decision.reason, remarks: s.hr_decision.remarks, reviewer: s.hr_decision.reviewer } : null,
  };
}

route('GET', '/api/screening/:id', async ({ params }) => screeningDetail(requireFound(DB.get('screenings', params.id), 'Data screening tidak ditemukan.')));

/** Same as above + the requirement-vs-CV comparison and the candidate's CV files (used by Review / Screening Center). */
route('GET', '/api/screening/:id/full', async ({ params }) => {
  const s = requireFound(DB.get('screenings', params.id), 'Data screening tidak ditemukan.');
  return { ...screeningDetail(s), comparison: buildComparison(s), cvs: cvList(s.candidate_id) };
});

function screeningCenter(vacancy, full) {
  const screenings = DB.filter('screenings', s => s.vacancy_id === vacancy.id)
    .sort((a, b) => (b.overall_score - a.overall_score) || (a.id - b.id));
  const rows = screenings.map((s, i) => {
    const row = {
      rank: i + 1, screening_id: s.id, candidate_id: s.candidate_id,
      candidate_name: DB.get('candidates', s.candidate_id).name, match_score: s.overall_score,
      recommendation: s.recommendation, hr_status: s.hr_decision ? s.hr_decision.decision : 'PENDING_REVIEW',
      confidence: s.confidence, criteria_scores: s.criteria_scores || {}, matched_criteria: s.matched_criteria || [],
      missing_criteria: s.missing_criteria || [], summary: s.summary, gap_analysis: s.gap_analysis,
    };
    if (!full) return row;
    const cmp = buildComparison(s);
    const cvs = cvList(s.candidate_id);
    return {
      ...row,
      criteria_status: Object.fromEntries(cmp.rows.filter(r => !r.manual).map(r => [r.key, r.status])),
      criteria_counts: cmp.counts, requirement_outdated: cmp.requirement_outdated,
      cv_count: cvs.length, latest_cv_id: cvs.length ? cvs[0].id : null,
    };
  });
  return {
    vacancy: { id: vacancy.id, position: vacancy.position },
    summary: {
      total_cv: rows.length,
      high_match: rows.filter(r => r.recommendation === 'STRONG_MATCH').length,
      review: rows.filter(r => r.recommendation === 'POSSIBLE_MATCH').length,
      low_match: rows.filter(r => ['WEAK_MATCH', 'NOT_MATCH'].includes(r.recommendation)).length,
    },
    candidates: rows,
  };
}

route('GET', '/api/screening-center/:id', async ({ params }) => screeningCenter(requireFound(DB.get('job_requirements', params.id), 'Lowongan tidak ditemukan.'), false));

/** Screening Center list with per-criterion status and CV availability for every row. */
route('GET', '/api/screening-center/:id/full', async ({ params }) => {
  const v = requireFound(DB.get('job_requirements', params.id), 'Lowongan tidak ditemukan.');
  const data = screeningCenter(v, true);
  return { ...data, vacancy: { id: v.id, position: v.position, department: v.department, status: v.status, outdated_count: data.candidates.filter(c => c.requirement_outdated).length } };
});

// ------------------------------------------------------- HR decision -------

route('POST', '/api/hr-decision', async ({ body }) => {
  const screening = requireFound(DB.get('screenings', body.screening_id), 'Data screening tidak ditemukan.');
  if (!['PASS', 'REJECT', 'HOLD', 'TALENT_POOL'].includes(body.decision)) throw new HttpError(400, 'Keputusan tidak valid.');
  if (!body.reason || !String(body.reason).trim()) throw new HttpError(400, 'Alasan keputusan wajib diisi.');
  const reviewer = ownerName();
  screening.hr_decision = {
    decision: body.decision, reason: body.reason, remarks: body.remarks ?? null, reviewer, review_date: nowIso(),
  };
  DB.save('screenings', screening);
  if (body.decision === 'TALENT_POOL') {
    const exists = DB.find('talent_pool', p => p.candidate_id === screening.candidate_id && p.status === 'ACTIVE');
    if (!exists) {
      DB.insert('talent_pool', {
        candidate_id: screening.candidate_id, status: 'ACTIVE', added_by: reviewer, added_date: nowIso(),
        source_vacancy_id: screening.vacancy_id, notes: body.remarks ?? null, last_reactivated_at: null,
      });
    }
  }
  logAudit('HRDecision', screening.id, body.decision, reviewer, body.reason);
  return { status: 'ok', decision: body.decision };
});

// ------------------------------------------------------- Talent pool -------

route('GET', '/api/talent-pool', async ({ query }) => {
  const status = query.status === undefined ? 'ACTIVE' : query.status;
  let rows = DB.all('talent_pool');
  if (status) rows = rows.filter(e => e.status === status);
  const now = new Date();
  return rows.sort((a, b) => byNewest(a, b, 'added_date')).map(e => ({
    id: e.id, candidate_id: e.candidate_id, candidate_name: DB.get('candidates', e.candidate_id).name,
    status: e.status, added_date: e.added_date, source_vacancy: e.source_vacancy_id, notes: e.notes,
    aging_days: daysBetween(now, new Date(e.added_date)),
  }));
});

route('POST', '/api/talent-pool/add', async ({ body }) => {
  requireFound(DB.get('candidates', body.candidate_id), 'Kandidat tidak ditemukan.');
  const entry = DB.insert('talent_pool', {
    candidate_id: body.candidate_id, status: 'ACTIVE', added_by: ownerName(), added_date: nowIso(),
    source_vacancy_id: body.source_vacancy_id ?? null, notes: body.notes ?? null, last_reactivated_at: null,
  });
  logAudit('TalentPool', entry.id, 'ADD', ownerName());
  return { status: 'ok', id: entry.id };
});

route('POST', '/api/talent-pool/reactivate', async ({ body }) => {
  const result = runScreeningCore(body.candidate_id, body.vacancy_id);
  const entry = DB.find('talent_pool', e => e.candidate_id === body.candidate_id && e.status === 'ACTIVE');
  if (entry) {
    entry.status = 'REACTIVATED'; entry.last_reactivated_at = nowIso();
    DB.save('talent_pool', entry);
    logAudit('TalentPool', entry.id, 'REACTIVATED', ownerName(), `Re-matched against vacancy ${body.vacancy_id}`);
  }
  return result;
});

// ----------------------------------------------------- Recruitment stages --

route('GET', '/api/stage-config', async () => DB.filter('stage_config', c => c.active)
  .sort((a, b) => a.sequence - b.sequence)
  .map(c => ({ stage_code: c.stage_code, stage_name: c.stage_name, sequence: c.sequence, assessment_required: c.assessment_required, decision_required: c.decision_required })));

route('POST', '/api/recruitment-stage', async ({ body }) => {
  const candidate = DB.get('candidates', body.candidate_id);
  const vacancy = DB.get('job_requirements', body.vacancy_id);
  if (!candidate || !vacancy) throw new HttpError(404, 'Kandidat atau lowongan tidak ditemukan.');
  const conf = DB.find('stage_config', c => c.stage_code === body.stage_code);
  if (!conf) throw new HttpError(400, `Stage '${body.stage_code}' tidak dikenal di Stage Configuration.`);

  const scores = body.criteria_scores || {};
  for (const [k, v] of Object.entries(scores)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new HttpError(400, `Skor untuk kriteria '${k}' harus berupa angka (mis. ${k}:85).`);
  }
  const evidence = {};
  for (const [k, v] of Object.entries(body.evidence || {})) evidence[k] = String(v);

  if (conf.assessment_required && !Object.keys(scores).length) throw new HttpError(400, `Stage '${conf.stage_name}' mewajibkan penilaian kriteria (criteria_scores).`);
  if (conf.decision_required && !body.decision) throw new HttpError(400, `Stage '${conf.stage_name}' mewajibkan keputusan HR (decision).`);
  if (body.decision && !['PASS', 'HOLD', 'REJECT'].includes(body.decision)) throw new HttpError(400, 'Decision harus PASS, HOLD, atau REJECT.');
  const status = body.status || 'COMPLETED';

  let overall = body.overall_score ?? null;
  const vals = Object.values(scores);
  if (overall === null && vals.length) overall = pyRound(vals.reduce((s, x) => s + x, 0) / vals.length, 1);

  const reviewer = ownerName();
  const st = DB.insert('recruitment_stages', {
    candidate_id: body.candidate_id, vacancy_id: body.vacancy_id, stage_code: body.stage_code, stage_sequence: conf.sequence,
    criteria_scores: scores, overall_score: overall, evidence, reason: body.reason ?? null, remarks: body.remarks ?? null,
    reviewer, decision: body.decision ?? null, status, event_date: nowIso(),
  });
  logAudit('RecruitmentStage', st.id, 'STAGE_RECORDED', reviewer, `${conf.stage_name}: ${body.decision || status}`,
    { stage_code: body.stage_code, overall_score: overall, decision: body.decision ?? null });
  if (body.decision) logAudit('RecruitmentStage', st.id, 'STAGE_DECISION', reviewer, body.reason || '', { decision: body.decision });
  return { status: 'ok', id: st.id, overall_score: overall };
});

route('GET', '/api/recruitment-stage/:id', async ({ params }) => DB.filter('recruitment_stages', s => s.candidate_id === params.id)
  .sort((a, b) => (a.stage_sequence - b.stage_sequence) || (a.event_date < b.event_date ? -1 : 1))
  .map(s => ({
    id: s.id, stage_code: s.stage_code, vacancy_id: s.vacancy_id,
    vacancy_position: DB.get('job_requirements', s.vacancy_id) ? DB.get('job_requirements', s.vacancy_id).position : null,
    criteria_scores: s.criteria_scores, overall_score: s.overall_score, evidence: s.evidence, reason: s.reason,
    remarks: s.remarks, reviewer: s.reviewer, decision: s.decision, status: s.status, event_date: s.event_date,
  })));

// --------------------------------------------------------- Dashboards ------

const pct = (a, b) => (b ? pyRound((a / b) * 100, 1) : 0);
const countDistinct = (arr) => new Set(arr).size;

route('GET', '/api/dashboard/executive', async () => {
  const candidates = DB.all('candidates');
  const screenings = DB.all('screenings');
  const decided = screenings.filter(s => s.hr_decision);
  const stages = DB.all('recruitment_stages');

  const uniqueScreened = countDistinct(screenings.map(s => s.candidate_id));
  const uniqueReviewed = countDistinct(decided.map(s => s.candidate_id));
  const uniquePassed = countDistinct(decided.filter(s => s.hr_decision.decision === 'PASS').map(s => s.candidate_id));
  const uniqueHired = countDistinct(stages.filter(s => s.stage_code === 'HIRED' && s.status !== 'CANCELLED').map(s => s.candidate_id));

  const screeningTx = screenings.length;
  const hrDecisionTx = decided.length;
  const avgScore = screeningTx ? screenings.reduce((s, x) => s + x.overall_score, 0) / screeningTx : 0;
  const highMatchTx = screenings.filter(s => s.recommendation === 'STRONG_MATCH').length;
  const passTx = decided.filter(s => s.hr_decision.decision === 'PASS').length;
  const rejectTx = decided.filter(s => s.hr_decision.decision === 'REJECT').length;
  const holdTx = decided.filter(s => s.hr_decision.decision === 'HOLD').length;

  const talentPoolActive = DB.filter('talent_pool', e => e.status === 'ACTIVE').length;
  const openVacancy = DB.filter('job_requirements', v => v.status === 'OPEN').length;

  const stageCounts = {};
  for (const code of ['HR_INTERVIEW', 'ASSESSMENT', 'USER_INTERVIEW', 'OFFERING', 'MEDICAL', 'HIRED']) {
    stageCounts[code] = stages.filter(s => s.stage_code === code && s.status !== 'CANCELLED').length;
  }
  const conversion = screeningTx ? pyRound((stageCounts.HIRED / screeningTx) * 100, 1) : 0;

  const employees = DB.all('employees');
  const active = employees.filter(e => e.employment_status === 'Active');
  const lower = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));

  return {
    unique_candidates: { total_cv_bank: candidates.length, screened: uniqueScreened, hr_reviewed: uniqueReviewed, passed: uniquePassed, hired: uniqueHired },
    transactions: {
      screening_transactions: screeningTx, hr_decision_transactions: hrDecisionTx,
      pass_transactions: passTx, reject_transactions: rejectTx, hold_transactions: holdTx,
      ...Object.fromEntries(Object.entries(stageCounts).map(([k, v]) => [`${k.toLowerCase()}_transactions`, v])),
    },
    total_cv: candidates.length,
    ai_screened: screeningTx,
    average_ai_match_score: pyRound(avgScore, 1),
    high_match_pct: pct(highMatchTx, screeningTx),
    hr_pass_pct: pct(passTx, decided.length),
    hr_reject_pct: pct(rejectTx, decided.length),
    hr_hold_count: holdTx,
    talent_pool_active: talentPoolActive,
    open_vacancy: openVacancy,
    funnel: {
      cv_received: candidates.length, unique_candidates_screened: uniqueScreened, ai_screened: screeningTx,
      hr_reviewed: hrDecisionTx, shortlisted: passTx, ...lower(stageCounts),
    },
    hiring_conversion_pct: conversion,
    employees: {
      total_employees: employees.length, active_employees: active.length,
      permanent: employees.filter(e => e.employment_type === 'Permanent').length,
      contract: employees.filter(e => e.employment_type === 'Contract').length,
      contract_expiring_30d: active.filter(e => { const d = contractDaysRemaining(e.contract_end_date); return d !== null && d <= 30; }).length,
    },
  };
});

route('GET', '/api/dashboard/ai-hr-alignment', async () => {
  const decided = DB.all('screenings').filter(s => s.hr_decision);
  let aligned = 0;
  for (const s of decided) {
    const hrPositive = ['PASS', 'TALENT_POOL'].includes(s.hr_decision.decision);
    const aiPositive = ['STRONG_MATCH', 'POSSIBLE_MATCH'].includes(s.recommendation);
    if (hrPositive === aiPositive) aligned += 1;
  }
  const total = decided.length;
  return {
    total_reviewed: total,
    ai_hr_alignment_pct: total ? pyRound((aligned / total) * 100, 1) : null,
    ai_recommendation_overridden_pct: total ? pyRound(((total - aligned) / total) * 100, 1) : null,
    note: 'Proksi kesesuaian AI-HR, bukan klaim akurasi model tanpa ground-truth.',
  };
});

// ------------------------------------------------------------- Audit -------

route('GET', '/api/audit-trail', async ({ query }) => {
  let rows = DB.all('audit_trail');
  if (query.entity_type) rows = rows.filter(e => e.entity_type === query.entity_type);
  const limit = query.limit ? parseInt(query.limit, 10) : 200;
  return rows.sort((a, b) => byNewest(a, b, 'when')).slice(0, limit)
    .map(e => ({ id: e.id, entity_type: e.entity_type, entity_id: e.entity_id, action: e.action, who: e.who, when: e.when, why: e.why, details: e.details }));
});

export { runScreeningCore };
