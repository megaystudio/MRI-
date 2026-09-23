/*
 * Knowledge Center — MASTER DATA (referensi).
 *
 * The Knowledge Center is the single reference for every criterion used across
 * the app: positions, departments, job levels, education levels, GPA standards,
 * certifications, hard/soft skills, CV sources and work locations. (Universities,
 * the interview-question bank and job-criteria templates keep their own tables in
 * svc_knowledge.js.)
 *
 * A Job Requirement is NOT master data: it is one concrete vacancy that is used for
 * screening. Master data only supplies the allowed/suggested VALUES for its fields.
 *
 * Items are soft-deleted (active=false) because vacancies, templates and employees
 * store the value as plain text and must keep resolving.
 */
import * as DB from './db.js';
import {
  route, HttpError, requireFound, ownerName, logAudit, fileResult, XLSX_MIME, rowIsBlank, cellText,
} from './core.js';
import { buildMultiSheetTemplate, readWorkbookRows, readWorkbookSheets } from './reports.js';
import { TECHNICAL_SKILL_LIBRARY, KNOWN_CERTIFICATIONS } from './engine.js';
import { nowIso } from './util.js';

export const MASTER_GROUPS = {
  org: 'Organisasi & Jabatan',
  qual: 'Kualifikasi Kandidat',
  proc: 'Proses Rekrutmen',
};

/** Order = order of tabs in the UI. `valueLabel` present => the item carries a numeric value. */
export const MASTER_CATEGORIES = [
  { slug: 'positions', label: 'Posisi', group: 'org', description: 'Nama posisi/jabatan yang dipakai di Job Requirement, template, dan data karyawan.', example: ['Production Supervisor', 'Contoh posisi (opsional)'] },
  { slug: 'departments', label: 'Departemen', group: 'org', description: 'Daftar departemen/divisi perusahaan.', example: ['Manufacturing', 'Contoh departemen (opsional)'] },
  { slug: 'job-levels', label: 'Job Level', group: 'org', valueLabel: 'Urutan', valueHint: 'Urutan level, 1 = terendah (opsional)', description: 'Jenjang jabatan (Staff, Supervisor, Manager, dst.).', example: ['Supervisor', 4, 'Contoh level (opsional)'] },
  { slug: 'locations', label: 'Lokasi Kerja', group: 'org', description: 'Kota/lokasi penempatan.', example: ['Tangerang', 'Contoh lokasi (opsional)'] },
  { slug: 'education-levels', label: 'Level Pendidikan', group: 'qual', valueLabel: 'Peringkat', valueRequired: true, valueHint: 'Peringkat pendidikan: makin besar makin tinggi (SMA/SMK=1 … S3=5). Dipakai AI untuk membandingkan pendidikan.', description: 'Jenjang pendidikan. Lima level bawaan dikunci karena dipakai ekstraksi CV & penilaian AI; Anda bisa menambah level lain (mis. D4) dengan peringkat sendiri.', example: ['D4', 2.5, 'Contoh level tambahan (opsional)'] },
  { slug: 'gpa-standards', label: 'Standar IPK', group: 'qual', valueLabel: 'IPK Minimum', valueRequired: true, valueHint: 'Angka 0 – 4, gunakan titik desimal (mis. 2.75)', description: 'Standar IPK minimum yang dipakai perusahaan (per jenis program/posisi). IPK per universitas ada di tab Universitas.', example: ['Fresh Graduate', 2.75, 'Contoh standar IPK (opsional)'] },
  { slug: 'certifications', label: 'Sertifikasi', group: 'qual', description: 'Daftar sertifikasi profesional yang dikenali.', example: ['Six Sigma Green Belt', 'Contoh sertifikasi (opsional)'] },
  { slug: 'hard-skills', label: 'Hard Skill', group: 'qual', description: 'Keahlian teknis (dipakai sebagai "Keahlian Teknis" di Job Requirement).', example: ['Production Planning', 'Contoh hard skill (opsional)'] },
  { slug: 'soft-skills', label: 'Soft Skill', group: 'qual', description: 'Keahlian non-teknis (dipakai sebagai "Soft Skill" di Job Requirement).', example: ['Leadership', 'Contoh soft skill (opsional)'] },
  { slug: 'cv-sources', label: 'Sumber CV', group: 'proc', description: 'Asal CV kandidat (portal, LinkedIn, referral, dst.) — muncul sebagai pilihan di CV Intake.', example: ['Job Portal', 'Contoh sumber (opsional)'] },
];

