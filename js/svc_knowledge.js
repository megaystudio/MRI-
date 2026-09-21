/*
 * Knowledge Center services — job-criteria templates, university/GPA list,
 * interview question bank (+ Excel import/templates). Port of the
 * /api/knowledge/* endpoints. Entries are soft-deleted (active=false), never
 * hard-deleted, because they may already be referenced by vacancies.
 */
import * as DB from './db.js';
import { route, HttpError, ilike, requireFound, ownerName, logAudit, fileResult, XLSX_MIME, rowIsBlank, cellText } from './core.js';
import { buildExcelTemplate, readWorkbookRows } from './reports.js';
import { nowIso } from './util.js';

// -------------------------------------------------------- job criteria -----

const JOB_CRITERIA_IMPORT_HEADERS = [
  'Title', 'Position', 'Department', 'Job Level', 'Min Education', 'Min Experience Years',
  'Technical Skills (comma separated)', 'Soft Skills (comma separated)',
  'Certifications Required (comma separated)', 'Mandatory Criteria (comma separated)',
  'Passing Score', 'Minimum Score', 'Notes',
];
const UNIVERSITY_IMPORT_HEADERS = ['Name', 'Tier', 'Accreditation', 'Min GPA', 'Location', 'Notes'];
const QUESTION_IMPORT_HEADERS = ['Question Text', 'Competency', 'Stage Code', 'Job Level', 'Question Type', 'Ideal Answer Notes'];

const criteriaDict = (k) => ({
  id: k.id, title: k.title, position: k.position, department: k.department, job_level: k.job_level,
  min_education: k.min_education, min_experience_years: k.min_experience_years, industry_experience: k.industry_experience,
  technical_skills: k.technical_skills || [], soft_skills: k.soft_skills || [], leadership_required: k.leadership_required,
  certifications_required: k.certifications_required || [], languages_required: k.languages_required || [],
  mandatory_criteria: k.mandatory_criteria || [], preferred_criteria: k.preferred_criteria || [],
  criteria_weights: k.criteria_weights || {}, minimum_score: k.minimum_score, passing_score: k.passing_score,
  notes: k.notes, active: k.active, times_used: k.times_used, created_by: k.created_by, created_at: k.created_at,
});

const activeOnly = (q) => q.active_only === undefined || q.active_only === 'true' || q.active_only === '1';
const splitCsv = (s) => s.split(',').map(x => x.trim()).filter(Boolean);

function importSummary(total, valid, dup, invalid, errors, imported) {
  return { total_rows: total, valid, duplicate: dup, invalid, imported_count: imported.length, errors, imported };
}

async function readImportRows(file, sheetName, width) {
  if (!file || !file.name.toLowerCase().endsWith('.xlsx') && !file.name.toLowerCase().endsWith('.xlsm')) throw new HttpError(400, 'File harus berformat .xlsx');
  const buf = await file.arrayBuffer();
  if (buf.byteLength === 0) throw new HttpError(400, 'File kosong.');
  try { return await readWorkbookRows(buf, sheetName, width); } catch (exc) { throw new HttpError(400, `Gagal membaca file Excel: ${exc.message || exc}`); }
}

route('GET', '/api/knowledge/job-criteria', async ({ query }) => {
  let rows = DB.all('knowledge_job_criteria');
  if (activeOnly(query)) rows = rows.filter(k => k.active);
  if (query.q) rows = rows.filter(k => ilike(k.title, query.q) || ilike(k.position, query.q));
  return rows.sort((a, b) => a.title.localeCompare(b.title)).map(criteriaDict);
});

