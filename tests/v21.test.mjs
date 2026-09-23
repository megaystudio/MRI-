// v2.1 — Knowledge Center master data, Job Requirement CRUD/import/delete, requirement-vs-CV comparison, CV viewer endpoints.
// Self-contained: needs only `npm install` (no reference backend, no fixtures).   node tests/v21.test.mjs
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.__MRI_DOMParser = require('@xmldom/xmldom').DOMParser;

import { openWorkspace, api, apiFile, DB } from '../js/services.js';
import { ensureMasterData } from '../js/svc_master.js';
import { getExcelJS } from '../js/vendor.js';

const ok = (name) => console.log(`✓ ${name}`);
const err = async (p) => { try { await p; return null; } catch (e) { return e; } };
const J = (o) => JSON.stringify(o);
const fresh = async (name) => {
  DB.close(); await DB.deleteDatabase(name); await openWorkspace(name);
  await api('/api/profile/setup', { method: 'POST', body: J({ full_name: 'Owner Test', workspace_name: 'Kantor Uji' }) });
};

/** Builds an .xlsx File from rows: sheets = {name: [[...header], [...row], ...]} */
async function xlsxFile(name, sheets) {
  const ExcelJS = await getExcelJS();
  const wb = new ExcelJS.Workbook();
  for (const [title, rows] of Object.entries(sheets)) { const ws = wb.addWorksheet(title); rows.forEach(r => ws.addRow(r)); }
  const buf = await wb.xlsx.writeBuffer();
  return new File([buf], name);
}
const form = (file) => { const f = new FormData(); f.append('file', file); return f; };
const txtCv = (name, text) => new File([Buffer.from(text)], name, { type: 'text/plain' });
const upload = (file) => { const f = new FormData(); f.append('file', file); f.append('source', 'Job Portal'); return api('/api/cv/upload', { method: 'POST', body: f }); };

const CV_TEXT = `Budi Santoso
budi.santoso@example.com
081234567890

PENDIDIKAN
Universitas Indonesia, S1 Teknik Industri, 2014 - 2018

PENGALAMAN KERJA
Production Supervisor, PT Maju Jaya, 2018 - 2024
Memimpin tim produksi, Six Sigma, Production Planning, Quality Control, Leadership, Communication.

SERTIFIKASI
Six Sigma Green Belt 2021
`;

