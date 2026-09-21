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
} from './core.js';
import * as engine from './engine.js';
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
  return rows.map(candidateSummary);
});

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

route('POST', '/api/vacancies', async ({ body, query }) => {
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
  await checkCountLimit(DB.filter('job_requirements', v => !v.is_demo).length, 'max_job_requirements', 'jumlah lowongan');

  const v = DB.insert('job_requirements', {
    position: body.position, department: body.department ?? null, job_level: body.job_level ?? null,
    location: body.location ?? null, min_education: body.min_education ?? null, min_experience_years: minExp,
    industry_experience: body.industry_experience ?? null,
    technical_skills: body.technical_skills || [], soft_skills: body.soft_skills || [],
    leadership_required: !!body.leadership_required, certifications_required: body.certifications_required || [],
    languages_required: body.languages_required || [], salary_min: body.salary_min ?? null, salary_max: body.salary_max ?? null,
    mandatory_criteria: body.mandatory_criteria || [], preferred_criteria: body.preferred_criteria || [],
    criteria_weights: weights, minimum_score: minimum, passing_score: passing,
    status: body.status || 'OPEN', is_demo: false, created_at: nowIso(),
  });
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
  return rows.sort((a, b) => byNewest(a, b)).map(v => ({
    id: v.id, position: v.position, department: v.department, job_level: v.job_level, location: v.location,
    status: v.status, min_education: v.min_education, min_experience_years: v.min_experience_years,
    technical_skills: v.technical_skills, passing_score: v.passing_score, minimum_score: v.minimum_score, created_at: v.created_at,
  }));
});

route('GET', '/api/vacancies/:id', async ({ params }) => {
  const v = requireFound(DB.get('job_requirements', params.id), 'Lowongan tidak ditemukan.');
  return { ...vacancyToDict(v), id: v.id, department: v.department, status: v.status };
});

// -------------------------------------------------------- AI screening -----

function runScreeningCore(candidateId, vacancyId) {
  const candidate = DB.get('candidates', candidateId);
  const vacancy = DB.get('job_requirements', vacancyId);
  if (!candidate || !vacancy) throw new HttpError(404, 'Kandidat atau lowongan tidak ditemukan.');
  const result = engine.screenCandidate(candidateToScoringDict(candidate), vacancyToDict(vacancy));
  const s = DB.insert('screenings', {
    candidate_id: candidate.id, vacancy_id: vacancy.id, processed_at: nowIso(), ai_model_version: result.ai_model_version,
    overall_score: result.overall_score, criteria_scores: result.criteria_scores, evidence: result.evidence,
    matched_criteria: result.matched_criteria, missing_criteria: result.missing_criteria, gap_analysis: result.gap_analysis,
    summary: result.summary, recommendation: result.recommendation, confidence: result.confidence, hr_decision: null,
  });
  logAudit('Screening', s.id, 'AI_SCREENING_RUN', 'AI_ENGINE', `Screened against vacancy ${vacancy.position}`,
    { score: result.overall_score, recommendation: result.recommendation });
  return { id: s.id, ...result };
}

route('POST', '/api/screening/run', async ({ body }) => runScreeningCore(body.candidate_id, body.vacancy_id));

route('GET', '/api/screening/:id', async ({ params }) => {
  const s = requireFound(DB.get('screenings', params.id), 'Data screening tidak ditemukan.');
  return {
    id: s.id, candidate: candidateSummary(DB.get('candidates', s.candidate_id)), vacancy_id: s.vacancy_id,
    vacancy_position: DB.get('job_requirements', s.vacancy_id).position, overall_score: s.overall_score,
    criteria_scores: s.criteria_scores, evidence: s.evidence, matched_criteria: s.matched_criteria,
    missing_criteria: s.missing_criteria, gap_analysis: s.gap_analysis, summary: s.summary,
    recommendation: s.recommendation, confidence: s.confidence, processed_at: s.processed_at,
    hr_decision: s.hr_decision ? { decision: s.hr_decision.decision, reason: s.hr_decision.reason, remarks: s.hr_decision.remarks, reviewer: s.hr_decision.reviewer } : null,
  };
});

route('GET', '/api/screening-center/:id', async ({ params }) => {
  const vacancy = requireFound(DB.get('job_requirements', params.id), 'Lowongan tidak ditemukan.');
  const screenings = DB.filter('screenings', s => s.vacancy_id === vacancy.id)
    .sort((a, b) => (b.overall_score - a.overall_score) || (a.id - b.id));
  const rows = screenings.map((s, i) => ({
    rank: i + 1, screening_id: s.id, candidate_id: s.candidate_id,
    candidate_name: DB.get('candidates', s.candidate_id).name, match_score: s.overall_score,
    recommendation: s.recommendation, hr_status: s.hr_decision ? s.hr_decision.decision : 'PENDING_REVIEW',
    confidence: s.confidence, criteria_scores: s.criteria_scores || {}, matched_criteria: s.matched_criteria || [],
    missing_criteria: s.missing_criteria || [], summary: s.summary, gap_analysis: s.gap_analysis,
  }));
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