const CAT = Object.fromEntries(MASTER_CATEGORIES.map(c => [c.slug, c]));
export const masterCategory = (slug) => CAT[slug] || null;

const EDU_SYSTEM = ['SMA/SMK', 'D3', 'S1', 'S2', 'S3'];

const STARTER = {
  positions: [
    'Production Supervisor', 'Production Manager', 'Production Operator', 'Finance Staff', 'Accounting Staff', 'HR Recruiter', 'HR Staff',
    'IT Support Specialist', 'Sales Executive', 'Digital Marketing Specialist', 'Quality Assurance Manager', 'Quality Control Staff',
    'Warehouse Supervisor', 'Purchasing Staff', 'General Affairs Staff', 'Maintenance Technician',
  ],
  departments: [
    'Manufacturing', 'Production', 'Quality', 'Finance', 'Human Resources', 'IT', 'Sales', 'Marketing',
    'Warehouse & Logistics', 'Procurement', 'Engineering', 'General Affairs', 'Operations',
  ],
  'job-levels': [
    { name: 'Operator', value: 1 }, { name: 'Staff', value: 2 }, { name: 'Senior Staff', value: 3 }, { name: 'Supervisor', value: 4 },
    { name: 'Assistant Manager', value: 5 }, { name: 'Manager', value: 6 }, { name: 'Senior Manager', value: 7 }, { name: 'Director', value: 8 },
  ],
  locations: ['Jakarta', 'Tangerang', 'Tangerang Selatan', 'Bekasi', 'Bogor', 'Depok', 'Bandung', 'Surabaya', 'Semarang', 'Yogyakarta', 'Medan', 'Remote'],
  'education-levels': [
    { name: 'SMA/SMK', value: 1, description: 'Sekolah Menengah Atas / Kejuruan', system: true },
    { name: 'D3', value: 2, description: 'Diploma 3', system: true },
    { name: 'S1', value: 3, description: 'Sarjana (Strata 1) / D4', system: true },
    { name: 'S2', value: 4, description: 'Magister', system: true },
    { name: 'S3', value: 5, description: 'Doktor', system: true },
  ],
  'gpa-standards': [
    { name: 'Standar Minimum Umum', value: 2.5, description: 'Batas bawah untuk semua posisi' },
    { name: 'Fresh Graduate', value: 2.75, description: 'Lulusan baru' },
    { name: 'Universitas Tier 1', value: 3.0, description: 'Mengikuti standar universitas Tier 1' },
    { name: 'Management Trainee', value: 3.25, description: 'Program pengembangan talenta muda' },
  ],
  certifications: [...KNOWN_CERTIFICATIONS],
  'hard-skills': [...TECHNICAL_SKILL_LIBRARY],
  'soft-skills': [
    'Leadership', 'Communication', 'Teamwork', 'Problem Solving', 'Adaptability', 'Time Management', 'Collaboration',
    'Critical Thinking', 'Public Speaking', 'Negotiation', 'Attention to Detail', 'Integrity',
  ],
  'cv-sources': [
    'Job Portal', 'LinkedIn', 'Company Website', 'Email', 'Employee Referral', 'Recruitment Agency',
    'Walk-in', 'Internal Candidate', 'Job Fair', 'Manual Upload', 'Historical CV',
  ],
};

export const normKey = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const cleanName = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

const masterDict = (m) => ({
  id: m.id, category: m.category, name: m.name, value: m.value ?? null, description: m.description ?? null,
  system: !!m.system, active: m.active, source: m.source, created_by: m.created_by, created_at: m.created_at,
});

function findMaster(category, name) {
  const k = normKey(name);
  return DB.find('knowledge_master', m => m.category === category && normKey(m.name) === k);
}