// ---------------------------------------------------------------- 1. master data
await fresh('v21-a');
{
  const cats = await api('/api/knowledge/master/categories');
  assert.deepEqual(cats.map(c => c.slug), ['positions', 'departments', 'job-levels', 'locations', 'education-levels', 'gpa-standards', 'certifications', 'hard-skills', 'soft-skills', 'cv-sources']);
  assert.ok(cats.every(c => c.count_active > 0), 'every category ships with starter values');
  const opts = await api('/api/knowledge/master/options');
  assert.deepEqual(opts['education-levels'].map(o => o.name), ['SMA/SMK', 'D3', 'S1', 'S2', 'S3']);
  assert.ok(opts['hard-skills'].some(o => o.name === 'Six Sigma') && opts['soft-skills'].some(o => o.name === 'Leadership'));
  assert.ok(opts.universities.length > 0);
  ok('master data seeded for a new workspace (10 categories, education levels ordered by rank, options endpoint)');

  const created = await api('/api/knowledge/master', { method: 'POST', body: J({ category: 'positions', name: '  Safety   Officer ', description: 'HSE' }) });
  assert.equal(created.name, 'Safety Officer'); assert.equal(created.source, 'manual');
  let e = await err(api('/api/knowledge/master', { method: 'POST', body: J({ category: 'positions', name: 'safety officer' }) }));
  assert.equal(e.status, 400); assert.match(e.message, /sudah ada/);
  e = await err(api('/api/knowledge/master', { method: 'POST', body: J({ category: 'nope', name: 'x' }) })); assert.equal(e.status, 400);
  e = await err(api('/api/knowledge/master', { method: 'POST', body: J({ category: 'gpa-standards', name: 'Aneh', value: 5 }) })); assert.match(e.message, /0 dan 4/);
  e = await err(api('/api/knowledge/master', { method: 'POST', body: J({ category: 'gpa-standards', name: 'Tanpa nilai' }) })); assert.match(e.message, /wajib/);
  const gpa = await api('/api/knowledge/master', { method: 'POST', body: J({ category: 'gpa-standards', name: 'Cum Laude', value: '3,5' }) });
  assert.equal(gpa.value, 3.5);
  ok('create: trims/normalises, rejects duplicates (case-insensitive), unknown category, invalid/missing values; accepts decimal comma');

  const upd = await api(`/api/knowledge/master/${created.id}`, { method: 'PUT', body: J({ name: 'HSE Officer', description: 'K3' }) });
  assert.equal(upd.name, 'HSE Officer');
  await api(`/api/knowledge/master/${created.id}`, { method: 'DELETE' });
  assert.ok(!(await api('/api/knowledge/master?category=positions')).some(m => m.id === created.id));
  assert.ok((await api('/api/knowledge/master?category=positions&active_only=false')).some(m => m.id === created.id && !m.active));
  assert.ok(!(await api('/api/knowledge/master/options')).positions.some(o => o.name === 'HSE Officer'));
  await api(`/api/knowledge/master/${created.id}/activate`, { method: 'POST' });
  assert.ok((await api('/api/knowledge/master/options')).positions.some(o => o.name === 'HSE Officer'));
  ok('edit, deactivate (hidden from pickers, kept in list), re-activate');

  const s1 = (await api('/api/knowledge/master?category=education-levels'))[2];
  assert.equal(s1.name, 'S1'); assert.equal(s1.system, true);
  e = await err(api(`/api/knowledge/master/${s1.id}`, { method: 'DELETE' })); assert.match(e.message, /bawaan/);
  e = await err(api(`/api/knowledge/master/${s1.id}`, { method: 'PUT', body: J({ name: 'Sarjana' }) })); assert.match(e.message, /bawaan/);
  e = await err(api(`/api/knowledge/master/${s1.id}`, { method: 'PUT', body: J({ value: 9 }) })); assert.match(e.message, /bawaan/);
  await api(`/api/knowledge/master/${s1.id}`, { method: 'PUT', body: J({ description: 'Sarjana / D4' }) });
  ok('built-in education levels are locked (name, rank, deactivation) but their description is editable');

  // custom education level takes part in screening (rank between D3 and S1)
  await api('/api/knowledge/master', { method: 'POST', body: J({ category: 'education-levels', name: 'D4', value: 2.5 }) });
  const cand = await upload(txtCv('d3.txt', 'Sari Dewi\nsari.dewi@example.com\n081298765432\nPendidikan: Diploma D3 Akuntansi 2015 - 2018\nPengalaman: Staff Accounting 2018 - 2022\nAccounting, Excel'));
  assert.equal(cand.candidate.highest_education, 'D3');
  const v = await api('/api/vacancies', { method: 'POST', body: J({ position: 'Tax Officer', min_education: 'D4', technical_skills: ['Accounting'] }) });
  const r = await api('/api/screening/run', { method: 'POST', body: J({ candidate_id: cand.candidate.id, vacancy_id: v.id }) });
  assert.equal(r.criteria_scores.education, 87.5, 'D3 (2) vs D4 (2.5): 100 - 0.5*25');
  ok('an education level added in the Knowledge Center is ranked by the screening engine');
}

