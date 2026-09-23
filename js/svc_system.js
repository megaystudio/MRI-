/*
 * System services — workspace profile (first-run setup), plan/license, demo
 * data, and Excel/PDF exports.
 */
import * as DB from './db.js';
import {
  route, HttpError, byNewest, requireFound, ownerName, logAudit, getProfile, currentPlan, planLimits, requireFeature,
  fileResult, XLSX_MIME, PDF_MIME, resetPlanCache, DEFAULT_STAGES, DEFAULT_EMPLOYMENT_TYPES, DEFAULT_EMPLOYMENT_STATUSES,
} from './core.js';
import { verifyLicenseText, LicenseError } from './license.js';
import { buildExcel, buildPdfReport } from './reports.js';
import { generateDemoData, resetDemoData } from './demo.js';
import { seedMasterNow } from './svc_master.js';
import { nowIso, ymdCompact } from './util.js';
import { CONFIG } from '../config.js';

// ------------------------------------------------ workspace bootstrap -------

function seedKnowledgeCenter() {
  const by = 'System';
  if (!DB.count('knowledge_universities')) {
    const unis = [
      ['Universitas Indonesia', 'Tier 1', 'Unggul', 3.0, 'Depok'], ['Institut Teknologi Bandung', 'Tier 1', 'Unggul', 3.0, 'Bandung'],
      ['Universitas Gadjah Mada', 'Tier 1', 'Unggul', 3.0, 'Yogyakarta'], ['Institut Teknologi Sepuluh Nopember', 'Tier 1', 'Unggul', 3.0, 'Surabaya'],
      ['Universitas Airlangga', 'Tier 1', 'Unggul', 3.0, 'Surabaya'], ['Universitas Padjadjaran', 'Tier 2', 'A', 2.75, 'Bandung'],
      ['Universitas Diponegoro', 'Tier 2', 'A', 2.75, 'Semarang'], ['Universitas Brawijaya', 'Tier 2', 'A', 2.75, 'Malang'],
      ['Universitas Bina Nusantara', 'Tier 2', 'A', 2.75, 'Jakarta'], ['Universitas Telkom', 'Tier 2', 'A', 2.75, 'Bandung'],
    ];
    for (const [name, tier, accreditation, min_gpa, location] of unis) {
      DB.insert('knowledge_universities', { name, tier, accreditation, min_gpa, location, notes: null, active: true, created_by: by, created_at: nowIso(), updated_at: nowIso() });
    }
  }
  if (!DB.count('knowledge_interview_questions')) {
    const qs = [
      ['Ceritakan pengalaman Anda memimpin tim dalam situasi tekanan waktu yang ketat.', 'Leadership', 'HR_INTERVIEW', 'Supervisor', 'Behavioral', 'Cari contoh konkret: konteks, tindakan yang diambil, hasil terukur.'],
      ['Bagaimana Anda menangani konflik antar anggota tim?', 'Leadership', 'HR_INTERVIEW', 'Supervisor', 'Behavioral', 'Perhatikan pendekatan mediasi, bukan menghindar dari konflik.'],
      ['Jelaskan proses yang Anda gunakan untuk memecahkan masalah teknis yang kompleks.', 'Problem Solving', 'ASSESSMENT', 'Staff', 'Technical', 'Cari langkah sistematis: identifikasi akar masalah, opsi solusi, evaluasi hasil.'],
      ['Apa yang Anda ketahui tentang posisi ini dan mengapa Anda tertarik?', 'Motivation', 'USER_INTERVIEW', 'Staff', 'Behavioral', 'Perhatikan riset kandidat tentang perusahaan/posisi, bukan jawaban generik.'],
      ['Ceritakan situasi ketika Anda harus mengambil keputusan tanpa informasi lengkap.', 'Decision Making', 'USER_INTERVIEW', 'Manager', 'Situational', 'Cari kemampuan menimbang risiko dan mengambil tindakan tetap terukur.'],
      ['Bagaimana Anda memastikan kualitas pekerjaan tetap konsisten di bawah target yang agresif?', 'Quality Orientation', 'ASSESSMENT', 'Staff', 'Behavioral', 'Cari contoh sistem/checklist yang digunakan, bukan hanya niat baik.'],
    ];
    for (const [question_text, competency, stage_code, job_level, question_type, ideal_answer_notes] of qs) {
      DB.insert('knowledge_interview_questions', { question_text, competency, stage_code, job_level, question_type, ideal_answer_notes, active: true, created_by: by, created_at: nowIso(), updated_at: nowIso(), times_used: 0 });
    }
  }
  if (!DB.count('knowledge_job_criteria')) {
    const tpl = [
      { title: 'Production Supervisor - Standard', position: 'Production Supervisor', department: 'Manufacturing', job_level: 'Supervisor', min_education: 'S1', min_experience_years: 3, technical_skills: ['Six Sigma', 'Production Planning', 'Quality Control'], soft_skills: ['Leadership', 'Communication'], leadership_required: true, certifications_required: ['Six Sigma Green Belt'], mandatory_criteria: ['Bersedia kerja shift'], preferred_criteria: ['Pengalaman di industri manufaktur'], criteria_weights: { education: 0.15, experience: 0.35, skills: 0.30, certification: 0.20 }, minimum_score: 60, passing_score: 75, notes: 'Template standar untuk posisi Production Supervisor di lini manufaktur.' },
      { title: 'Finance Staff - Standard', position: 'Finance Staff', department: 'Finance', job_level: 'Staff', min_education: 'S1', min_experience_years: 1, technical_skills: ['Financial Reporting', 'Excel', 'Tax'], soft_skills: ['Attention to Detail', 'Integrity'], leadership_required: false, certifications_required: [], mandatory_criteria: ['Jujur dan teliti'], preferred_criteria: ['Pengalaman dengan ERP (SAP/Oracle)'], criteria_weights: { education: 0.20, experience: 0.30, skills: 0.35, certification: 0.15 }, minimum_score: 60, passing_score: 70, notes: 'Template standar untuk posisi staf Finance level entry-junior.' },
    ];
    for (const t of tpl) DB.insert('knowledge_job_criteria', { industry_experience: null, languages_required: [], active: true, created_by: by, created_at: nowIso(), updated_at: nowIso(), times_used: 0, ...t });
  }
}