route('GET', '/api/knowledge/job-criteria/import-template.xlsx', async () => {
  const example = [
    'Production Supervisor - Standard', 'Production Supervisor', 'Manufacturing', 'Supervisor', 'S1', 2,
    'Six Sigma, Production Planning', 'Leadership, Communication', 'Six Sigma Green Belt',
    'Usia maksimal 35 tahun, Bersedia kerja shift, Berdomisili di Tangerang atau bersedia relokasi',
    75, 60, 'Contoh catatan (opsional)',
  ];
  const notes = [
    'PETUNJUK IMPORT TEMPLATE KRITERIA JABATAN — MRI', '',
    '1. Jangan mengubah urutan/nama kolom pada baris pertama.',
    '2. Baris kedua adalah CONTOH — hapus atau timpa sebelum import.',
    '3. Kolom wajib: Title, Position.',
    "4. Kolom 'Mandatory Criteria' bebas diisi kriteria apa saja yang belum ada di kolom lain (mis. usia, domisili, SIM, dll) — dipisahkan koma. Kriteria ini dicatat sebagai catatan untuk ditinjau HR/Recruiter secara manual, TIDAK dinilai otomatis oleh AI Screening.",
    '5. PERHATIAN: kriteria berbasis atribut yang dilindungi hukum (agama, ras, suku, jenis kelamin tanpa alasan pekerjaan yang sah) berisiko melanggar UU Ketenagakerjaan Pasal 5-6. Gunakan dengan hati-hati dan sesuai konteks hukum yang berlaku.',
    '6. Baris dengan Title yang sudah ada di sistem akan ditandai Duplicate dan dilewati.',
  ];
  return fileResult(await buildExcelTemplate('Job Criteria', JOB_CRITERIA_IMPORT_HEADERS, example, notes), 'MRI_JobCriteria_Import_Template.xlsx', XLSX_MIME);
}, { tx: false });

route('GET', '/api/knowledge/job-criteria/:id', async ({ params }) => criteriaDict(requireFound(DB.get('knowledge_job_criteria', params.id), 'Template kriteria jabatan tidak ditemukan.')));

route('POST', '/api/knowledge/job-criteria', async ({ body }) => {
  if (!String(body.title || '').trim() || !String(body.position || '').trim()) throw new HttpError(400, 'Judul template dan posisi tidak boleh kosong.');
  const k = DB.insert('knowledge_job_criteria', {
    title: body.title, position: body.position, department: body.department ?? null, job_level: body.job_level ?? null,
    min_education: body.min_education ?? null, min_experience_years: body.min_experience_years ?? 0,
    industry_experience: body.industry_experience ?? null, technical_skills: body.technical_skills || [], soft_skills: body.soft_skills || [],
    leadership_required: !!body.leadership_required, certifications_required: body.certifications_required || [],
    languages_required: body.languages_required || [], mandatory_criteria: body.mandatory_criteria || [],
    preferred_criteria: body.preferred_criteria || [], criteria_weights: body.criteria_weights || {},
    minimum_score: body.minimum_score ?? 60, passing_score: body.passing_score ?? 75, notes: body.notes ?? null,
    active: true, created_by: ownerName(), created_at: nowIso(), updated_at: nowIso(), times_used: 0,
  });
  logAudit('KnowledgeJobCriteria', k.id, 'CREATE', ownerName(), `Template '${k.title}' dibuat`);
  return criteriaDict(k);
});

route('PUT', '/api/knowledge/job-criteria/:id', async ({ params, body }) => {
  const k = requireFound(DB.get('knowledge_job_criteria', params.id), 'Template kriteria jabatan tidak ditemukan.');
  for (const f of ['title', 'position', 'department', 'job_level', 'min_education', 'min_experience_years', 'industry_experience',
    'technical_skills', 'soft_skills', 'leadership_required', 'certifications_required', 'languages_required', 'mandatory_criteria',
    'preferred_criteria', 'criteria_weights', 'minimum_score', 'passing_score', 'notes']) if (f in body) k[f] = body[f];
  k.updated_at = nowIso();
  DB.save('knowledge_job_criteria', k);
  logAudit('KnowledgeJobCriteria', k.id, 'UPDATE', ownerName());
  return criteriaDict(k);
});

route('DELETE', '/api/knowledge/job-criteria/:id', async ({ params }) => {
  const k = requireFound(DB.get('knowledge_job_criteria', params.id), 'Template kriteria jabatan tidak ditemukan.');
  k.active = false; DB.save('knowledge_job_criteria', k);
  logAudit('KnowledgeJobCriteria', k.id, 'DEACTIVATE', ownerName());
  return { status: 'ok' };
});