function insertMaster(category, { name, value = null, description = null, system = false }, source, by = null) {
  return DB.insert('knowledge_master', {
    category, name: cleanName(name), value: value ?? null, description: description || null, system: !!system,
    active: true, source, created_by: by || ownerName(), created_at: nowIso(), updated_at: nowIso(),
  });
}

/** Adds the value(s) that are missing from a category. Never reactivates or edits. Returns the names actually added. */
export function registerMasterValues(category, values, source = 'auto') {
  if (!CAT[category]) return [];
  const added = [];
  for (const v of [].concat(values ?? [])) {
    const name = cleanName(v);
    if (!name || findMaster(category, name)) continue;
    insertMaster(category, { name }, source, 'System');
    added.push(name);
  }
  return added;
}

// ------------------------------------------------------------- seeding -----

const SEED_VERSION = 1;

export function masterSeedNeeded() { return !!DB.getMeta('profile', null) && !DB.getMeta('master_seed', null); }

/**
 * Starter lists + everything that already exists in the workspace (vacancies, templates, employees, candidate
 * sources), so an upgraded workspace immediately has a complete reference. MUST run inside DB.run().
 */
export function seedMasterNow() {
  if (DB.getMeta('master_seed', null)) return false;
  for (const cat of MASTER_CATEGORIES) {
    for (const raw of STARTER[cat.slug] || []) {
      const item = typeof raw === 'string' ? { name: raw } : raw;
      if (!findMaster(cat.slug, item.name)) insertMaster(cat.slug, item, 'starter', 'System');
    }
  }
  for (const v of [...DB.all('job_requirements'), ...DB.all('knowledge_job_criteria')]) {
    registerMasterValues('positions', v.position);
    registerMasterValues('departments', v.department);
    registerMasterValues('job-levels', v.job_level);
    registerMasterValues('locations', v.location);
    registerMasterValues('hard-skills', v.technical_skills);
    registerMasterValues('soft-skills', v.soft_skills);
    registerMasterValues('certifications', v.certifications_required);
  }
  for (const e of DB.all('employees')) {
    registerMasterValues('positions', e.position);
    registerMasterValues('departments', e.department);
    registerMasterValues('locations', e.location);
  }
  for (const c of DB.all('candidates')) registerMasterValues('cv-sources', c.source);
  DB.setMeta('master_seed', { version: SEED_VERSION, at: nowIso() });
  return true;
}

let seeding = null;
/** Async guard for read routes and app start-up: seeds once, inside its own transaction. */
export async function ensureMasterData() {
  if (!masterSeedNeeded()) return;
  if (!seeding) seeding = DB.run(async () => { seedMasterNow(); }).finally(() => { seeding = null; });
  await seeding;
}

// -------------------------------------------------------------- helpers ----

const activeOnly = (q) => q.active_only === undefined || q.active_only === 'true' || q.active_only === '1';

function sortMaster(cat, rows) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  if (cat === 'education-levels') return rows.sort((a, b) => (a.value ?? 0) - (b.value ?? 0) || byName(a, b));
  if (cat === 'job-levels') return rows.sort((a, b) => (a.value ?? 1e9) - (b.value ?? 1e9) || byName(a, b));
  if (cat === 'gpa-standards') return rows.sort((a, b) => (a.value ?? 0) - (b.value ?? 0) || byName(a, b));
  return rows.sort(byName);
}

/** {level: rank} for education levels that are NOT built in — handed to the screening engine. */
export function educationRanks() {
  const out = {};
  for (const m of DB.filter('knowledge_master', x => x.category === 'education-levels')) {
    if (!EDU_SYSTEM.includes(m.name) && Number.isFinite(m.value)) out[m.name] = m.value;
  }
  return out;
}

