// Edge cases, limits, persistence, rollback, backup/restore, exports and the Drive client (against a mock Drive).
import 'fake-indexeddb/auto';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.__MRI_DOMParser = require('@xmldom/xmldom').DOMParser;

import { CONFIG } from '../config.js';
import { openWorkspace, api, apiFile, DB } from '../js/services.js';
import { resetPlanCache } from '../js/core.js';
import * as backup from '../js/backup.js';
import * as drive from '../js/drive.js';
import { getPdfJs, getExcelJS } from '../js/vendor.js';

const bad = '/tmp/badfiles', cvDir = '/tmp/cvfiles';
const lic = JSON.parse(fs.readFileSync('/tmp/licenses.json', 'utf8'));
const expectedBad = JSON.parse(fs.readFileSync('/tmp/bad_expected.json', 'utf8'));
CONFIG.PUBLIC_KEY_HEX = lic.pub;

let n = 0;
const ok = (name) => console.log(`✓ ${name}`);
const fd = (file, dir = bad, extra = {}) => { const f = new FormData(); f.append('file', new File([fs.readFileSync(path.join(dir, file))], file)); for (const [k, v] of Object.entries(extra)) f.append(k, v); return f; };
const upload = (file, dir = bad) => api('/api/cv/upload', { method: 'POST', body: fd(file, dir) });
const fresh = async (name) => { DB.close(); await DB.deleteDatabase(name); await openWorkspace(name); await api('/api/profile/setup', { method: 'POST', body: JSON.stringify({ full_name: 'Owner Test', workspace_name: 'Kantor Uji' }) }); resetPlanCache(); };
const err = async (p) => { try { await p; return null; } catch (e) { return e; } };

// ------------------------------------------------ 1. bad files + Demo limits
await fresh('t1');
for (const f of ['scanned.pdf', 'empty.txt', 'blank.txt', 'huge.txt', 'notes.rtf']) {
  const e = await err(upload(f));
  assert.ok(e, `${f} should be rejected`);
  assert.equal(e.message, expectedBad[f][1], `${f}: message differs from original backend`);
}
for (const f of ['encrypted.pdf', 'corrupt.pdf', 'fake.docx']) {
  const e = await err(upload(f));
  assert.ok(e && e.message.startsWith('Gagal membaca isi file'), `${f}: ${e && e.message}`);
}
assert.match((await err(upload('encrypted.pdf'))).message, /password/i);
assert.equal(DB.count('candidates'), 0, 'failed uploads must not create candidates');
assert.equal(DB.count('cvs'), 0);
ok('bad files rejected with the same messages as the original (encrypted PDF now gets a clearer reason)');

const statuses = [];
for (let i = 0; i < 20; i++) { const e = await err(upload(`limit_${String(i).padStart(2, '0')}.txt`)); statuses.push(e ? e.status : 200); }
assert.deepEqual(statuses, expectedBad.limit_statuses);
assert.equal(DB.count('candidates'), 15); assert.equal(DB.count('cvs'), 15);
ok('Demo plan: 16th real candidate rejected (402), exactly like the original');

const vs = [];
for (let i = 0; i < 4; i++) { const e = await err(api('/api/vacancies', { method: 'POST', body: JSON.stringify({ position: `V${i}` }) })); vs.push(e ? [e.status, e.message] : [200, 'OK']); }
assert.deepEqual(vs.slice(0, 3).map(x => x[0]), [200, 200, 200]); assert.deepEqual(vs[3], expectedBad.vac3);
const ex = await err(api('/api/export/candidates.xlsx')); assert.deepEqual([ex.status, ex.message], expectedBad.export_demo);
ok('Demo plan: vacancy cap 3 and export lock match the original messages');

// duplicates never count against the limit and never create rows
const dup = await upload('limit_00.txt'); assert.equal(dup.duplicate_detected, true); assert.equal(dup.duplicate_signal, 'file_hash');
assert.equal(DB.count('candidates'), 15); assert.equal(DB.count('cvs'), 16);
ok('re-uploading an existing CV is a duplicate (file_hash), allowed at the limit');

