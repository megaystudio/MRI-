/*
 * Employee Data Center services — port of the /api/employees* endpoints.
 * Candidate != Employee: an Employee is its own record, either converted from
 * a candidate that reached the HIRED stage, or imported from Excel.
 */
import * as DB from './db.js';
import {
  route, HttpError, ilike, byNewest, requireFound, ownerName, logAudit, fileResult, XLSX_MIME,
  rowIsBlank, cellText, DEFAULT_EMPLOYMENT_TYPES, DEFAULT_EMPLOYMENT_STATUSES,
} from './core.js';
import { buildExcelTemplate, readWorkbookRows } from './reports.js';
import { nowIso, contractDaysRemaining, isValidIsoDate } from './util.js';

export const EMPLOYEE_IMPORT_HEADERS = [
  'Employee Number', 'Full Name', 'Gender', 'Date of Birth', 'Phone', 'Email', 'Address',
  'Department', 'Division', 'Position', 'Supervisor', 'Join Date', 'Employment Type',
  'Employment Status', 'Contract Start Date', 'Contract End Date', 'Location', 'Work Site', 'Education', 'Notes',
];

export function employeeToDict(e) {
  const v = e.source_vacancy_id ? DB.get('job_requirements', e.source_vacancy_id) : null;
  return {
    id: e.id, candidate_id: e.candidate_id, employee_number: e.employee_number, full_name: e.full_name, gender: e.gender,
    date_of_birth: e.date_of_birth, phone: e.phone, email: e.email, address: e.address, department: e.department,
    division: e.division, position: e.position, supervisor: e.supervisor, join_date: e.join_date,
    employment_type: e.employment_type, employment_status: e.employment_status, contract_start_date: e.contract_start_date,
    contract_end_date: e.contract_end_date, permanent_date: e.permanent_date, location: e.location, work_site: e.work_site,
    education: e.education, notes: e.notes, active_flag: e.active_flag, resigned_date: e.resigned_date,
    resignation_reason: e.resignation_reason, source_vacancy_id: e.source_vacancy_id,
    source_vacancy_position: v ? v.position : null, created_date: e.created_date, updated_date: e.updated_date,
  };
}

export function blankEmployee(fields) {
  return {
    candidate_id: null, source_vacancy_id: null, hired_stage_id: null, employee_number: null, full_name: null, gender: null,
    date_of_birth: null, phone: null, email: null, address: null, department: null, division: null, position: null,
    supervisor: null, join_date: null, employment_type: null, employment_status: 'Active', contract_start_date: null,
    contract_end_date: null, permanent_date: null, location: null, work_site: null, education: null, notes: null,
    active_flag: true, resigned_date: null, resignation_reason: null, is_demo: false,
    created_date: nowIso(), updated_date: nowIso(), ...fields,
  };
}

route('GET', '/api/employee-options', async () => {
  const out = { employment_type: [], employment_status: [] };
  for (const r of DB.filter('employee_options', o => o.active).sort((a, b) => a.category.localeCompare(b.category) || a.sequence - b.sequence)) {
    (out[r.category] = out[r.category] || []).push(r.label);
  }
  return out;
});