// ---------------------------------------------------------------- 2. master import / templates
{
  const t = await apiFile('/api/knowledge/master/departments/import-template.xlsx');
  assert.match(t.filename, /departments/); assert.ok(t.blob.size > 3000);
  const all = await apiFile('/api/knowledge/master/import-template-all.xlsx');
  const ExcelJS = await getExcelJS();
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await all.blob.arrayBuffer());
  assert.deepEqual(wb.worksheets.map(w => w.name), ['Posisi', 'Departemen', 'Job Level', 'Lokasi Kerja', 'Level Pendidikan', 'Standar IPK', 'Sertifikasi', 'Hard Skill', 'Soft Skill', 'Sumber CV', 'Petunjuk']);
  ok('per-category and all-in-one Excel templates (one sheet per category + Petunjuk)');

  const file = await xlsxFile('dept.xlsx', { Departemen: [['Name', 'Description'], ['Legal', 'Hukum'], ['legal', 'dobel di file'], ['Finance', 'sudah ada'], [null, 'tanpa nama'], ['R&D', null]] });
  const res = await api('/api/knowledge/master/departments/import', { method: 'POST', body: form(file) });
  assert.deepEqual([res.total_rows, res.valid, res.duplicate, res.invalid], [5, 2, 2, 1]);
  const gfile = await xlsxFile('gpa.xlsx', { 'Standar IPK': [['Name', 'IPK Minimum', 'Description'], ['Beasiswa', 3.7, null], ['Salah', 'abc', null], ['Kelewat', 4.5, null]] });
  const gres = await api('/api/knowledge/master/gpa-standards/import', { method: 'POST', body: form(gfile) });
  assert.deepEqual([gres.valid, gres.invalid], [1, 2]);
  ok('per-category import: valid / duplicate (existing + inside file) / invalid rows are reported per row');

  const multi = await xlsxFile('all.xlsx', {
    Posisi: [['Name', 'Description'], ['Legal Counsel', null], ['Finance Staff', 'sudah ada']],
    'Job Level': [['Name', 'Urutan', 'Description'], ['Fellow', 9, null]],
    Petunjuk: [['abaikan']],
  });
  const mres = await api('/api/knowledge/master/import-all', { method: 'POST', body: form(multi) });
  assert.equal(mres.valid, 2); assert.equal(mres.duplicate, 1); assert.deepEqual(mres.by_category.map(c => c.slug), ['positions', 'job-levels']);
  assert.equal(mres.errors[0].sheet, 'Posisi');
  const e = await err(api('/api/knowledge/master/import-all', { method: 'POST', body: form(await xlsxFile('x.xlsx', { Lain: [['a'], ['b']] })) }));
  assert.equal(e.status, 400);
  const e2 = await err(api('/api/knowledge/master/positions/import', { method: 'POST', body: form(new File([Buffer.from('x')], 'x.csv')) }));
  assert.equal(e2.message, 'File harus berformat .xlsx');
  ok('all-in-one import reads every known sheet, ignores others, refuses unknown workbooks / non-xlsx');
}