// ------------------------------------------------ 2. license: Premium unlocks, tampering does not
let e = await err(api('/api/license/activate', { method: 'POST', body: JSON.stringify({ license_text: 'x.y' }) })); assert.ok(e);
await api('/api/license/activate', { method: 'POST', body: JSON.stringify({ license_text: lic.premium }) });
let st = await api('/api/license/status'); assert.equal(st.plan, 'PREMIUM'); assert.equal(st.limits.max_candidates, 500); assert.equal(st.usage.real_candidates, 15);
const xl = await apiFile('/api/export/candidates.xlsx'); assert.ok(xl.blob.size > 1000); assert.match(xl.filename, /^CV_Bank_\d{8}\.xlsx$/);
await upload('limit_00.txt'); // still fine
// tamper: rewrite the stored plan/licence to something forged -> falls back to DEMO
DB.setMeta('license', { plan: 'VIP', buyer_name: 'x', license_text: lic.wrong_key, license_issued_date: '2026-01-01', activated_at: new Date().toISOString() });
await DB.commit(); resetPlanCache();
st = await api('/api/license/status'); assert.equal(st.plan, 'DEMO'); assert.equal(st.license_invalid, true);
DB.setMeta('license', { plan: 'VIP', buyer_name: 'x', license_text: '', activated_at: null }); await DB.commit(); resetPlanCache();
st = await api('/api/license/status'); assert.equal(st.plan, 'DEMO');
ok('Premium unlocks exports; a hand-edited/forged licence record cannot raise the plan');
await api('/api/license/activate', { method: 'POST', body: JSON.stringify({ license_text: lic.vip }) });

// Premium's candidate cap is enforced too (the old server only enforced Demo's) and demo rows don't count against caps
{
  const { PLAN_LIMITS } = await import('../js/core.js');
  await api('/api/license/activate', { method: 'POST', body: JSON.stringify({ license_text: lic.premium }) });
  const keep = PLAN_LIMITS.PREMIUM.max_candidates; PLAN_LIMITS.PREMIUM.max_candidates = 15;
  const e = await err(upload('limit_15.txt'));   // 15 real candidates exist -> at cap
  assert.equal(e.status, 402); assert.ok(e.message.startsWith('Batas paket Premium tercapai (15 kandidat nyata)'), e.message);
  PLAN_LIMITS.PREMIUM.max_candidates = keep;
  await api('/api/license/activate', { method: 'POST', body: JSON.stringify({ license_text: lic.vip }) });
  ok('Premium candidate cap is enforced (previously only Demo was)');
}
await fresh('t2b');
await api('/api/demo/seed', { method: 'POST' });            // 8 demo vacancies, 45 demo candidates on the Demo plan
const vNew = await api('/api/vacancies', { method: 'POST', body: JSON.stringify({ position: 'Real 1' }) });
assert.ok(vNew.id);
assert.equal((await api('/api/license/status')).usage.job_requirements, 1);
ok('demo data does not eat the Demo plan quota for real vacancies');

// ------------------------------------------------ 3. batch upload mixed outcomes
await fresh('t3'); await api('/api/license/activate', { method: 'POST', body: JSON.stringify({ license_text: lic.vip }) });
const batch = await api('/api/batch-upload/start?total_files=5&source=Email', { method: 'POST' });
const list = [[cvDir, 'cv_single_0.pdf'], [cvDir, 'cv_docx_1.docx'], [cvDir, 'cv_txt_0.txt'], [bad, 'scanned.pdf'], [cvDir, 'cv_single_0.pdf']];
for (const [d, f] of list) await api(`/api/batch-upload/${batch.batch_id}/file`, { method: 'POST', body: fd(f, d) });
await api(`/api/batch-upload/${batch.batch_id}/finish?duration_seconds=1.5`, { method: 'POST' });
const sum = await api(`/api/batch-upload/${batch.batch_id}`);
assert.deepEqual([sum.total_files, sum.processed, sum.new_candidates, sum.duplicate, sum.failed, sum.status], [5, 5, 2, 2, 1, 'COMPLETED']);
assert.equal(sum.files.find(x => x.filename === 'scanned.pdf').status, 'FAILED');
assert.equal((await api('/api/batch-upload')).length, 1);
ok('batch upload: 2 new, 2 duplicates, 1 failed — failure does not stop the batch');