function parseValue(cat, raw, { required } = {}) {
  const def = CAT[cat];
  if (!def.valueLabel) return null;
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    if (def.valueRequired || required) throw new HttpError(400, `${def.valueLabel} wajib diisi untuk ${def.label}.`);
    return null;
  }
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(',', '.'));
  if (!Number.isFinite(n)) throw new HttpError(400, `${def.valueLabel} harus berupa angka.`);
  if (cat === 'gpa-standards' && (n < 0 || n > 4)) throw new HttpError(400, 'IPK minimum harus antara 0 dan 4.');
  if (cat === 'education-levels' && n <= 0) throw new HttpError(400, 'Peringkat pendidikan harus lebih dari 0.');
  return n;
}

// --------------------------------------------------------------- routes ----

route('GET', '/api/knowledge/master/categories', async () => {
  await ensureMasterData();
  return MASTER_CATEGORIES.map(c => {
    const rows = DB.filter('knowledge_master', m => m.category === c.slug);
    return {
      slug: c.slug, label: c.label, group: c.group, group_label: MASTER_GROUPS[c.group], description: c.description,
      value_label: c.valueLabel || null, value_hint: c.valueHint || null, value_required: !!c.valueRequired,
      count_active: rows.filter(r => r.active).length, count_total: rows.length,
    };
  });
}, { tx: false });

/** Everything the pickers need in ONE call: {slug: [{name, value}]} (active items only). */
route('GET', '/api/knowledge/master/options', async () => {
  await ensureMasterData();
  const out = {};
  for (const c of MASTER_CATEGORIES) {
    out[c.slug] = sortMaster(c.slug, DB.filter('knowledge_master', m => m.category === c.slug && m.active)).map(m => ({ name: m.name, value: m.value ?? null }));
  }
  out.universities = DB.filter('knowledge_universities', u => u.active).sort((a, b) => a.name.localeCompare(b.name)).map(u => ({ name: u.name, value: u.min_gpa ?? null }));
  return out;
}, { tx: false });

route('GET', '/api/knowledge/master', async ({ query }) => {
  await ensureMasterData();
  const cat = query.category;
  if (!CAT[cat]) throw new HttpError(400, 'Kategori Knowledge Center tidak dikenal.');
  let rows = DB.filter('knowledge_master', m => m.category === cat);
  if (activeOnly(query)) rows = rows.filter(m => m.active);
  if (query.q) { const k = normKey(query.q); rows = rows.filter(m => normKey(m.name).includes(k) || normKey(m.description).includes(k)); }
  return sortMaster(cat, rows).map(masterDict);
}, { tx: false });

route('POST', '/api/knowledge/master', async ({ body }) => {
  seedMasterNow();
  const cat = body.category;
  if (!CAT[cat]) throw new HttpError(400, 'Kategori Knowledge Center tidak dikenal.');
  const name = cleanName(body.name);
  if (!name) throw new HttpError(400, 'Nama tidak boleh kosong.');
  if (name.length > 120) throw new HttpError(400, 'Nama maksimal 120 karakter.');
  const dup = findMaster(cat, name);
  if (dup) throw new HttpError(400, `'${dup.name}' sudah ada di ${CAT[cat].label}${dup.active ? '' : ' (berstatus nonaktif — aktifkan kembali dari daftar)'}.`);
  const value = parseValue(cat, body.value);
  const m = insertMaster(cat, { name, value, description: String(body.description || '').trim() }, 'manual');
  logAudit('KnowledgeMaster', m.id, 'CREATE', ownerName(), `${CAT[cat].label}: '${m.name}' ditambahkan`);
  return masterDict(m);
});

route('PUT', '/api/knowledge/master/:id', async ({ params, body }) => {
  const m = requireFound(DB.get('knowledge_master', params.id), 'Item Knowledge Center tidak ditemukan.');
  const def = CAT[m.category];
  if ('name' in body) {
    const name = cleanName(body.name);
    if (!name) throw new HttpError(400, 'Nama tidak boleh kosong.');
    if (name.length > 120) throw new HttpError(400, 'Nama maksimal 120 karakter.');
    if (m.system && name !== m.name) throw new HttpError(400, `'${m.name}' adalah level bawaan — namanya tidak dapat diubah.`);
    const dup = findMaster(m.category, name);
    if (dup && dup.id !== m.id) throw new HttpError(400, `'${dup.name}' sudah ada di ${def.label}.`);
    m.name = name;
  }
  if ('value' in body) {
    const v = parseValue(m.category, body.value);
    if (m.system && v !== m.value) throw new HttpError(400, `Peringkat '${m.name}' adalah bawaan — tidak dapat diubah.`);
    m.value = v;
  }
  if ('description' in body) m.description = String(body.description || '').trim() || null;
  m.updated_at = nowIso();
  DB.save('knowledge_master', m);
  logAudit('KnowledgeMaster', m.id, 'UPDATE', ownerName(), `${def.label}: '${m.name}' diubah`);
  return masterDict(m);
});

