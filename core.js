/*
 * MRI Personal Workspace — service core.
 *
 * The old app was a FastAPI server; the UI talked to it with fetch('/api/…').
 * To keep the UI and every JSON response shape unchanged, the "server" now
 * lives in the browser: api(path, options) matches the same URL patterns and
 * runs the handler against the local IndexedDB (see db.js). No network.
 *
 * Personal workspace: there are no accounts, roles or workspaces any more —
 * one person, one browser profile. The reviewer name on HR decisions and
 * stage records is the workspace owner's name from the profile.
 */
import * as DB from './db.js';
import { HttpError, nowIso, deepClone } from './util.js';
import { verifyLicenseText, LicenseError } from './license.js';
import { CONFIG } from '../config.js';

export { HttpError };

// ---------------------------------------------------------------- routing --

const routes = [];

/** pattern like '/api/candidates/:id' ; ':id' matches digits only. */
export function route(method, pattern, handler, { tx = method !== 'GET' } = {}) {
  const keys = [];
  const src = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([a-z_]+)/g, (_, k) => { keys.push(k); return '(\\d+)'; });
  routes.push({ method, re: new RegExp(`^${src}$`), keys, handler, tx });
}

export function isFileResult(v) { return v && v.__file === true; }

export function fileResult(bytes, filename, type) {
  return { __file: true, blob: new Blob([bytes], { type }), filename, type };
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PDF_MIME = 'application/pdf';

/**
 * Same contract as the old fetch-based helper: resolves with the JSON body,
 * rejects with Error(message) on failure. `options.body` is a JSON string or
 * a FormData.
 */
export async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const url = new URL(path, 'http://local');
  const query = {};
  for (const [k, v] of url.searchParams.entries()) query[k] = v;

  let body = options.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }

  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = Number(m[i + 1]); });
    const call = () => r.handler({ params, query, body });
    const result = r.tx ? await DB.run(call) : await call();
    if (isFileResult(result)) return result;
    return result === undefined ? undefined : deepClone(result);
  }
  throw new HttpError(404, `Endpoint tidak ditemukan: ${method} ${url.pathname}`);
}

// ------------------------------------------------------------ small helpers --

export const ilike = (haystack, needle) => haystack !== null && haystack !== undefined && String(haystack).toLowerCase().includes(String(needle).toLowerCase());

export function byNewest(a, b, key = 'created_at') {
  if (a[key] === b[key]) return b.id - a.id;
  return a[key] < b[key] ? 1 : -1;
}

export function requireFound(row, message) {
  if (!row) throw new HttpError(404, message);
  return row;
}

// ---------------------------------------------------------------- profile --

export function getProfile() {
  return DB.getMeta('profile', null);
}

export function ownerName() {
  const p = getProfile();
  return (p && p.full_name) || 'Pemilik Workspace';
}

// ------------------------------------------------------------------ audit --

export function logAudit(entityType, entityId, action, who, why = '', details = {}) {
  DB.insert('audit_trail', {
    entity_type: entityType, entity_id: entityId, action, who, when: nowIso(), why, details: details || {},
  });
}

// ------------------------------------------------------------ plan / limits --

export const PLAN_LIMITS = {
  DEMO: {
    label: 'Demo', max_candidates: 15, max_job_requirements: 3,
    export_reports: false, advanced_analytics: false, knowledge_center: true,
  },
  PREMIUM: {
    label: 'Premium', max_candidates: 500, max_job_requirements: 50,
    export_reports: true, advanced_analytics: true, knowledge_center: true,
  },
  VIP: {
    label: 'VIP', max_candidates: null, max_job_requirements: null,
    export_reports: true, advanced_analytics: true, knowledge_center: true,
  },
};

let verifiedCache = { text: null, payload: null };

/**
 * The effective plan is ALWAYS derived from re-verifying the stored
 * activation code — never from a stored "plan" field — so editing the
 * database by hand cannot switch a workspace to Premium/VIP.
 */