// original CV file comes back byte-for-byte
const cv = (await api('/api/candidates/1')).cvs[0];
const dl = await apiFile(`/api/cv/${cv.id}/download`);
assert.equal(Buffer.compare(Buffer.from(await dl.blob.arrayBuffer()), fs.readFileSync(path.join(cvDir, 'cv_single_0.pdf'))), 0);
ok('CV download returns the original bytes');

// ------------------------------------------------ 4. rollback on failure
const before = JSON.stringify(DB.snapshot().tables);
const e2 = await err(DB.run(async () => { DB.insert('job_requirements', { position: 'Ghost' }); DB.setMeta('profile', { full_name: 'Changed' }); throw new Error('boom'); }));
assert.equal(e2.message, 'boom');
assert.equal(JSON.stringify(DB.snapshot().tables), before); assert.equal(DB.getMeta('profile').full_name, 'Owner Test');
ok('failed operation is rolled back completely (memory and disk)');

// ------------------------------------------------ 5. persistence across reopen
await api('/api/demo/seed', { method: 'POST' });
const snapBefore = JSON.stringify(DB.snapshot());
DB.close(); await openWorkspace('t3');
assert.equal(JSON.stringify(DB.snapshot()), snapBefore);
const nextId = (await api('/api/vacancies', { method: 'POST', body: JSON.stringify({ position: 'After reopen' }) })).id;
assert.equal(nextId, DB.count('job_requirements'), 'ids continue after reopen');
await api('/api/demo/reset', { method: 'POST' });
const idAfterReset = (await api('/api/vacancies', { method: 'POST', body: JSON.stringify({ position: 'Never reuse ids' }) })).id;
assert.ok(idAfterReset > nextId, 'ids are never reused after deletions');
ok('data survives close/reopen; ids keep increasing (never reused)');

// ------------------------------------------------ 6. backup / restore
await api('/api/demo/seed', { method: 'POST' });
const anyVac = DB.all('job_requirements')[0].id;
await api('/api/recruitment-stage', { method: 'POST', body: JSON.stringify({ candidate_id: 1, vacancy_id: anyVac, stage_code: 'HIRED', status: 'COMPLETED' }) });
const orig = JSON.stringify(DB.snapshot());
const origFiles = {}; for (const id of await DB.listFileIds()) origFiles[id] = Buffer.from((await DB.getFile(id)).data).toString('base64');
const { blob, filename, manifest } = await backup.createBackup({ includeFiles: true });
assert.match(filename, /^MRI-Backup_Kantor-Uji_\d{8}-\d{4}\.zip$/);
assert.equal(manifest.cv_file_count, Object.keys(origFiles).length); assert.ok(manifest.cv_file_count >= 2);
const zipBuf = await blob.arrayBuffer();
assert.equal((await backup.inspectBackup(zipBuf)).owner, 'Owner Test');

await backup.wipeWorkspace();
assert.equal(DB.count('candidates'), 0); assert.equal((await DB.listFileIds()).length, 0); assert.equal(DB.getMeta('profile'), null);
const res = await backup.restoreBackup(zipBuf);
assert.equal(res.restored_files, manifest.cv_file_count);
assert.equal(JSON.stringify(DB.snapshot()), orig, 'restored data must equal the original');
for (const id of await DB.listFileIds()) assert.equal(Buffer.from((await DB.getFile(id)).data).toString('base64'), origFiles[id]);
assert.equal((await api('/api/license/status')).plan, 'VIP', 'licence travels with the backup');
const id2 = (await api('/api/vacancies', { method: 'POST', body: JSON.stringify({ position: 'Post-restore' }) })).id;
assert.ok(id2 > Math.max(...DB.all('job_requirements').filter(v => v.id !== id2).map(v => v.id)));
ok('backup → wipe → restore reproduces every row and every CV file; licence and id counters are preserved');