route('POST', '/api/knowledge/job-criteria/import', async ({ body }) => {
  const file = body.get('file');
  const rows = await readImportRows(file, 'Job Criteria', 13);
  let total = 0, valid = 0, dup = 0, invalid = 0;
  const errors = [], imported = [];
  for (const { row: idx, cells } of rows) {
    if (rowIsBlank(cells)) continue;
    total++;
    const title = cellText(cells, 0), position = cellText(cells, 1);
    if (!title || !position) { invalid++; errors.push({ row: idx, status: 'INVALID', reason: 'Title dan Position wajib diisi' }); continue; }
    if (DB.find('knowledge_job_criteria', k => k.title === title)) { dup++; errors.push({ row: idx, status: 'DUPLICATE', reason: `Template '${title}' sudah ada` }); continue; }
    const num = (i, dflt) => (cells[i] === null || cells[i] === undefined || cells[i] === '' ? dflt : Number(String(cells[i]).trim()));
    const minExp = num(5, 0), passScore = num(10, 75), minScore = num(11, 60);
    if ([minExp, passScore, minScore].some(n => !Number.isFinite(n))) { invalid++; errors.push({ row: idx, status: 'INVALID', reason: 'Min Experience/Passing/Minimum Score harus angka' }); continue; }
    const k = DB.insert('knowledge_job_criteria', {
      title, position, department: cellText(cells, 2) || null, job_level: cellText(cells, 3) || null, min_education: cellText(cells, 4) || null,
      min_experience_years: minExp, industry_experience: null, technical_skills: splitCsv(cellText(cells, 6)), soft_skills: splitCsv(cellText(cells, 7)),
      leadership_required: false, certifications_required: splitCsv(cellText(cells, 8)), languages_required: [], mandatory_criteria: splitCsv(cellText(cells, 9)),
      preferred_criteria: [], criteria_weights: {}, passing_score: passScore, minimum_score: minScore, notes: cellText(cells, 12) || null,
      active: true, created_by: ownerName(), created_at: nowIso(), updated_at: nowIso(), times_used: 0,
    });
    valid++; imported.push({ row: idx, id: k.id, title });
  }
  logAudit('KnowledgeJobCriteria', 0, 'EXCEL_IMPORT', ownerName(), `${valid} imported, ${dup} duplicate, ${invalid} invalid`, { filename: file.name });
  return importSummary(total, valid, dup, invalid, errors, imported);
});

// -------------------------------------------------------- universities -----

const uniDict = (u) => ({ id: u.id, name: u.name, tier: u.tier, accreditation: u.accreditation, min_gpa: u.min_gpa, location: u.location, notes: u.notes, active: u.active, created_by: u.created_by, created_at: u.created_at });

route('GET', '/api/knowledge/universities', async ({ query }) => {
  let rows = DB.all('knowledge_universities');
  if (activeOnly(query)) rows = rows.filter(u => u.active);
  if (query.q) rows = rows.filter(u => ilike(u.name, query.q));
  return rows.sort((a, b) => a.name.localeCompare(b.name)).map(uniDict);
});

route('POST', '/api/knowledge/universities', async ({ body }) => {
  const name = String(body.name || '').trim();
  if (!name) throw new HttpError(400, 'Nama universitas tidak boleh kosong.');
  if (DB.find('knowledge_universities', u => u.name === name)) throw new HttpError(400, 'Universitas dengan nama ini sudah ada di daftar.');
  const u = DB.insert('knowledge_universities', {
    name: body.name, tier: body.tier || null, accreditation: body.accreditation || null, min_gpa: body.min_gpa ?? null,
    location: body.location || null, notes: body.notes ?? null, active: true, created_by: ownerName(), created_at: nowIso(), updated_at: nowIso(),
  });
  logAudit('KnowledgeUniversity', u.id, 'CREATE', ownerName(), `'${u.name}' ditambahkan`);
  return uniDict(u);
});

route('PUT', '/api/knowledge/universities/:id', async ({ params, body }) => {
  const u = requireFound(DB.get('knowledge_universities', params.id), 'Universitas tidak ditemukan.');
  for (const f of ['name', 'tier', 'accreditation', 'min_gpa', 'location', 'notes']) if (f in body) u[f] = body[f];
  u.updated_at = nowIso(); DB.save('knowledge_universities', u);
  logAudit('KnowledgeUniversity', u.id, 'UPDATE', ownerName());
  return uniDict(u);
});

route('DELETE', '/api/knowledge/universities/:id', async ({ params }) => {
  const u = requireFound(DB.get('knowledge_universities', params.id), 'Universitas tidak ditemukan.');
  u.active = false; DB.save('knowledge_universities', u);
  logAudit('KnowledgeUniversity', u.id, 'DEACTIVATE', ownerName());
  return { status: 'ok' };
});