/** Fills a brand-new workspace with its stage config, option lists and starter Knowledge Center content. */
export function seedWorkspaceDefaults() {
  if (!DB.count('stage_config')) {
    for (const [stage_code, stage_name, sequence, assessment_required, decision_required] of DEFAULT_STAGES) {
      DB.insert('stage_config', { stage_code, stage_name, sequence, active: true, assessment_required, decision_required });
    }
  }
  if (!DB.count('employee_options')) {
    DEFAULT_EMPLOYMENT_TYPES.forEach((label, i) => DB.insert('employee_options', { category: 'employment_type', code: label, label, sequence: i, active: true }));
    DEFAULT_EMPLOYMENT_STATUSES.forEach((label, i) => DB.insert('employee_options', { category: 'employment_status', code: label, label, sequence: i, active: true }));
  }
  seedKnowledgeCenter();
  seedMasterNow();
}

route('GET', '/api/profile', async () => getProfile(), { tx: false });

route('POST', '/api/profile/setup', async ({ body }) => {
  if (getProfile()) throw new HttpError(400, 'Workspace ini sudah disiapkan.');
  const name = String(body.full_name || '').trim();
  if (name.length < 2) throw new HttpError(400, 'Nama lengkap minimal 2 karakter.');
  const profile = { full_name: name, workspace_name: String(body.workspace_name || '').trim() || `Workspace ${name}`, created_at: nowIso() };
  DB.setMeta('profile', profile);
  seedWorkspaceDefaults();
  logAudit('Workspace', 1, 'WORKSPACE_CREATED', name, 'Workspace pribadi dibuat (Demo)');
  return profile;
});

route('PUT', '/api/profile', async ({ body }) => {
  const p = requireFound(getProfile(), 'Workspace belum disiapkan.');
  const name = String(body.full_name ?? p.full_name).trim();
  if (name.length < 2) throw new HttpError(400, 'Nama lengkap minimal 2 karakter.');
  const next = { ...p, full_name: name, workspace_name: String(body.workspace_name ?? p.workspace_name).trim() || p.workspace_name };
  DB.setMeta('profile', next);
  logAudit('Workspace', 1, 'PROFILE_UPDATED', name);
  return next;
});

// -------------------------------------------------------------- license ----

route('GET', '/api/license/status', async () => {
  const { plan, license, invalid } = await currentPlan();
  const limits = (await planLimits()).limits;
  return {
    plan, plan_label: limits.label,
    buyer_name: plan !== 'DEMO' && license ? license.buyer_name : null,
    license_issued_date: plan !== 'DEMO' && license ? license.license_issued_date : null,
    activated_at: plan !== 'DEMO' && license ? license.activated_at : null,
    license_invalid: invalid,
    limits,
    usage: {
      real_candidates: DB.filter('candidates', c => !c.is_demo).length,
      job_requirements: DB.filter('job_requirements', v => !v.is_demo).length,
    },
  };
}, { tx: false });