const noFiles = await backup.createBackup({ includeFiles: false });
assert.equal(noFiles.manifest.cv_file_count, 0); assert.ok(noFiles.size < blob.size);
await backup.restoreBackup(await noFiles.blob.arrayBuffer());
assert.equal((await DB.listFileIds()).length, 0); assert.equal((await api('/api/candidates')).length, DB.count('candidates'));
const dl2 = await err(apiFile('/api/cv/1/download')); assert.match(dl2.message, /File fisik CV tidak ditemukan/);
ok('backup without CV files restores data; missing originals give a clear message');

const JSZip = require('jszip');
const errOf = async (buf) => (await err(backup.inspectBackup(buf))) || {};
assert.match((await errOf(Buffer.from('not a zip'))).message, /bukan ZIP/);
const z1 = new JSZip(); z1.file('hello.txt', 'x'); assert.match((await errOf(await z1.generateAsync({ type: 'arraybuffer' }))).message, /bukan file backup MRI/);
const z2 = new JSZip(); z2.file('manifest.json', JSON.stringify({ app: 'MRI Personal Workspace', format: 99 })); z2.file('data.json', '{}');
assert.match((await errOf(await z2.generateAsync({ type: 'arraybuffer' }))).message, /versi MRI yang lebih baru/);
const z3 = new JSZip(); z3.file('manifest.json', JSON.stringify({ app: 'Other' })); z3.file('data.json', '{}');
assert.match((await errOf(await z3.generateAsync({ type: 'arraybuffer' }))).message, /bukan backup dari MRI/);
const z4 = new JSZip(); z4.file('manifest.json', JSON.stringify({ app: 'MRI Personal Workspace', format: 1 })); z4.file('data.json', '{"tables":{"candidates":5},"meta":{"profile":{}}}');
const before2 = JSON.stringify(DB.snapshot());
assert.match((await err(backup.restoreBackup(await z4.generateAsync({ type: 'arraybuffer' })))).message, /Tabel 'candidates'/);
assert.equal(JSON.stringify(DB.snapshot()), before2, 'a rejected backup must leave the workspace untouched');
ok('invalid / foreign / newer-format / malformed backups are rejected without touching current data');

// ------------------------------------------------ 7. exports readable
const ExcelJS = await getExcelJS();
async function sheetOf(path) { const f = await apiFile(path); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await f.blob.arrayBuffer()); return { f, ws: wb.worksheets[0] }; }
let { ws } = await sheetOf('/api/export/candidates.xlsx');
assert.equal(ws.getRow(1).getCell(2).value, 'Nama'); assert.equal(ws.rowCount, 1 + DB.count('candidates')); assert.equal(ws.getRow(1).getCell(1).fill.fgColor.argb, 'FF1E2631');
assert.equal(ws.views[0].state, 'frozen');
({ ws } = await sheetOf(`/api/export/screening/${anyVac}.xlsx`)); assert.equal(ws.getRow(1).getCell(3).value, 'Skor');
({ ws } = await sheetOf('/api/export/employees.xlsx')); assert.equal(ws.rowCount, 1 + DB.count('employees'));
({ ws } = await sheetOf('/api/export/talent-pool.xlsx')); ({ ws } = await sheetOf('/api/export/audit-trail.xlsx'));
const pdf = await apiFile(`/api/export/screening/${anyVac}.pdf`);
const pdfjs = await getPdfJs();
const doc = await pdfjs.getDocument({ data: new Uint8Array(await pdf.blob.arrayBuffer()), isEvalSupported: false, verbosity: 0 }).promise;
let text = ''; for (let i = 1; i <= doc.numPages; i++) { const p = await doc.getPage(i); text += (await p.getTextContent()).items.map(x => x.str).join(' ') + '\n'; }
assert.match(text, /MRI — Megay Recruitment Intelligent/); assert.match(text, new RegExp('Screening Report — ' + DB.get('job_requirements', anyVac).position)); assert.match(text, /Owner Test/); assert.match(text, /Powered by Megay Studio/); assert.match(text, /Halaman 1/);
const empPdf = await apiFile('/api/export/employees.pdf'); assert.ok(empPdf.blob.size > 1000);
ok(`exports: Excel (styled header, frozen row, correct row counts) and PDF (branding, title, owner, ${doc.numPages} page) are readable`);