route('DELETE', '/api/knowledge/master/:id', async ({ params }) => {
  const m = requireFound(DB.get('knowledge_master', params.id), 'Item Knowledge Center tidak ditemukan.');
  if (m.system) throw new HttpError(400, `'${m.name}' adalah level bawaan dan tidak dapat dinonaktifkan.`);
  m.active = false; m.updated_at = nowIso();
  DB.save('knowledge_master', m);
  logAudit('KnowledgeMaster', m.id, 'DEACTIVATE', ownerName(), `${CAT[m.category].label}: '${m.name}' dinonaktifkan`);
  return { status: 'ok' };
});

route('POST', '/api/knowledge/master/:id/activate', async ({ params }) => {
  const m = requireFound(DB.get('knowledge_master', params.id), 'Item Knowledge Center tidak ditemukan.');
  m.active = true; m.updated_at = nowIso();
  DB.save('knowledge_master', m);
  logAudit('KnowledgeMaster', m.id, 'ACTIVATE', ownerName(), `${CAT[m.category].label}: '${m.name}' diaktifkan kembali`);
  return { status: 'ok' };
});

// ------------------------------------------------------- import / template --

const headersFor = (c) => (c.valueLabel ? ['Name', c.valueLabel, 'Description'] : ['Name', 'Description']);
const widthFor = (c) => (c.valueLabel ? 3 : 2);
const sheetTitle = (c) => c.label;

function notesFor(list) {
  const lines = [
    'PETUNJUK IMPORT MASTER DATA KNOWLEDGE CENTER — MRI', '',
    '1. Jangan mengubah nama sheet maupun urutan/nama kolom pada baris pertama.',
    '2. Baris kedua adalah CONTOH — hapus atau timpa sebelum import.',
    '3. Kolom wajib: Name. Nama yang sudah ada (tanpa membedakan huruf besar/kecil) ditandai Duplicate dan dilewati.',
  ];
  for (const c of list) if (c.valueLabel) lines.push(`4. Sheet '${c.label}': kolom '${c.valueLabel}' — ${c.valueHint}${c.valueRequired ? ' (WAJIB)' : ''}.`);
  lines.push('5. Item yang diimport langsung tersedia sebagai pilihan di Job Requirement, Template Kriteria, CV Intake, dan filter CV Bank.');
  return lines;
}

async function readFileBuffer(file) {
  if (!file || (!file.name.toLowerCase().endsWith('.xlsx') && !file.name.toLowerCase().endsWith('.xlsm'))) throw new HttpError(400, 'File harus berformat .xlsx');
  const buf = await file.arrayBuffer();
  if (buf.byteLength === 0) throw new HttpError(400, 'File kosong.');
  return buf;
}

function emptySummary() { return { total_rows: 0, valid: 0, duplicate: 0, invalid: 0, imported_count: 0, errors: [], imported: [] }; }