route('POST', '/api/license/activate', async ({ body }) => {
  let decoded;
  try { decoded = await verifyLicenseText(body.license_text, CONFIG.PUBLIC_KEY_HEX); } catch (exc) {
    if (exc instanceof LicenseError) throw new HttpError(400, exc.message);
    throw exc;
  }
  const previous = (await currentPlan()).plan;
  DB.setMeta('license', {
    plan: decoded.plan, buyer_name: decoded.buyer, license_issued_date: decoded.issued,
    license_text: body.license_text.trim(), activated_at: nowIso(),
  });
  resetPlanCache();
  logAudit('Workspace', 1, 'LICENSE_ACTIVATED', decoded.buyer, `${decoded.plan} activated (previous plan: ${previous})`,
    { buyer: decoded.buyer, issued: decoded.issued, plan: decoded.plan });
  return { status: 'ok', plan: decoded.plan, buyer_name: decoded.buyer, activated_at: nowIso() };
});

// ----------------------------------------------------------------- demo ----

route('GET', '/api/demo/status', async () => {
  const demo = DB.filter('candidates', c => c.is_demo).length;
  const real = DB.filter('candidates', c => !c.is_demo).length;
  return { demo_mode_active: demo > 0, demo_candidates: demo, real_candidates: real };
}, { tx: false });

route('POST', '/api/demo/seed', async ({ query }) => {
  const n = query.num_candidates ? parseInt(query.num_candidates, 10) : 45;
  if (!(n >= 5 && n <= 200)) throw new HttpError(400, 'num_candidates harus antara 5 dan 200.');
  const existing = DB.filter('candidates', c => c.is_demo).length;
  if (existing > 0) throw new HttpError(400, `Demo data sudah ada (${existing} kandidat demo). Reset dulu sebelum generate ulang, supaya tidak terjadi duplikasi data demo.`);
  const summary = generateDemoData(n);
  logAudit('DemoData', 0, 'DEMO_SEEDED', 'System', `${n} demo candidates requested`, summary);
  return { status: 'ok', ...summary };
});

route('POST', '/api/demo/reset', async () => {
  const summary = resetDemoData();
  logAudit('DemoData', 0, 'DEMO_RESET', 'System', 'Demo data cleared', summary);
  return { status: 'ok', ...summary };
});

// -------------------------------------------------------------- exports ----

