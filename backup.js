/*
 * MRI Personal Workspace — backup & restore.
 *
 * A backup is a normal .zip file:
 *   manifest.json        what/when/how many (validated on restore)
 *   data.json            every table + workspace profile + license code
 *   cv_files/<id>.<ext>  the ORIGINAL CV files (optional)
 *
 * Restoring REPLACES the whole workspace — this is the "move to a new device"
 * path (Import Backup). The same file can come from the local disk or from
 * Google Drive (see drive.js); this module never talks to the network.
 */
import * as DB from './db.js';
import { getJSZip } from './vendor.js';
import { CONFIG } from '../config.js';
import { fileExt, safeFilename } from './util.js';

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
};

// ------------------------------------------------ small localStorage shim --

const memStore = new Map();
export const store = {
  get(k) { try { return globalThis.localStorage ? globalThis.localStorage.getItem(k) : (memStore.get(k) ?? null); } catch (_) { return memStore.get(k) ?? null; } },
  set(k, v) { try { if (globalThis.localStorage) globalThis.localStorage.setItem(k, v); else memStore.set(k, v); } catch (_) { memStore.set(k, v); } },
  del(k) { try { if (globalThis.localStorage) globalThis.localStorage.removeItem(k); } catch (_) { /* ignore */ } memStore.delete(k); },
};

const LAST_BACKUP_KEY = 'mri.lastBackupAt';

export function backupStatus() {
  const iso = store.get(LAST_BACKUP_KEY);
  const last = iso ? new Date(iso) : null;
  const days = last && !Number.isNaN(last.getTime()) ? Math.floor((Date.now() - last.getTime()) / 86400000) : null;
  const rows = DB.isOpen()
    ? DB.count('candidates') + DB.count('cvs') + DB.count('job_requirements') + DB.count('screenings') + DB.count('employees')
    : 0;
  return { last_backup_at: last ? last.toISOString() : null, days_since: days, has_data: rows > 0 };
}

export function markBackupDone() { store.set(LAST_BACKUP_KEY, new Date().toISOString()); }

// ------------------------------------------------------------- create -----

export function backupFilename(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const profile = DB.getMeta('profile', null);
  const ws = profile && profile.workspace_name ? safeFilename(profile.workspace_name).replace(/\s+/g, '-').slice(0, 40) : 'Workspace';
  return `MRI-Backup_${ws}_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.zip`;
}