// ---------------------------------------------------------------- 3. Job Requirement edit / delete
await fresh('v21-b');
let vacId, candId;
{
  const cv = await upload(txtCv('budi.txt', CV_TEXT));
  candId = cv.candidate.id;
  const created = await api('/api/vacancies', { method: 'POST', body: J({
    position: 'Production Supervisor', department: 'Manufacturing', job_level: 'Supervisor', location: 'Tangerang', min_education: 'S1',
    min_experience_years: 3, technical_skills: ['Six Sigma', 'SAP'], soft_skills: ['Leadership'], certifications_required: ['Six Sigma Green Belt'],
    leadership_required: true, mandatory_criteria: ['Bersedia shift'], languages_required: ['English'], salary_min: 6000000,
  }) });
  vacId = created.id;
  const opts = await api('/api/knowledge/master/options');
  assert.ok(opts.locations.some(o => o.name === 'Tangerang'));
  await api('/api/vacancies', { method: 'POST', body: J({ position: 'Analis Baru Khusus', department: 'Riset Khusus', technical_skills: ['Skill Baru X'] }) });
  const o2 = await api('/api/knowledge/master/options');
  assert.ok(o2.positions.some(o => o.name === 'Analis Baru Khusus') && o2.departments.some(o => o.name === 'Riset Khusus') && o2['hard-skills'].some(o => o.name === 'Skill Baru X'));
  ok('saving a Job Requirement registers new positions / departments / skills in the Knowledge Center (never duplicates existing)');
  assert.equal(o2['hard-skills'].filter(o => o.name === 'Six Sigma').length, 1);

  const detail = await api(`/api/vacancies/${vacId}/detail`);
  assert.equal(detail.location, 'Tangerang'); assert.deepEqual(detail.languages_required, ['English']); assert.equal(detail.salary_min, 6000000); assert.equal(detail.usage.screenings, 0);
  const base = await api(`/api/vacancies/${vacId}`); assert.ok(!('location' in base), 'the original endpoint keeps its original shape');
  const list = await api('/api/vacancies?include=stats'); assert.equal(list.find(v => v.id === vacId).screening_count, 0);
  ok('review: /detail returns the whole record (+ usage); original /vacancies/:id shape unchanged; list can include stats');

  const sc = await api('/api/screening/run', { method: 'POST', body: J({ candidate_id: candId, vacancy_id: vacId }) });
  assert.ok(sc.overall_score > 0);
  await api('/api/hr-decision', { method: 'POST', body: J({ screening_id: sc.id, decision: 'TALENT_POOL', reason: 'bagus' }) });

  // edit: partial body keeps fields that the form does not send
  const put = await api(`/api/vacancies/${vacId}`, { method: 'PUT', body: J({ position: '  Production   Supervisor ', min_experience_years: 8, technical_skills: ['Six Sigma', 'SAP', 'Kaizen'], status: 'ON_HOLD' }) });
  assert.equal(put.scoring_changed, true); assert.equal(put.screenings_affected, 1);
  assert.deepEqual(put.changed_fields.sort(), ['min_experience_years', 'position', 'status', 'technical_skills'].sort().filter(k => put.changed_fields.includes(k)));
  const d2 = await api(`/api/vacancies/${vacId}/detail`);
  assert.equal(d2.position, 'Production Supervisor'); assert.equal(d2.status, 'ON_HOLD'); assert.equal(d2.min_experience_years, 8);
  assert.deepEqual(d2.languages_required, ['English'], 'fields not sent stay untouched'); assert.equal(d2.salary_min, 6000000);
  assert.deepEqual(d2.mandatory_criteria, ['Bersedia shift']);
  const noop = await api(`/api/vacancies/${vacId}`, { method: 'PUT', body: J({ status: 'ON_HOLD' }) });
  assert.equal(noop.scoring_changed, false); assert.deepEqual(noop.changed_fields, []);
  for (const [body, re] of [[{ position: '   ' }, /posisi/i], [{ min_experience_years: -1 }, /negatif/], [{ min_experience_years: 'x' }, /angka/], [{ passing_score: 50, minimum_score: 70 }, /Passing score/],
    [{ criteria_weights: { education: 0.5 } }, /100%/], [{ status: 'DELETED' }, /Status/]]) {
    const e = await err(api(`/api/vacancies/${vacId}`, { method: 'PUT', body: J(body) }));
    assert.equal(e.status, 400); assert.match(e.message, re, J(body));
  }
  assert.equal((await err(api('/api/vacancies/9999', { method: 'PUT', body: J({}) }))).status, 404);
  assert.equal((await api(`/api/vacancies/${vacId}/detail`)).min_experience_years, 8, 'failed edits change nothing');
  ok('edit: partial update, normalisation, validation errors, no-op detection, 404; failed edits leave the record untouched');

  // comparison outdated after the edit, fixed by rescreen; HR decision survives
  let full = await api(`/api/screening/${sc.id}/full`);
  assert.equal(full.comparison.source, 'snapshot'); assert.equal(full.comparison.requirement_outdated, true);
  const expRow = full.comparison.rows.find(r => r.key === 'experience');
  assert.equal(expRow.requirement, 'Minimal 3 tahun', 'the comparison shows the requirement the score was computed from');
  const rs = await api(`/api/vacancies/${vacId}/rescreen`, { method: 'POST' });
  assert.equal(rs.rescreened, 1);
  full = await api(`/api/screening/${sc.id}/full`);
  assert.equal(full.comparison.requirement_outdated, false);
  assert.equal(full.comparison.rows.find(r => r.key === 'experience').requirement, 'Minimal 8 tahun');
  assert.equal(full.hr_decision.decision, 'TALENT_POOL', 'HR decision is kept on rescreen');
  ok('screening keeps a snapshot; edited vacancy flags it as outdated; rescreen recomputes and keeps the HR decision');

  // delete: blocked without cascade, cascade cleans up and unlinks
  const dep = await api(`/api/vacancies/${vacId}/dependents`);
  assert.deepEqual([dep.screenings, dep.talent_pool], [1, 1]);
  const e = await err(api(`/api/vacancies/${vacId}`, { method: 'DELETE' }));
  assert.equal(e.status, 409); assert.match(e.message, /1 hasil screening/);
  assert.ok(DB.get('job_requirements', vacId));
  const del = await api(`/api/vacancies/${vacId}?cascade=1`, { method: 'DELETE' });
  assert.equal(del.deleted.screenings, 1); assert.equal(del.unlinked.talent_pool, 1);
  assert.equal(DB.get('job_requirements', vacId), undefined);
  assert.equal(DB.filter('screenings', s => s.vacancy_id === vacId).length, 0);
  assert.equal(DB.all('talent_pool')[0].source_vacancy_id, null, 'talent pool entry stays, only the link is cleared');
  assert.equal((await err(api(`/api/vacancies/${vacId}`, { method: 'DELETE' }))).status, 404);
  const audit = (await api('/api/audit-trail?entity_type=JobRequirement')).find(a => a.action === 'DELETE');
  assert.equal(audit.details.screenings_deleted, 1);
  const emptyVac = await api('/api/vacancies', { method: 'POST', body: J({ position: 'Tanpa Riwayat' }) });
  await api(`/api/vacancies/${emptyVac.id}`, { method: 'DELETE' });   // no dependents -> no cascade flag needed
  ok('delete: 409 when in use, cascade removes screenings/stages and unlinks talent pool/employees, audit entry written, unused vacancies delete directly');
}