const stamp = () => ymdCompact();
const safe = (s) => String(s).replace(/ /g, '_').replace(/[\\/:*?"<>|]/g, '_');
const day = (iso) => (iso ? String(iso).slice(0, 10) : '');
const ts = (iso) => String(iso).slice(0, 19).replace('T', ' ');

route('GET', '/api/export/candidates.xlsx', async () => {
  await requireFeature('export_reports', 'Export laporan');
  const rows = DB.all('candidates').sort((a, b) => byNewest(a, b)).map(c => [
    c.id, c.name, c.email, c.phone, c.highest_education, c.total_experience_years, c.source,
    c.skills.map(s => s.skill_name).join(', '), c.certifications.map(x => x.name).join(', '), day(c.created_at),
  ]);
  const headers = ['ID', 'Nama', 'Email', 'Telepon', 'Pendidikan', 'Pengalaman (thn)', 'Sumber', 'Keahlian', 'Sertifikasi', 'Tanggal Masuk CV Bank'];
  return fileResult(await buildExcel('CV Bank', headers, rows), `CV_Bank_${stamp()}.xlsx`, XLSX_MIME);
}, { tx: false });

function screeningRows(vacancyId) {
  return DB.filter('screenings', s => s.vacancy_id === vacancyId).sort((a, b) => (b.overall_score - a.overall_score) || (a.id - b.id));
}

route('GET', '/api/export/screening/:id.xlsx', async ({ params }) => {
  await requireFeature('export_reports', 'Export laporan');
  const vac = requireFound(DB.get('job_requirements', params.id), 'Lowongan tidak ditemukan.');
  const headers = ['Kandidat', 'Tanggal Screening', 'Skor', 'Rekomendasi AI', 'Matched Criteria', 'Missing Criteria', 'Gap Analysis', 'Keputusan HR', 'Reviewer', 'Alasan'];
  const rows = screeningRows(vac.id).map(s => [
    DB.get('candidates', s.candidate_id).name, day(s.processed_at), s.overall_score, s.recommendation,
    (s.matched_criteria || []).join(', '), (s.missing_criteria || []).join(', '), s.gap_analysis,
    s.hr_decision ? s.hr_decision.decision : 'PENDING_REVIEW', s.hr_decision ? s.hr_decision.reviewer : '', s.hr_decision ? s.hr_decision.reason : '',
  ]);
  return fileResult(await buildExcel('Screening Report', headers, rows), `Screening_${safe(vac.position)}_${stamp()}.xlsx`, XLSX_MIME);
}, { tx: false });

route('GET', '/api/export/screening/:id.pdf', async ({ params }) => {
  await requireFeature('export_reports', 'Export laporan');
  const vac = requireFound(DB.get('job_requirements', params.id), 'Lowongan tidak ditemukan.');
  const headers = ['Kandidat', 'Tgl Screening', 'Skor', 'Rekomendasi AI', 'Matched', 'Missing', 'Keputusan HR', 'Reviewer'];
  const rows = screeningRows(vac.id).map(s => [
    DB.get('candidates', s.candidate_id).name, day(s.processed_at), s.overall_score, s.recommendation,
    (s.matched_criteria || []).slice(0, 4).join(', '), (s.missing_criteria || []).slice(0, 4).join(', '),
    s.hr_decision ? s.hr_decision.decision : 'PENDING', s.hr_decision ? s.hr_decision.reviewer : '-',
  ]);
  const bytes = await buildPdfReport(`Screening Report — ${vac.position}`, headers, rows,
    { reportPeriod: `Lowongan: ${vac.position} (${vac.department || '-'})`, generatedBy: ownerName() });
  return fileResult(bytes, `Screening_${safe(vac.position)}.pdf`, PDF_MIME);
}, { tx: false });

route('GET', '/api/export/talent-pool.xlsx', async () => {
  await requireFeature('export_reports', 'Export laporan');
  const rows = DB.all('talent_pool').sort((a, b) => byNewest(a, b, 'added_date')).map(e => [
    DB.get('candidates', e.candidate_id).name, e.status, day(e.added_date),
    e.source_vacancy_id && DB.get('job_requirements', e.source_vacancy_id) ? DB.get('job_requirements', e.source_vacancy_id).position : '-', e.notes,
  ]);
  return fileResult(await buildExcel('Talent Pool', ['Kandidat', 'Status', 'Ditambahkan', 'Sumber Lowongan', 'Catatan'], rows), `Talent_Pool_${stamp()}.xlsx`, XLSX_MIME);
}, { tx: false });

route('GET', '/api/export/employees.xlsx', async () => {
  await requireFeature('export_reports', 'Export laporan');
  const headers = ['No. Karyawan', 'Nama', 'Departemen', 'Divisi', 'Posisi', 'Tipe', 'Status', 'Tgl Join', 'Kontrak Berakhir', 'Lokasi', 'Email', 'Telepon'];
  const rows = DB.all('employees').sort((a, b) => byNewest(a, b, 'created_date')).map(e => [
    e.employee_number, e.full_name, e.department, e.division, e.position, e.employment_type, e.employment_status, e.join_date, e.contract_end_date, e.location, e.email, e.phone,
  ]);
  return fileResult(await buildExcel('Employees', headers, rows), `Employee_Data_${stamp()}.xlsx`, XLSX_MIME);
}, { tx: false });

route('GET', '/api/export/employees.pdf', async () => {
  await requireFeature('export_reports', 'Export laporan');
  const headers = ['No. Karyawan', 'Nama', 'Departemen', 'Posisi', 'Tipe', 'Status', 'Tgl Join', 'Kontrak Berakhir'];
  const rows = DB.all('employees').sort((a, b) => String(a.department || '').localeCompare(String(b.department || '')) || String(a.full_name || '').localeCompare(String(b.full_name || '')))
    .map(e => [e.employee_number || '-', e.full_name, e.department || '-', e.position || '-', e.employment_type || '-', e.employment_status || '-', e.join_date || '-', e.contract_end_date || '-']);
  const bytes = await buildPdfReport('Employee Report', headers, rows, { reportPeriod: 'Seluruh Karyawan Aktif & Non-Aktif', generatedBy: ownerName() });
  return fileResult(bytes, `Employee_Report_${stamp()}.pdf`, PDF_MIME);
}, { tx: false });

route('GET', '/api/export/audit-trail.xlsx', async () => {
  await requireFeature('export_reports', 'Export laporan');
  const rows = DB.all('audit_trail').sort((a, b) => byNewest(a, b, 'when')).slice(0, 2000)
    .map(e => [ts(e.when), e.entity_type, e.entity_id, e.action, e.who, e.why]);
  return fileResult(await buildExcel('Audit Trail', ['Waktu', 'Entitas', 'ID Entitas', 'Aksi', 'Oleh', 'Alasan'], rows), `Audit_Trail_${stamp()}.xlsx`, XLSX_MIME);
}, { tx: false });