export async function currentPlan() {
  const lic = DB.getMeta('license', null);
  if (!lic || !lic.license_text) return { plan: 'DEMO', license: null, invalid: false };
  try {
    if (verifiedCache.text !== lic.license_text) {
      verifiedCache = { text: lic.license_text, payload: await verifyLicenseText(lic.license_text, CONFIG.PUBLIC_KEY_HEX) };
    }
    return { plan: verifiedCache.payload.plan, license: lic, invalid: false };
  } catch (err) {
    if (err instanceof LicenseError) return { plan: 'DEMO', license: lic, invalid: true };
    throw err;
  }
}

export function resetPlanCache() { verifiedCache = { text: null, payload: null }; }

export async function planLimits() {
  const { plan } = await currentPlan();
  return { plan, limits: PLAN_LIMITS[plan] };
}

export async function requireFeature(feature, featureLabel) {
  const { limits } = await planLimits();
  if (!limits[feature]) {
    throw new HttpError(402, `${featureLabel} tidak tersedia di paket ${limits.label}. Upgrade ke Premium/VIP untuk membuka fitur ini.`);
  }
}

export async function checkCountLimit(currentCount, limitKey, itemLabel) {
  const { limits } = await planLimits();
  const limit = limits[limitKey];
  if (limit !== null && limit !== undefined && currentCount >= limit) {
    throw new HttpError(402, `Batas ${itemLabel} paket ${limits.label} tercapai (${limit}). Upgrade ke Premium/VIP untuk menambah kapasitas.`);
  }
}

// -------------------------------------------------------- shared shapes ----

export function candidateToScoringDict(c) {
  return {
    highest_education: c.highest_education,
    total_experience_years: c.total_experience_years || 0,
    skills: c.skills.map(s => s.skill_name),
    certifications: c.certifications.map(x => x.name),
    has_leadership_experience: c.experiences.some(e => e.is_leadership),
  };
}

export function vacancyToDict(v) {
  return {
    position: v.position, min_education: v.min_education,
    min_experience_years: v.min_experience_years,
    technical_skills: v.technical_skills || [], soft_skills: v.soft_skills || [],
    leadership_required: v.leadership_required,
    certifications_required: v.certifications_required || [],
    mandatory_criteria: v.mandatory_criteria || [],
    criteria_weights: v.criteria_weights || {},
    minimum_score: v.minimum_score, passing_score: v.passing_score,
  };
}

export function candidateSummary(c) {
  return {
    id: c.id, name: c.name, email: c.email, phone: c.phone,
    location: c.location, total_experience_years: c.total_experience_years,
    highest_education: c.highest_education, source: c.source,
    created_at: c.created_at,
    skills: c.skills.map(s => s.skill_name),
    certifications: c.certifications.map(x => x.name),
  };
}

export const DEFAULT_STAGES = [
  ['CV_SCREENING', 'CV Screening', 1, false, false],
  ['HR_INTERVIEW', 'HR Interview', 2, true, true],
  ['ASSESSMENT', 'Assessment', 3, true, true],
  ['USER_INTERVIEW', 'User Interview', 4, true, true],
  ['OFFERING', 'Offering', 5, false, true],
  ['MEDICAL', 'Medical', 6, false, true],
  ['HIRED', 'Hired', 7, false, false],
];
export const DEFAULT_EMPLOYMENT_TYPES = ['Permanent', 'Contract', 'Probation', 'Outsource', 'Internship', 'Daily Worker', 'Other'];
export const DEFAULT_EMPLOYMENT_STATUSES = ['Active', 'Inactive', 'Resigned', 'Terminated', 'Retired', 'Other'];

export function toFloatOrThrow(v, message) {
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) throw new HttpError(400, message);
  return n;
}

export const cellText = (row, i) => (i < row.length && row[i] !== null && row[i] !== undefined ? String(row[i]).trim() : '');
export const rowIsBlank = (row) => row.every(v => v === null || v === undefined || String(v).trim() === '');