// ---------------------------------------------------------------- 4. comparison content
await fresh('v21-c');
{
  const cv = await upload(txtCv('budi.txt', CV_TEXT));
  const v = await api('/api/vacancies', { method: 'POST', body: J({
    position: 'Production Supervisor', min_education: 'S2', min_experience_years: 3, technical_skills: ['Six Sigma', 'SAP'], soft_skills: ['Leadership', 'Teamwork'],
    certifications_required: ['Six Sigma Green Belt', 'PMP'], leadership_required: true, mandatory_criteria: ['Usia maks 35'],
  }) });
  const sc = await api('/api/screening/run', { method: 'POST', body: J({ candidate_id: cv.candidate.id, vacancy_id: v.id }) });
  const full = await api(`/api/screening/${sc.id}/full`);
  const row = (k) => full.comparison.rows.find(r => r.key === k);
  assert.equal(row('education').requirement, 'Minimal S2'); assert.equal(row('education').cv, 'S1'); assert.equal(row('education').status, 'PARTIAL'); assert.equal(row('education').score, 75);
  assert.equal(row('technical_skills').status, 'PARTIAL');
  assert.deepEqual(row('technical_skills').requirement_items, [{ label: 'Six Sigma', met: true }, { label: 'SAP', met: false }]);
  assert.deepEqual(row('certification').requirement_items.map(i => i.met), [true, false]);
  assert.equal(row('leadership').status, 'MET'); assert.match(row('leadership').cv, /Terdeteksi/);
  assert.equal(row('mandatory').manual, true); assert.equal(row('mandatory').requirement_items[0].label, 'Usia maks 35');
  assert.ok(row('education').weight_pct > 0);
  assert.equal(full.comparison.counts.not_met + full.comparison.counts.partial + full.comparison.counts.met + full.comparison.counts.na, 6);
  assert.equal(full.cvs.length, 1); assert.equal(full.cvs[0].filename, 'budi.txt');
  ok('comparison: per-criterion requirement vs CV value, matched/missing items, status, weight, manual criteria, CV files');

  const center = await api(`/api/screening-center/${v.id}/full`);
  assert.equal(center.candidates[0].criteria_status.education, 'PARTIAL'); assert.equal(center.candidates[0].latest_cv_id, cv.candidate.id ? DB.all('cvs')[0].id : null);
  assert.equal(center.vacancy.outdated_count, 0);
  const plain = await api(`/api/screening-center/${v.id}`); assert.ok(!('criteria_status' in plain.candidates[0]), 'original list keeps its shape');
  ok('screening centre /full adds per-criterion status + CV availability; original endpoint unchanged');

  // legacy screening without snapshot (e.g. demo data) still produces a comparison from current data
  const s = DB.get('screenings', sc.id); delete s.snapshot; DB.save('screenings', s); await DB.commit();
  const legacy = await api(`/api/screening/${sc.id}/full`);
  assert.equal(legacy.comparison.source, 'current'); assert.equal(legacy.comparison.rows.find(r => r.key === 'education').cv, 'S1');
  ok('screenings created before v2.1 (no snapshot) fall back to the current vacancy/CV data');

  // CV viewer endpoints + CV bank extras
  const cvId = DB.all('cvs')[0].id;
  const txt = await api(`/api/cv/${cvId}/text`);
  assert.equal(txt.has_file, true); assert.match(txt.raw_text, /Budi Santoso/); assert.equal(txt.candidate_name, 'Budi Santoso'); assert.equal(txt.file_type, 'text/plain');
  const dl = await apiFile(`/api/cv/${cvId}/download`); assert.equal(dl.filename, 'budi.txt');
  const list = await api(`/api/candidates/${cv.candidate.id}/cv-list`); assert.equal(list.cvs.length, 1);
  const extras = await api('/api/candidates?include=extras');
  assert.equal(extras[0].cv_count, 1); assert.equal(extras[0].latest_cv_id, cvId); assert.equal(extras[0].screenings[0].vacancy_position, 'Production Supervisor');
  assert.ok(!('cv_count' in (await api('/api/candidates'))[0]));
  assert.equal((await err(api('/api/cv/9999/text'))).status, 404);
  ok('CV viewer endpoints (text, download, cv-list) and CV Bank extras (CV file + screening results per candidate)');
}

