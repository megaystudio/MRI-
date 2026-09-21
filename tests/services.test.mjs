// Replays the scenario recorded from the ORIGINAL FastAPI backend against the new in-browser services.
import 'fake-indexeddb/auto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.__MRI_DOMParser = require('@xmldom/xmldom').DOMParser;

import { CONFIG } from '../config.js';
import { openWorkspace, api, DB } from '../js/services.js';

const dir = process.argv[2] || '/tmp/scenario';
const cvDir = process.argv[3] || '/tmp/cvfiles';
const lic = JSON.parse(fs.readFileSync(process.argv[4] || '/tmp/licenses.json', 'utf8'));
CONFIG.PUBLIC_KEY_HEX = lic.pub;
const steps = JSON.parse(fs.readFileSync(path.join(dir, 'steps.json'), 'utf8'));
const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected_obs.json'), 'utf8'));

// Keys whose values are time-dependent, or that intentionally differ in the personal (no-login) edition.
const IGNORE = new Set(['created_at', 'uploaded_at', 'processed_at', 'added_date', 'event_date', 'review_date', 'when', 'upload_date', 'created_date',
  'updated_date', 'activated_at', 'duration_seconds', 'last_login_at', 'max_users', 'users', 'license_invalid', 'created_by',
  'who']); // 'who': the old server logged the login username, the personal edition logs the owner's name

function norm(v, ctx = {}) {
  if (Array.isArray(v)) return v.map(x => norm(x, ctx));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) if (!IGNORE.has(k)) o[k] = norm(v[k], ctx);
    return o;
  }
  if (typeof v === 'number') return Math.round(v * 1e9) / 1e9;
  return v;
}
function firstDiff(a, b, p = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return `${p}: expected ${JSON.stringify(a)} got ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${p}: array/object mismatch`;
  if (Array.isArray(a) && a.length !== b.length) return `${p}: length expected ${a.length} got ${b.length}`;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${p}.${k}`); if (d) return d; }
  return null;
}

await openWorkspace('scenario-test');
await api('/api/profile/setup', { method: 'POST', body: JSON.stringify({ full_name: 'Tester Person', workspace_name: 'WS' }) });

async function call(step) {
  const opts = { method: step.m };
  if (step.json) opts.body = JSON.stringify(step.json);
  if (step.file) {
    const buf = fs.readFileSync(step.file);
    const fd = new FormData();
    fd.append('file', new File([buf], path.basename(step.file)));
    for (const [k, v] of Object.entries(step.form || {})) fd.append(k, v);
    opts.body = fd;
  }
  try { return { status: 200, body: await api(step.p, opts) }; }
  catch (e) { return { status: e.status || 500, body: { detail: e.message } }; }
}

const got = {};
for (const s of steps) {
  if (s.kind === 'macro_screen_all') {
    const cands = (await api('/api/candidates')).map(c => c.id).sort((a, b) => a - b);
    const out = [];
    for (const vid of [1, 2, 3]) for (const cid of cands) {
      const r = await call({ m: 'POST', p: '/api/screening/run', json: { candidate_id: cid, vacancy_id: vid } });
      out.push([cid, vid, r.status, r.body]);
    }
    got.screen_all = { status: 200, body: out };
  } else if (s.kind === 'macro_decide') {
    const plan = [[1, 'PASS', 'kuat'], [2, 'TALENT_POOL', 'simpan'], [3, 'REJECT', 'kurang'], [4, 'HOLD', 'tunggu'], [5, 'PASS', 'ok'], [6, 'TALENT_POOL', 'pool']];
    const out = [];
    for (const [sid, dec, reason] of plan) { const r = await call({ m: 'POST', p: '/api/hr-decision', json: { screening_id: sid, decision: dec, reason, remarks: 'r' } }); out.push([sid, dec, r.status, r.body]); }
    const r = await call({ m: 'POST', p: '/api/hr-decision', json: { screening_id: 1, decision: 'MAYBE', reason: 'x' } });
    out.push([1, 'MAYBE', r.status, r.body]);
    got.decide = { status: 200, body: out };
  } else {
    got[s.tag] = await call(s);
  }
}

let bad = 0, checked = 0;
const failures = [];
for (const [tag, exp] of Object.entries(expected)) {
  const g = got[tag];
  checked++;
  if (!g) { bad++; failures.push(`${tag}: no result`); continue; }
  const step = steps.find(x => x.tag === tag) || {};
  if (tag === 'dashboard_with_demo_shape' || tag === 'demo_seed' || tag === 'demo_reset') {
    // demo data uses a different PRNG on purpose; only the shape/status must match
    const shape = (o) => (o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map(k => [k, typeof o[k] === 'object' && o[k] !== null && !Array.isArray(o[k]) ? shape(o[k]) : typeof o[k]])) : typeof o);
    const d = firstDiff({ status: exp.status, shape: shape(exp.body) }, { status: g.status, shape: shape(g.body) });
    if (d) { bad++; failures.push(`${tag}: ${d}`); }
    continue;
  }
  if (tag === 'audit') {
    const seq = (b) => b.filter(e => !(e.entity_type === 'Workspace' && e.action === 'WORKSPACE_CREATED')).map(e => `${e.entity_type}:${e.action}`);
    const e1 = seq(exp.body), g1 = seq(g.body);
    // DemoData rows carry different counts by design; compare sequence of (entity, action)
    if (JSON.stringify(e1) !== JSON.stringify(g1)) { bad++; failures.push(`audit: sequence differs\n  exp ${e1.length}: ${e1.slice(0, 12).join(' ')}...\n  got ${g1.length}: ${g1.slice(0, 12).join(' ')}...`); const n = Math.min(e1.length, g1.length); for (let i = 0; i < n; i++) if (e1[i] !== g1[i]) { failures.push(`  first difference at #${i}: exp ${e1[i]} got ${g1[i]}`); break; } }
    continue;
  }
  if (exp.status >= 400) {
    if (g.status !== exp.status || exp.body.detail !== g.body.detail) { bad++; failures.push(`${tag}: expected ${exp.status} ${JSON.stringify(exp.body.detail)} got ${g.status} ${JSON.stringify(g.body.detail)}`); }
    continue;
  }
  const d = firstDiff(norm({ status: exp.status, body: exp.body }), norm({ status: g.status, body: g.body }));
  if (d) { bad++; failures.push(`${tag}: ${d}`); }
}
// demo data uses a different PRNG on purpose: what was seeded must be exactly what reset removes
const seeded = got.demo_seed.body, removed = got.demo_reset.body;
if (seeded.candidates !== removed.candidates_deleted || seeded.vacancies !== removed.vacancies_deleted || seeded.employees !== removed.employees_deleted) {
  bad++; failures.push(`demo seed/reset mismatch: ${JSON.stringify(seeded)} vs ${JSON.stringify(removed)}`);
}
console.log(`${checked - bad}/${checked} observations identical to the original backend`);
for (const f of failures) console.log('  ✗', f);
process.exit(bad ? 1 : 0);