route('GET', '/api/knowledge/universities/import-template.xlsx', async () => {
  const notes = [
    'PETUNJUK IMPORT DAFTAR UNIVERSITAS — MRI', '',
    '1. Jangan mengubah urutan/nama kolom pada baris pertama.',
    '2. Baris kedua adalah CONTOH — hapus atau timpa sebelum import.',
    '3. Kolom wajib: Name.',
    '4. Min GPA gunakan titik desimal (contoh: 3.00), kosongkan jika tidak ada syarat IPK.',
    '5. Nama universitas yang sudah ada di sistem akan ditandai Duplicate dan dilewati.',
  ];
  return fileResult(await buildExcelTemplate('Universities', UNIVERSITY_IMPORT_HEADERS,
    ['Universitas Indonesia', 'Tier 1', 'Unggul', 3.0, 'Jakarta', 'Contoh catatan (opsional)'], notes),
  'MRI_University_Import_Template.xlsx', XLSX_MIME);
}, { tx: false });

route('POST', '/api/knowledge/universities/import', async ({ body }) => {
  const file = body.get('file');
  const rows = await readImportRows(file, 'Universities', 6);
  let total = 0, valid = 0, dup = 0, invalid = 0;
  const errors = [], imported = [];
  for (const { row: idx, cells } of rows) {
    if (rowIsBlank(cells)) continue;
    total++;
    const name = cellText(cells, 0);
    if (!name) { invalid++; errors.push({ row: idx, status: 'INVALID', reason: 'Name wajib diisi' }); continue; }
    if (DB.find('knowledge_universities', u => u.name === name)) { dup++; errors.push({ row: idx, status: 'DUPLICATE', reason: `Universitas '${name}' sudah ada` }); continue; }
    let minGpa = null;
    if (cells[3] !== null && cells[3] !== undefined && cells[3] !== '') {
      minGpa = Number(String(cells[3]).trim());
      if (!Number.isFinite(minGpa)) { invalid++; errors.push({ row: idx, status: 'INVALID', reason: `Min GPA '${cells[3]}' bukan angka` }); continue; }
    }
    const u = DB.insert('knowledge_universities', {
      name, tier: cellText(cells, 1) || null, accreditation: cellText(cells, 2) || null, min_gpa: minGpa,
      location: cellText(cells, 4) || null, notes: cellText(cells, 5) || null, active: true,
      created_by: ownerName(), created_at: nowIso(), updated_at: nowIso(),
    });
    valid++; imported.push({ row: idx, id: u.id, name });
  }
  logAudit('KnowledgeUniversity', 0, 'EXCEL_IMPORT', ownerName(), `${valid} imported, ${dup} duplicate, ${invalid} invalid`, { filename: file.name });
  return importSummary(total, valid, dup, invalid, errors, imported);
});

// ----------------------------------------------------------- questions -----

const qDict = (q) => ({ id: q.id, question_text: q.question_text, competency: q.competency, stage_code: q.stage_code, job_level: q.job_level, question_type: q.question_type, ideal_answer_notes: q.ideal_answer_notes, active: q.active, times_used: q.times_used, created_by: q.created_by, created_at: q.created_at });

route('GET', '/api/knowledge/interview-questions', async ({ query }) => {
  let rows = DB.all('knowledge_interview_questions');
  if (activeOnly(query)) rows = rows.filter(q => q.active);
  if (query.competency) rows = rows.filter(q => q.competency === query.competency);
  if (query.stage_code) rows = rows.filter(q => q.stage_code === query.stage_code);
  if (query.q) rows = rows.filter(q => ilike(q.question_text, query.q));
  return rows.sort((a, b) => String(a.competency || '').localeCompare(String(b.competency || '')) || a.id - b.id).map(qDict);
});

route('POST', '/api/knowledge/interview-questions', async ({ body }) => {
  if (!String(body.question_text || '').trim()) throw new HttpError(400, 'Teks pertanyaan tidak boleh kosong.');
  const item = DB.insert('knowledge_interview_questions', {
    question_text: body.question_text, competency: body.competency || null, stage_code: body.stage_code || null,
    job_level: body.job_level || null, question_type: body.question_type || null, ideal_answer_notes: body.ideal_answer_notes || null,
    active: true, created_by: ownerName(), created_at: nowIso(), updated_at: nowIso(), times_used: 0,
  });
  logAudit('KnowledgeInterviewQuestion', item.id, 'CREATE', ownerName());
  return qDict(item);
});