function importRows(c, rows, sheetLabel = null) {
  const sum = emptySummary();
  const inFile = new Set();
  const tag = (o) => (sheetLabel ? { sheet: sheetLabel, ...o } : o);
  for (const { row: idx, cells } of rows) {
    if (rowIsBlank(cells)) continue;
    sum.total_rows++;
    const name = cleanName(cellText(cells, 0));
    if (!name) { sum.invalid++; sum.errors.push(tag({ row: idx, status: 'INVALID', reason: 'Name wajib diisi' })); continue; }
    if (name.length > 120) { sum.invalid++; sum.errors.push(tag({ row: idx, status: 'INVALID', reason: 'Name maksimal 120 karakter' })); continue; }
    const key = normKey(name);
    if (inFile.has(key) || findMaster(c.slug, name)) { sum.duplicate++; sum.errors.push(tag({ row: idx, status: 'DUPLICATE', reason: `'${name}' sudah ada` })); continue; }
    let value = null;
    try { value = parseValue(c.slug, c.valueLabel ? cells[1] : null); } catch (e) { sum.invalid++; sum.errors.push(tag({ row: idx, status: 'INVALID', reason: e.message })); continue; }
    const desc = cellText(cells, c.valueLabel ? 2 : 1);
    const m = insertMaster(c.slug, { name, value, description: desc }, 'import');
    inFile.add(key);
    sum.valid++; sum.imported.push({ row: idx, id: m.id, name });
  }
  sum.imported_count = sum.imported.length;
  return sum;
}

for (const c of MASTER_CATEGORIES) {
  route('GET', `/api/knowledge/master/${c.slug}/import-template.xlsx`, async () => fileResult(
    await buildMultiSheetTemplate([{ title: sheetTitle(c), headers: headersFor(c), example: c.example }], notesFor([c])),
    `MRI_Master_${c.slug}_Template.xlsx`, XLSX_MIME,
  ), { tx: false });

  route('POST', `/api/knowledge/master/${c.slug}/import`, async ({ body }) => {
    seedMasterNow();
    const file = body.get('file');
    const buf = await readFileBuffer(file);
    let rows;
    try { rows = await readWorkbookRows(buf, sheetTitle(c), widthFor(c)); } catch (exc) { throw new HttpError(400, `Gagal membaca file Excel: ${exc.message || exc}`); }
    const sum = importRows(c, rows);
    logAudit('KnowledgeMaster', 0, 'EXCEL_IMPORT', ownerName(), `${c.label}: ${sum.valid} imported, ${sum.duplicate} duplicate, ${sum.invalid} invalid`, { filename: file.name, category: c.slug });
    return sum;
  });
}

route('GET', '/api/knowledge/master/import-template-all.xlsx', async () => fileResult(
  await buildMultiSheetTemplate(MASTER_CATEGORIES.map(c => ({ title: sheetTitle(c), headers: headersFor(c), example: c.example })), notesFor(MASTER_CATEGORIES)),
  'MRI_Master_Data_Template.xlsx', XLSX_MIME,
), { tx: false });

route('POST', '/api/knowledge/master/import-all', async ({ body }) => {
  seedMasterNow();
  const file = body.get('file');
  const buf = await readFileBuffer(file);
  let sheets;
  try { sheets = await readWorkbookSheets(buf, 3); } catch (exc) { throw new HttpError(400, `Gagal membaca file Excel: ${exc.message || exc}`); }
  const total = emptySummary();
  const perCategory = [];
  let matched = 0;
  for (const c of MASTER_CATEGORIES) {
    const rows = sheets.get(sheetTitle(c));
    if (!rows) continue;
    matched++;
    // sheets have up to 3 columns; categories without a value column only use the first two
    const sum = importRows(c, rows, c.label);
    perCategory.push({ slug: c.slug, label: c.label, total_rows: sum.total_rows, valid: sum.valid, duplicate: sum.duplicate, invalid: sum.invalid });
    for (const k of ['total_rows', 'valid', 'duplicate', 'invalid', 'imported_count']) total[k] += sum[k];
    total.errors.push(...sum.errors); total.imported.push(...sum.imported);
  }
  if (!matched) throw new HttpError(400, `Tidak ada sheet yang dikenali. Gunakan template dari tombol "Download Template Semua Master Data" (nama sheet: ${MASTER_CATEGORIES.map(c => c.label).join(', ')}).`);
  logAudit('KnowledgeMaster', 0, 'EXCEL_IMPORT', ownerName(), `Semua kategori: ${total.valid} imported, ${total.duplicate} duplicate, ${total.invalid} invalid`, { filename: file.name });
  return { ...total, by_category: perCategory };
});