/** Builds the backup ZIP. Resolves {blob, filename, manifest}. */
export async function createBackup({ includeFiles = true, onProgress = () => {} } = {}) {
  const JSZip = await getJSZip();
  const zip = new JSZip();
  const snap = DB.snapshot();
  const profile = snap.meta.profile || {};

  const files = [];
  if (includeFiles) {
    const ids = await DB.listFileIds();
    let i = 0;
    for (const id of ids) {
      const f = await DB.getFile(id);
      if (f) {
        const ext = fileExt(f.name) || '.bin';
        zip.file(`cv_files/${id}${ext}`, f.data, { compression: 'STORE', binary: true });
        files.push(id);
      }
      onProgress({ phase: 'files', done: ++i, total: ids.length });
    }
  }

  const counts = {};
  for (const [t, rows] of Object.entries(snap.tables)) counts[t] = rows.length;
  const manifest = {
    app: 'MRI Personal Workspace', format: CONFIG.BACKUP_FORMAT, app_version: CONFIG.APP_VERSION,
    created_at: new Date().toISOString(), workspace_name: profile.workspace_name || null, owner: profile.full_name || null,
    includes_cv_files: includeFiles, cv_file_count: files.length, counts,
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('data.json', JSON.stringify({ meta: snap.meta, tables: snap.tables }), { compression: 'DEFLATE' });

  onProgress({ phase: 'zip', done: 0, total: 1 });
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  onProgress({ phase: 'zip', done: 1, total: 1 });
  return { blob: new Blob([bytes], { type: 'application/zip' }), filename: backupFilename(), manifest, size: bytes.byteLength };
}

// ------------------------------------------------------------ inspect -----

export class BackupError extends Error {}

async function openZip(arrayBuffer) {
  const JSZip = await getJSZip();
  let zip;
  try { zip = await JSZip.loadAsync(arrayBuffer); } catch (_) { throw new BackupError('File ini bukan ZIP yang valid — pastikan Anda memilih file backup MRI (.zip).'); }
  const mf = zip.file('manifest.json'), data = zip.file('data.json');
  if (!mf || !data) throw new BackupError('Ini bukan file backup MRI (manifest.json / data.json tidak ditemukan).');
  let manifest;
  try { manifest = JSON.parse(await mf.async('string')); } catch (_) { throw new BackupError('manifest.json rusak.'); }
  if (manifest.app !== 'MRI Personal Workspace') throw new BackupError('File ini bukan backup dari MRI Personal Workspace.');
  if (typeof manifest.format !== 'number' || manifest.format > CONFIG.BACKUP_FORMAT) {
    throw new BackupError('Backup ini dibuat oleh versi MRI yang lebih baru. Perbarui aplikasi (muat ulang halaman) lalu coba lagi.');
  }
  return { zip, manifest };
}

/** Reads only the manifest, so the UI can show what is about to be restored. */
export async function inspectBackup(arrayBuffer) {
  const { manifest } = await openZip(arrayBuffer);
  return manifest;
}

// ------------------------------------------------------------ restore -----

/** Replaces the whole workspace with the backup's content. */
export async function restoreBackup(arrayBuffer, { onProgress = () => {} } = {}) {
  const { zip, manifest } = await openZip(arrayBuffer);
  let snap;
  try { snap = JSON.parse(await zip.file('data.json').async('string')); } catch (_) { throw new BackupError('data.json rusak atau terpotong.'); }
  if (!snap || typeof snap !== 'object' || !snap.tables || !snap.meta) throw new BackupError('Isi data.json tidak sesuai format MRI.');
  for (const t of DB.TABLES) if (snap.tables[t] !== undefined && !Array.isArray(snap.tables[t])) throw new BackupError(`Tabel '${t}' pada backup tidak valid.`);
  if (!snap.meta.profile) throw new BackupError('Backup tidak berisi profil workspace.');

  const cvNames = new Map((snap.tables.cvs || []).map(cv => [cv.id, cv.filename]));
  const fileEntries = zip.file(/^cv_files\//);
  const files = [];
  let i = 0;
  for (const entry of fileEntries) {
    const m = /^cv_files\/(\d+)(\.[^./]+)$/.exec(entry.name);
    if (!m) continue;
    const id = Number(m[1]);
    const data = await entry.async('arraybuffer');
    files.push({ id, name: cvNames.get(id) || entry.name, type: MIME_BY_EXT[m[2].toLowerCase()] || 'application/octet-stream', size: data.byteLength, data });
    onProgress({ phase: 'files', done: ++i, total: fileEntries.length });
  }
  onProgress({ phase: 'write', done: 0, total: 1 });
  await DB.restoreSnapshot({ tables: snap.tables, meta: snap.meta }, files);
  onProgress({ phase: 'write', done: 1, total: 1 });
  return { manifest, restored_files: files.length };
}

// ------------------------------------------------------ storage / wipe -----

export async function storageInfo() {
  const info = { persisted: null, usage: null, quota: null, files: null };
  try { if (navigator.storage && navigator.storage.persisted) info.persisted = await navigator.storage.persisted(); } catch (_) { /* ignore */ }
  try {
    if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); info.usage = e.usage ?? null; info.quota = e.quota ?? null; }
  } catch (_) { /* ignore */ }
  try { info.files = await DB.fileStats(); } catch (_) { /* ignore */ }
  return info;
}

/** Asks the browser not to evict this site's data under storage pressure. */
export async function requestPersistentStorage() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (_) { /* ignore */ }
  return false;
}

export async function wipeWorkspace() {
  await DB.wipeAll();
  store.del(LAST_BACKUP_KEY);
}