route('POST', '/api/employees/from-candidate', async ({ body }) => {
  const candidate = requireFound(DB.get('candidates', body.candidate_id), 'Kandidat tidak ditemukan.');
  const hired = DB.filter('recruitment_stages', s => s.candidate_id === body.candidate_id && s.stage_code === 'HIRED' && s.status !== 'CANCELLED')
    .sort((a, b) => byNewest(a, b, 'event_date'))[0];
  if (!hired) throw new HttpError(400, 'Kandidat belum mencapai tahap HIRED pada Recruitment Stage — Employee hanya dapat dibuat dari kandidat yang sudah dinyatakan Hired.');
  const existing = DB.find('employees', e => e.candidate_id === body.candidate_id);
  if (existing) return { already_existed: true, employee: employeeToDict(existing) };
  const vac = DB.get('job_requirements', hired.vacancy_id);
  const emp = DB.insert('employees', blankEmployee({
    candidate_id: candidate.id, source_vacancy_id: hired.vacancy_id, hired_stage_id: hired.id,
    employee_number: body.employee_number ?? null, full_name: candidate.name, gender: body.gender ?? null,
    date_of_birth: body.date_of_birth ?? null, phone: candidate.phone, email: candidate.email, address: body.address ?? null,
    department: body.department ?? null, division: body.division ?? null, position: body.position || (vac ? vac.position : null),
    supervisor: body.supervisor ?? null, join_date: body.join_date ?? null, employment_type: body.employment_type ?? null,
    employment_status: body.employment_status || 'Active', contract_start_date: body.contract_start_date ?? null,
    contract_end_date: body.contract_end_date ?? null, permanent_date: body.permanent_date ?? null,
    location: body.location ?? null, work_site: body.work_site ?? null, education: candidate.highest_education, notes: body.notes ?? null,
  }));
  logAudit('Employee', emp.id, 'EMPLOYEE_CREATED', ownerName(), `Converted from Candidate #${candidate.id} (hired stage #${hired.id})`, { candidate_id: candidate.id });
  return { already_existed: false, employee: employeeToDict(emp) };
});

route('GET', '/api/employees', async ({ query }) => {
  let rows = DB.all('employees');
  if (query.q) rows = rows.filter(e => ilike(e.full_name, query.q));
  for (const f of ['department', 'division', 'position', 'employment_type', 'employment_status', 'location']) {
    if (query[f]) rows = rows.filter(e => e[f] === query[f]);
  }
  const total = rows.length;
  const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
  const pageSize = Math.max(1, Math.min(parseInt(query.page_size || '20', 10) || 20, 200));
  rows.sort((a, b) => byNewest(a, b, 'created_date'));
  const slice = rows.slice((page - 1) * pageSize, page * pageSize);
  return {
    total, page, page_size: pageSize,
    employees: slice.map(e => ({ ...employeeToDict(e), contract_days_remaining: contractDaysRemaining(e.contract_end_date) })),
  };
});

route('GET', '/api/employees/import-template.xlsx', async () => {
  const example = [
    'EMP-0001', 'Budi Santoso', 'Male', '1990-05-14', '081234567890', 'budi.santoso@example.com',
    'Jl. Contoh No. 1, Jakarta', 'Manufacturing', 'Production', 'Production Supervisor', 'Andi Wijaya',
    '2022-01-10', 'Permanent', 'Active', '', '', 'Tangerang', 'Plant A', 'S1', 'Contoh catatan (opsional)',
  ];
  const notes = [
    'PETUNJUK IMPORT EMPLOYEE DATA — MRI', '',
    "1. Jangan mengubah urutan atau nama kolom pada baris pertama sheet 'Employees'.",
    '2. Baris kedua (miring/abu-abu) adalah CONTOH — hapus atau timpa sebelum import.',
    '3. Kolom wajib diisi: Full Name, Department, Employment Type, Employment Status.',
    '4. Format tanggal: YYYY-MM-DD (contoh: 2024-01-31). Kosongkan jika tidak ada.',
    `5. Employment Type harus salah satu dari: ${DEFAULT_EMPLOYMENT_TYPES.join(', ')}`,
    `6. Employment Status harus salah satu dari: ${DEFAULT_EMPLOYMENT_STATUSES.join(', ')}`,
    '7. Baris dengan Employee Number ATAU (Full Name + Email) yang sudah ada di sistem akan ditandai Duplicate dan dilewati.',
    '8. Baris dengan data wajib kosong atau format tidak valid akan ditandai Invalid — tidak diimport.',
  ];
  return fileResult(await buildExcelTemplate('Employees', EMPLOYEE_IMPORT_HEADERS, example, notes), 'MRI_Employee_Import_Template.xlsx', XLSX_MIME);
}, { tx: false });