// ---------------------------------------------------------------- 5. Job Requirement Excel import
await fresh('v21-d');
{
  const tpl = await apiFile('/api/vacancies/import-template.xlsx');
  const ExcelJS = await getExcelJS();
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await tpl.blob.arrayBuffer());
  assert.deepEqual(wb.worksheets.map(w => w.name), ['Job Requirements', 'Petunjuk', 'Referensi Knowledge Center']);
  const ws = wb.getWorksheet('Job Requirements');
  assert.equal(ws.getRow(1).getCell(1).value, 'Position'); assert.equal(ws.getRow(2).getCell(1).value, 'Production Supervisor');
  assert.equal(ws.getCell('E2').dataValidation.type, 'list'); assert.match(ws.getCell('E5').dataValidation.formulae[0], /SMA\/SMK,D3,S1,S2,S3/);
  const ref = wb.getWorksheet('Referensi Knowledge Center');
  assert.equal(ref.getRow(1).getCell(1).value, 'Posisi'); assert.ok(ref.rowCount > 10);
  ok('Job Requirement template: header row, example row, drop-down validation, Petunjuk + Knowledge Center reference sheet');

  const H = ['Position', 'Department', 'Job Level', 'Location', 'Min Education', 'Min Experience Years', 'Technical Skills (comma separated)', 'Soft Skills (comma separated)', 'Certifications Required (comma separated)', 'Leadership Required (Yes/No)', 'Mandatory Criteria (comma separated)', 'Passing Score', 'Minimum Score', 'Status'];
  const file = await xlsxFile('jr.xlsx', { 'Job Requirements': [H,
    ['Cost Controller', 'Finance', 'Manager', 'Jakarta', 'S1', 5, 'Budgeting, SAP', 'Leadership', 'CPA', 'Yes', 'Usia maks 40, Bersedia dinas', 80, 65, 'open'],
    ['Cost Controller', 'Finance', 'Manager', 'Jakarta', 'S1', 5, null, null, null, null, null, null, null, null],   // duplicate of row above (in file)
    [null, 'Finance', null, null, null, null, null, null, null, null, null, null, null, null],                             // no position
    ['Analis', null, null, null, 'Profesor', 1, null, null, null, null, null, null, null, null],                          // bad education
    ['Analis', null, null, null, 's2', 'abc', null, null, null, null, null, null, null, null],                            // bad number
    ['Analis', null, null, null, 's2', 1, null, null, null, 'mungkin', null, null, null, null],                          // bad leadership
    ['Analis', null, null, null, 's2', 1, null, null, null, 'No', null, 50, 70, null],                                    // passing < minimum
    ['Analis', null, null, null, 's2', 1, null, null, null, 'No', null, null, null, 'Selesai'],                          // bad status
    ['Data Analyst Baru', 'Riset Baru', 'Fellow Baru', 'Kota Baru', 's2', 2, 'Python, Skill Impor Baru', 'Adaptability', null, 'No', null, null, null, null],
    ['Warehouse Lead', 'Warehouse & Logistics', 'Supervisor', 'Bekasi', null, null, 'Inventory Management', null, null, 'Ya', null, null, null, 'ON_HOLD'],
    ['Slot Empat', null, null, null, null, null, null, null, null, null, null, null, null, null],
  ] });
  const res = await api('/api/vacancies/import', { method: 'POST', body: form(file) });
  assert.equal(res.total_rows, 11);
  assert.equal(res.valid, 3, J(res.errors)); assert.equal(res.duplicate, 1);
  const reasons = res.errors.map(e => e.reason).join(' | ');
  for (const re of [/Position wajib/, /'Profesor' tidak dikenal/, /harus angka/, /Yes atau No/, /Passing Score tidak boleh/, /Status 'Selesai'/, /Batas jumlah lowongan paket Demo/]) assert.match(reasons, re);
  assert.equal(res.invalid, 7);
  const all = await api('/api/vacancies?include=stats');
  assert.equal(all.length, 3);
  const cc = all.find(v => v.position === 'Cost Controller');
  const d = await api(`/api/vacancies/${cc.id}/detail`);
  assert.deepEqual([d.min_education, d.min_experience_years, d.leadership_required, d.passing_score, d.minimum_score, d.status], ['S1', 5, true, 80, 65, 'OPEN']);
  assert.deepEqual(d.technical_skills, ['Budgeting', 'SAP']); assert.deepEqual(d.mandatory_criteria, ['Usia maks 40', 'Bersedia dinas']);
  const da = await api(`/api/vacancies/${all.find(v => v.position === 'Data Analyst Baru').id}/detail`); assert.equal(da.min_education, 'S2', 'education is canonicalised to the Knowledge Center spelling');
  assert.equal((await api(`/api/vacancies/${all.find(v => v.position === 'Warehouse Lead').id}/detail`)).status, 'ON_HOLD');
  assert.ok(res.master_added_count >= 5 && res.master_added.positions.includes('Data Analyst Baru') && res.master_added['hard-skills'].includes('Skill Impor Baru'));
  const o = await api('/api/knowledge/master/options');
  assert.ok(o.departments.some(x => x.name === 'Riset Baru') && o['job-levels'].some(x => x.name === 'Fellow Baru') && o.locations.some(x => x.name === 'Kota Baru'));
  ok('Job Requirement import: valid/duplicate/invalid rows, canonical education, yes/no + status parsing, plan limit, new values added to the Knowledge Center');

  const again = await api('/api/vacancies/import', { method: 'POST', body: form(await xlsxFile('jr2.xlsx', { 'Job Requirements': [H, ['Cost Controller', 'Finance', 'Manager', 'Jakarta']] })) });
  assert.equal(again.duplicate, 1); assert.equal(again.valid, 0);
  assert.equal((await err(api('/api/vacancies/import', { method: 'POST', body: form(new File([Buffer.from('x')], 'x.csv')) }))).message, 'File harus berformat .xlsx');
  ok('re-importing the same file creates no duplicates');
}