route('PUT', '/api/knowledge/interview-questions/:id', async ({ params, body }) => {
  const item = requireFound(DB.get('knowledge_interview_questions', params.id), 'Pertanyaan tidak ditemukan.');
  for (const f of ['question_text', 'competency', 'stage_code', 'job_level', 'question_type', 'ideal_answer_notes']) if (f in body) item[f] = body[f];
  item.updated_at = nowIso(); DB.save('knowledge_interview_questions', item);
  logAudit('KnowledgeInterviewQuestion', item.id, 'UPDATE', ownerName());
  return qDict(item);
});

route('POST', '/api/knowledge/interview-questions/:id/mark-used', async ({ params }) => {
  const item = requireFound(DB.get('knowledge_interview_questions', params.id), 'Pertanyaan tidak ditemukan.');
  item.times_used = (item.times_used || 0) + 1; DB.save('knowledge_interview_questions', item);
  return { status: 'ok', times_used: item.times_used };
});

route('DELETE', '/api/knowledge/interview-questions/:id', async ({ params }) => {
  const item = requireFound(DB.get('knowledge_interview_questions', params.id), 'Pertanyaan tidak ditemukan.');
  item.active = false; DB.save('knowledge_interview_questions', item);
  logAudit('KnowledgeInterviewQuestion', item.id, 'DEACTIVATE', ownerName());
  return { status: 'ok' };
});

route('GET', '/api/knowledge/interview-questions/import-template.xlsx', async () => {
  const notes = [
    'PETUNJUK IMPORT BANK PERTANYAAN INTERVIEW — MRI', '',
    '1. Jangan mengubah urutan/nama kolom pada baris pertama.',
    '2. Baris kedua adalah CONTOH — hapus atau timpa sebelum import.',
    '3. Kolom wajib: Question Text.',
    '4. Stage Code disarankan salah satu dari: HR_INTERVIEW, USER_INTERVIEW, ASSESSMENT (bebas diisi teks lain jika perlu).',
    '5. Question Type disarankan salah satu dari: Behavioral, Technical, Situational.',
    '6. Pertanyaan dengan teks persis sama yang sudah ada di sistem akan ditandai Duplicate dan dilewati.',
  ];
  return fileResult(await buildExcelTemplate('Interview Questions', QUESTION_IMPORT_HEADERS,
    ['Ceritakan pengalaman Anda memimpin tim dalam situasi sulit.', 'Leadership', 'HR_INTERVIEW', 'Supervisor', 'Behavioral', 'Contoh catatan jawaban ideal (opsional)'], notes),
  'MRI_InterviewQuestions_Import_Template.xlsx', XLSX_MIME);
}, { tx: false });

route('POST', '/api/knowledge/interview-questions/import', async ({ body }) => {
  const file = body.get('file');
  const rows = await readImportRows(file, 'Interview Questions', 6);
  let total = 0, valid = 0, dup = 0, invalid = 0;
  const errors = [], imported = [];
  for (const { row: idx, cells } of rows) {
    if (rowIsBlank(cells)) continue;
    total++;
    const text = cellText(cells, 0);
    if (!text) { invalid++; errors.push({ row: idx, status: 'INVALID', reason: 'Question Text wajib diisi' }); continue; }
    if (DB.find('knowledge_interview_questions', q => q.question_text === text)) { dup++; errors.push({ row: idx, status: 'DUPLICATE', reason: 'Pertanyaan dengan teks sama sudah ada' }); continue; }
    const item = DB.insert('knowledge_interview_questions', {
      question_text: text, competency: cellText(cells, 1) || null, stage_code: cellText(cells, 2) || null, job_level: cellText(cells, 3) || null,
      question_type: cellText(cells, 4) || null, ideal_answer_notes: cellText(cells, 5) || null, active: true,
      created_by: ownerName(), created_at: nowIso(), updated_at: nowIso(), times_used: 0,
    });
    valid++; imported.push({ row: idx, id: item.id });
  }
  logAudit('KnowledgeInterviewQuestion', 0, 'EXCEL_IMPORT', ownerName(), `${valid} imported, ${dup} duplicate, ${invalid} invalid`, { filename: file.name });
  return importSummary(total, valid, dup, invalid, errors, imported);
});