// Excel templates + import round trip (download template → fill → import)
const tpl = await apiFile('/api/employees/import-template.xlsx');
const wbT = new ExcelJS.Workbook(); await wbT.xlsx.load(await tpl.blob.arrayBuffer());
assert.deepEqual(wbT.worksheets.map(w => w.name), ['Employees', 'Petunjuk']);
const wsT = wbT.getWorksheet('Employees'); assert.equal(wsT.getRow(1).values.slice(1).length, 20); assert.equal(wsT.getRow(2).getCell(2).font.italic, true);
wsT.getRow(2).getCell(1).value = 'EMP-TEST-1'; const dobCell = wsT.getRow(2).getCell(4); dobCell.value = new Date(Date.UTC(1990, 4, 14)); dobCell.numFmt = 'yyyy-mm-dd'; // what Excel does when a user types a date
const filled = new File([await wbT.xlsx.writeBuffer()], 'filled.xlsx'); const f2 = new FormData(); f2.append('file', filled);
const imp = await api('/api/employees/import', { method: 'POST', body: f2 });
assert.equal(imp.valid, 1, JSON.stringify(imp)); assert.equal((await api('/api/employees?q=Budi')).employees[0].date_of_birth, '1990-05-14');
ok('Excel template → filled (incl. real date cell) → import works');