route('POST', '/api/employees/import', async ({ body }) => {
  const file = body.get('file');
  if (!file || !/\.(xlsx|xlsm)$/i.test(file.name)) throw new HttpError(400, 'File harus berformat .xlsx');
  const buf = await file.arrayBuffer();
  if (buf.byteLength === 0) throw new HttpError(400, 'File kosong.');
  let rows;
  try { rows = await readWorkbookRows(buf, 'Employees', 20); } catch (exc) { throw new HttpError(400, `Gagal membaca file Excel: ${exc.message || exc}`); }

  const validTypes = new Set(DEFAULT_EMPLOYMENT_TYPES), validStatuses = new Set(DEFAULT_EMPLOYMENT_STATUSES);
  let total = 0, valid = 0, dup = 0, invalid = 0;
  const errors = [], imported = [];

  for (const { row: idx, cells } of rows) {
    if (rowIsBlank(cells)) continue;
    total++;
    const c = (i) => cellText(cells, i);
    const [employeeNumber, fullName, gender, dob, phone, email, address, department, division, position, supervisor,
      joinDate, employmentType, employmentStatus, contractStart, contractEnd, location, workSite, education, notes] = Array.from({ length: 20 }, (_, i) => c(i));

    const rowErrors = [];
    if (!fullName) rowErrors.push('Full Name wajib diisi');
    if (!department) rowErrors.push('Department wajib diisi');
    if (!employmentType) rowErrors.push('Employment Type wajib diisi');
    else if (!validTypes.has(employmentType)) rowErrors.push(`Employment Type '${employmentType}' tidak dikenal`);
    if (employmentStatus && !validStatuses.has(employmentStatus)) rowErrors.push(`Employment Status '${employmentStatus}' tidak dikenal`);
    for (const [label, val] of [['Date of Birth', dob], ['Join Date', joinDate], ['Contract Start Date', contractStart], ['Contract End Date', contractEnd]]) {
      if (val && !isValidIsoDate(val)) rowErrors.push(`${label} harus format YYYY-MM-DD (nilai: '${val}')`);
    }
    if (rowErrors.length) { invalid++; errors.push({ row: idx, status: 'INVALID', reason: rowErrors.join('; ') }); continue; }

    let existing = null;
    if (employeeNumber) existing = DB.find('employees', e => e.employee_number === employeeNumber);
    if (!existing && email) existing = DB.find('employees', e => e.full_name === fullName && e.email === email);
    if (existing) { dup++; errors.push({ row: idx, status: 'DUPLICATE', reason: `Sudah ada sebagai Employee #${existing.id}` }); continue; }

    const emp = DB.insert('employees', blankEmployee({
      employee_number: employeeNumber || null, full_name: fullName, gender: gender || null, date_of_birth: dob || null,
      phone: phone || null, email: email || null, address: address || null, department, division: division || null,
      position: position || null, supervisor: supervisor || null, join_date: joinDate || null, employment_type: employmentType,
      employment_status: employmentStatus || 'Active', contract_start_date: contractStart || null, contract_end_date: contractEnd || null,
      location: location || null, work_site: workSite || null, education: education || null, notes: notes || null,
    }));
    valid++; imported.push({ row: idx, employee_id: emp.id, full_name: fullName });
  }
  logAudit('Employee', 0, 'EMPLOYEE_EXCEL_IMPORT', ownerName(), `${valid} imported, ${dup} duplicate, ${invalid} invalid`, { total_rows: total, filename: file.name });
  return { total_rows: total, valid, duplicate: dup, invalid, imported_count: imported.length, errors, imported };
});