// ---------------------------------------------------------------- 6. upgrade from an existing (v1) workspace
{
  const NAME = 'v21-upgrade';
  DB.close(); await DB.deleteDatabase(NAME);
  // hand-build a v1 database, exactly what the previous app version left in the browser
  const v1Tables = ['candidates', 'cvs', 'job_requirements', 'screenings', 'talent_pool', 'stage_config', 'recruitment_stages', 'audit_trail', 'batch_upload_jobs', 'employee_options', 'employees', 'knowledge_job_criteria', 'knowledge_universities', 'knowledge_interview_questions'];
  const idb = await new Promise((res, rej) => {
    const req = indexedDB.open(NAME, 1);
    req.onupgradeneeded = () => { const d = req.result; v1Tables.forEach(t => d.createObjectStore(t, { keyPath: 'id' })); d.createObjectStore('meta', { keyPath: 'key' }); d.createObjectStore('cv_files', { keyPath: 'id' }); };
    req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
  });
  await new Promise((res, rej) => {
    const tx = idb.transaction(['meta', 'job_requirements', 'employees'], 'readwrite');
    tx.objectStore('meta').put({ key: 'profile', value: { full_name: 'Lama', workspace_name: 'WS Lama' } });
    tx.objectStore('job_requirements').put({ id: 1, position: 'Posisi Warisan', department: 'Dept Warisan', job_level: 'Staff', location: null, min_education: 'S1', min_experience_years: 1, technical_skills: ['Six Sigma', 'Skill Warisan'], soft_skills: [], certifications_required: [], leadership_required: false, mandatory_criteria: [], criteria_weights: {}, minimum_score: 60, passing_score: 75, status: 'OPEN', is_demo: false, created_at: new Date().toISOString() });
    tx.objectStore('employees').put({ id: 1, full_name: 'Karyawan Lama', department: 'Dept Karyawan', position: 'Posisi Karyawan', employment_status: 'Active' });
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
  idb.close();

  await openWorkspace(NAME);   // upgrades to v2 and seeds once
  const opts = await api('/api/knowledge/master/options');
  assert.ok(opts.positions.some(o => o.name === 'Posisi Warisan') && opts.positions.some(o => o.name === 'Posisi Karyawan'));
  assert.ok(opts.departments.some(o => o.name === 'Dept Warisan') && opts.departments.some(o => o.name === 'Dept Karyawan'));
  assert.ok(opts['hard-skills'].some(o => o.name === 'Skill Warisan'));
  assert.equal(DB.count('job_requirements'), 1, 'existing data survives the upgrade'); assert.equal(DB.count('employees'), 1);
  const before = DB.count('knowledge_master');
  await ensureMasterData(); await api('/api/knowledge/master/categories');
  assert.equal(DB.count('knowledge_master'), before, 'seeding runs only once');
  // starter values the user deleted stay deleted after a restart
  const item = DB.all('knowledge_master').find(m => m.category === 'locations' && m.name === 'Medan');
  await api(`/api/knowledge/master/${item.id}`, { method: 'DELETE' });
  DB.close(); await openWorkspace(NAME);
  assert.ok(!(await api('/api/knowledge/master/options')).locations.some(o => o.name === 'Medan'));
  ok('upgrade from a v1 workspace: data kept, master data seeded once from starter lists + values already in use');
}

console.log('\nALL v2.1 SERVICE TESTS PASSED');