// ------------------------------------------------ 8. Drive client against a mock Drive
class MockDrive {
  constructor() { this.files = new Map(); this.seq = 1; this.calls = []; }
  add(o) { const id = `f${this.seq++}`; const f = { id, trashed: false, createdTime: new Date(Date.now() + this.seq).toISOString(), modifiedTime: new Date().toISOString(), ...o }; this.files.set(id, f); return f; }
  async fetch(url, opts = {}) {
    const u = new URL(url); const method = opts.method || 'GET'; this.calls.push(`${method} ${u.pathname}`);
    const hdr = (k) => (opts.headers || {})[k];
    const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...headers } });
    if (u.host === 'upload.test') { const f = this.files.get(u.searchParams.get('id')); f.blob = opts.body; return json({ id: f.id, name: f.name, size: String(f.blob.size) }); }
    if (!String(hdr('Authorization')).startsWith('Bearer ')) return json({ error: { message: 'no auth' } }, 401);
    if (u.pathname === '/upload/drive/v3/files' || u.pathname.startsWith('/upload/drive/v3/files/')) {
      const type = u.searchParams.get('uploadType');
      if (type === 'resumable') {
        const meta = JSON.parse(opts.body); const id = method === 'PATCH' ? u.pathname.split('/').pop() : this.add({ name: meta.name, parents: meta.parents, mimeType: 'application/octet-stream' }).id;
        return new Response('{}', { status: 200, headers: { Location: `https://upload.test/session?id=${id}` } });
      }
      const text = await new Response(opts.body).text(); const b = /boundary=(.+)$/.exec(hdr('Content-Type'))[1];
      const parts = text.split(`--${b}`); const meta = JSON.parse(parts[1].split('\r\n\r\n')[1].trim());
      const content = parts[2].slice(parts[2].indexOf('\r\n\r\n') + 4, parts[2].lastIndexOf('\r\n'));
      let f; if (method === 'PATCH') { f = this.files.get(u.pathname.split('/').pop()); f.name = meta.name; f.modifiedTime = new Date().toISOString(); } else f = this.add({ name: meta.name, parents: meta.parents, mimeType: 'application/octet-stream' });
      f.content = content; f.size = String(content.length);
      return json({ id: f.id, name: f.name, size: f.size, modifiedTime: f.modifiedTime, webViewLink: `https://drive.google.com/file/d/${f.id}/view` });
    }
    if (u.pathname === '/drive/v3/files' && method === 'GET') {
      const qs = u.searchParams.get('q'); let out = [...this.files.values()].filter(f => !f.trashed);
      const nm = /name='((?:[^'\\]|\\.)*)'/.exec(qs); if (nm) out = out.filter(f => f.name === nm[1].replace(/\\'/g, "'"));
      if (/mimeType='application\/vnd.google-apps.folder'/.test(qs)) out = out.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
      const par = /'([^']+)' in parents/.exec(qs); if (par) out = out.filter(f => (f.parents || []).includes(par[1]));
      return json({ files: out.map(f => ({ id: f.id, name: f.name, size: f.size, modifiedTime: f.modifiedTime, mimeType: f.mimeType, webViewLink: `https://drive.google.com/file/d/${f.id}/view` })) });
    }
    if (u.pathname === '/drive/v3/files' && method === 'POST') { const b = JSON.parse(opts.body); return json({ id: this.add(b).id, name: b.name }); }
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const f = this.files.get(m[1]); if (!f) return json({ error: { message: 'not found' } }, 404);
      if (method === 'DELETE') { this.files.delete(m[1]); return new Response(null, { status: 204 }); }
      if (u.searchParams.get('alt') === 'media') return new Response(f.content ?? f.blob ?? '', { status: 200 });
      return json({ id: f.id, trashed: f.trashed });
    }
    if (u.pathname === '/drive/v3/about') return json({ user: { displayName: 'Uji Coba', emailAddress: 'uji@example.com' } });
    return json({ error: { message: `unhandled ${method} ${u.pathname}` } }, 500);
  }
}
const mock = new MockDrive(); drive._setFetchForTests((u, o) => mock.fetch(u, o));
drive.setClientId('test-client.apps.googleusercontent.com');
assert.ok(drive.isConfigured()); assert.ok(!drive.isConnected());
assert.equal((await err(drive.ensureFolders())).auth, true);
drive._setTokenForTests({ access_token: 'tok', expires_at: Date.now() + 3600e3 });
const folders = await drive.ensureFolders();
assert.deepEqual(Object.keys(folders).sort(), ['backup', 'dist', 'guide', 'root', 'sop', 'templates']);
assert.equal([...mock.files.values()].filter(f => f.mimeType === 'application/vnd.google-apps.folder').length, 6);
const again = await drive.ensureFolders(); assert.deepEqual(again, folders); assert.equal(mock.files.size, 6, 'folders are reused, not duplicated');
// cache dropped (e.g. new browser profile): existing folders are found by name, not re-created
backup.store.del(`mri.drive.folders.test-client.apps.googleusercontent.com`);
assert.deepEqual(await drive.ensureFolders(), folders); assert.equal(mock.files.size, 6);
// folder deleted in Drive → recreated
mock.files.get(folders.sop).trashed = true; const healed = await drive.ensureFolders(); assert.notEqual(healed.sop, folders.sop); assert.equal(healed.root, folders.root);
const up = await drive.uploadFile('backup', 'a.zip', new Blob(['hello zip']), 'application/zip');
assert.equal((await drive.listFolder(folders.backup)).length, 1);
assert.equal(await (await drive.downloadFile(up.id)).text(), 'hello zip');
const o1 = await drive.uploadFile('templates', 't.xlsx', new Blob(['v1']), 'application/x-x', { overwrite: true });
const o2 = await drive.uploadFile('templates', 't.xlsx', new Blob(['v2']), 'application/x-x', { overwrite: true });
assert.equal(o1.id, o2.id); assert.equal((await drive.listFolder(folders.templates)).length, 1); assert.equal(await (await drive.downloadFile(o1.id)).text(), 'v2');
const bigBlob = new Blob([new Uint8Array(5 * 1024 * 1024)]); const bigUp = await drive.uploadFile('backup', 'big.zip', bigBlob, 'application/zip');
assert.ok(mock.calls.some(c => c === 'PUT /session'), 'files > 4 MB use a resumable upload'); assert.equal((await drive.downloadFile(bigUp.id)).size, bigBlob.size);
await drive.deleteFile(up.id); assert.equal((await drive.listFolder(folders.backup)).length, 1);
assert.equal((await drive.accountInfo()).emailAddress, 'uji@example.com');
drive._setTokenForTests({ access_token: 'x', expires_at: Date.now() - 1 }); assert.ok(!drive.isConnected());
ok('Drive client (mock server): folder bootstrap/reuse/heal, upload (multipart, resumable, overwrite), list, download, delete, expired-token handling');

console.log('\nall extra tests passed');