route('GET', '/api/employees/:id', async ({ params }) => {
  const e = requireFound(DB.get('employees', params.id), 'Employee tidak ditemukan.');
  const candidate = e.candidate_id ? DB.get('candidates', e.candidate_id) : null;
  const vacPos = (id) => (DB.get('job_requirements', id) ? DB.get('job_requirements', id).position : null);
  const screenings = candidate ? DB.filter('screenings', s => s.candidate_id === e.candidate_id).sort((a, b) => byNewest(a, b, 'processed_at')) : [];
  const stages = candidate ? DB.filter('recruitment_stages', s => s.candidate_id === e.candidate_id)
    .sort((a, b) => (a.stage_sequence - b.stage_sequence) || (a.event_date < b.event_date ? -1 : 1)) : [];
  const audit = DB.filter('audit_trail', a => a.entity_type === 'Employee' && a.entity_id === e.id).sort((a, b) => byNewest(a, b, 'when'));
  return {
    employee: employeeToDict(e),
    contract_days_remaining: contractDaysRemaining(e.contract_end_date),
    recruitment_history: {
      candidate_id: e.candidate_id, candidate_name: candidate ? candidate.name : null,
      cvs: candidate ? DB.filter('cvs', c => c.candidate_id === candidate.id).map(cv => ({ filename: cv.filename, uploaded_at: cv.uploaded_at, source: cv.source })) : [],
      screenings: screenings.map(s => ({ vacancy_position: vacPos(s.vacancy_id), overall_score: s.overall_score, recommendation: s.recommendation, processed_at: s.processed_at, hr_decision: s.hr_decision ? s.hr_decision.decision : null })),
      stages: stages.map(st => ({ stage_code: st.stage_code, vacancy_position: vacPos(st.vacancy_id), overall_score: st.overall_score, decision: st.decision, status: st.status, event_date: st.event_date, reviewer: st.reviewer, reason: st.reason })),
    },
    audit_history: audit.map(a => ({ when: a.when, action: a.action, who: a.who, why: a.why, details: a.details })),
  };
});

const UPDATABLE = ['employee_number', 'full_name', 'gender', 'date_of_birth', 'phone', 'email', 'address', 'department', 'division', 'position',
  'supervisor', 'join_date', 'employment_type', 'employment_status', 'contract_start_date', 'contract_end_date', 'permanent_date',
  'location', 'work_site', 'notes', 'active_flag', 'resigned_date', 'resignation_reason'];

route('PUT', '/api/employees/:id', async ({ params, body }) => {
  const e = requireFound(DB.get('employees', params.id), 'Employee tidak ditemukan.');
  const changes = [];
  for (const f of UPDATABLE) {
    if (!(f in body)) continue;
    let nv = body[f];
    if (nv === '') nv = null;                       // an emptied text box means "no value", not a change from null
    if (e[f] !== nv) { changes.push({ field: f, old: e[f], new: nv }); e[f] = nv; }
  }
  if (changes.length) {
    e.updated_date = nowIso();
    DB.save('employees', e);
    logAudit('Employee', e.id, 'EMPLOYEE_UPDATED', ownerName(), `${changes.length} field(s) changed`, { changes });
  }
  return { status: 'ok', changed_fields: changes.length, employee: employeeToDict(e) };
});

route('DELETE', '/api/employees/:id', async ({ params }) => {
  const e = requireFound(DB.get('employees', params.id), 'Employee tidak ditemukan.');
  logAudit('Employee', e.id, 'EMPLOYEE_DELETED', ownerName(), 'Employee record dihapus', { deleted_record: employeeToDict(e) });
  DB.remove('employees', e.id);
  return { status: 'ok', deleted_id: params.id };
});

route('GET', '/api/dashboard/employee', async () => {
  const emps = DB.all('employees');
  const byType = {};
  for (const t of DEFAULT_EMPLOYMENT_TYPES) byType[t] = emps.filter(e => e.employment_type === t).length;
  let e7 = 0, e30 = 0, e60 = 0;
  for (const e of emps.filter(x => x.employment_status === 'Active' && x.contract_end_date)) {
    const d = contractDaysRemaining(e.contract_end_date);
    if (d === null) continue;
    if (d <= 7) e7++; else if (d <= 30) e30++; else if (d <= 60) e60++;
  }
  return {
    total_employees: emps.length, active_employees: emps.filter(e => e.employment_status === 'Active').length,
    by_employment_type: byType, contract_expiring_critical_7d: e7, contract_expiring_warning_30d: e30,
    contract_expiring_upcoming_60d: e60, follow_up_required: e7 + e30,
  };
});
