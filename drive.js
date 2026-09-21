/*
 * MRI Personal Workspace — Google Drive integration.
 *
 * The user's own Google Drive is the place for: User Guide, Excel templates,
 * data backups, manuals/SOP and files to distribute. MRI only asks for the
 * narrow `drive.file` scope, i.e. it can see and manage ONLY the files and
 * folders it created itself — never the rest of the user's Drive.
 *
 * Auth: Google Identity Services "token model" (runs entirely in the browser,
 * no backend, no client secret). Access tokens live in memory only.
 *
 * Folder layout created under "MRI Workspace":
 *   1 Panduan · 2 Template Excel · 3 Backup Data · 4 Manual & SOP · 5 File Distribusi
 */
import { CONFIG } from '../config.js';
import { store } from './backup.js';
import { uuid } from './util.js';

export const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const RESUMABLE_THRESHOLD = 4 * 1024 * 1024;

export const ROOT_NAME = 'MRI Workspace';
export const FOLDERS = {
  guide: '1 Panduan',
  templates: '2 Template Excel',
  backup: '3 Backup Data',
  sop: '4 Manual & SOP',
  dist: '5 File Distribusi',
};

export class DriveError extends Error {
  constructor(message, { status = null, auth = false } = {}) { super(message); this.status = status; this.auth = auth; }
}

// ----------------------------------------------------------------- state ---

let token = null;                 // { access_token, expires_at }
let tokenClient = null;
let fetchImpl = (...a) => globalThis.fetch(...a);

/** Test hook: replace the network layer. */
export function _setFetchForTests(fn) { fetchImpl = fn; }
export function _setTokenForTests(t) { token = t; }

export function getClientId() {
  return (store.get('mri.drive.clientId') || CONFIG.GOOGLE_CLIENT_ID || '').trim();
}
export function setClientId(id) {
  const v = (id || '').trim();
  if (v) store.set('mri.drive.clientId', v); else store.del('mri.drive.clientId');
  tokenClient = null;
}
export function isConfigured() { return !!getClientId(); }
export function isConnected() { return !!token && token.expires_at > Date.now(); }
export function wasConnectedBefore() { return store.get('mri.drive.connected') === '1'; }

export const prefs = {
  autoDistribute: () => store.get('mri.drive.autoDistribute') === '1',
  setAutoDistribute: (on) => store.set('mri.drive.autoDistribute', on ? '1' : '0'),
};

// ------------------------------------------------------------------ auth ---

function loadGis() {
  if (globalThis.google && globalThis.google.accounts && globalThis.google.accounts.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC; s.async = true; s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new DriveError('Tidak bisa memuat layanan login Google. Periksa koneksi internet Anda.'));
    document.head.appendChild(s);
  });
}

/**
 * Must be called from a click handler (browsers block popups otherwise).
 * Resolves when an access token is available.
 */
export async function connect({ prompt = '' } = {}) {
  const clientId = getClientId();
  if (!clientId) throw new DriveError('Google Client ID belum diisi. Lihat panduan di halaman Google Drive.');
  await loadGis();
  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      tokenClient = globalThis.google.accounts.oauth2.initTokenClient({
        client_id: clientId, scope: SCOPE,
        callback: () => {}, error_callback: () => {},
      });
    }
    tokenClient.callback = (resp) => {
      if (resp.error) { reject(new DriveError(`Login Google gagal: ${resp.error_description || resp.error}`, { auth: true })); return; }
      token = { access_token: resp.access_token, expires_at: Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000 };
      store.set('mri.drive.connected', '1');
      resolve(token);
    };
    tokenClient.error_callback = (err) => {
      const t = err && err.type;
      reject(new DriveError(t === 'popup_closed' ? 'Jendela login Google ditutup sebelum selesai.' : t === 'popup_failed_to_open' ? 'Browser memblokir jendela login Google. Izinkan pop-up untuk situs ini lalu coba lagi.' : `Login Google gagal (${t || 'tidak diketahui'}).`, { auth: true }));
    };
    tokenClient.requestAccessToken({ prompt });
  });
}

export function disconnect() {
  const t = token;
  token = null;
  store.del('mri.drive.connected');
  try { if (t && globalThis.google && globalThis.google.accounts) globalThis.google.accounts.oauth2.revoke(t.access_token, () => {}); } catch (_) { /* ignore */ }
}

/** Makes sure a valid token exists (re-prompts only when it has expired). */
export async function ensureToken() {
  if (isConnected()) return token;
  return connect({ prompt: '' });
}

// ------------------------------------------------------------- REST core ---

async function driveFetch(url, options = {}) {
  if (!isConnected()) throw new DriveError('Belum tersambung ke Google Drive. Klik "Sambungkan Google Drive".', { auth: true });
  const res = await fetchImpl(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token.access_token}` } });
  if (res.status === 401) { token = null; throw new DriveError('Sesi Google Drive berakhir. Klik "Sambungkan Google Drive" lagi.', { status: 401, auth: true }); }
  if (!res.ok) {
    let detail = '';
    try { const j = await res.clone().json(); detail = (j.error && (j.error.message || j.error)) || ''; } catch (_) { /* not json */ }
    if (res.status === 403 && /storageQuota|quota/i.test(detail)) throw new DriveError('Kapasitas Google Drive penuh.', { status: 403 });
    if (res.status === 403 && /has not been used in project|is disabled|accessNotConfigured/i.test(detail)) throw new DriveError('Google Drive API belum diaktifkan pada proyek Google Cloud Anda (lihat panduan setup).', { status: 403 });
    throw new DriveError(`Google Drive menolak permintaan (${res.status})${detail ? `: ${detail}` : ''}`, { status: res.status });
  }
  return res;
}

const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function jsonGet(url) { return (await driveFetch(url)).json(); }

async function findFolder(name, parentId) {
  const parts = [`name='${q(name)}'`, `mimeType='${FOLDER_MIME}'`, 'trashed=false'];
  if (parentId) parts.push(`'${parentId}' in parents`);
  const url = `${DRIVE}/files?q=${encodeURIComponent(parts.join(' and '))}&orderBy=createdTime&pageSize=10&fields=files(id,name)&spaces=drive`;
  const { files } = await jsonGet(url);
  return files && files[0] ? files[0].id : null;
}

async function createFolder(name, parentId) {
  const res = await driveFetch(`${DRIVE}/files?fields=id,name`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) }),
  });
  return (await res.json()).id;
}

async function folderStillExists(id) {
  try {
    const f = await jsonGet(`${DRIVE}/files/${id}?fields=id,trashed`);
    return !f.trashed;
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) return false;
    throw e;
  }
}

const cacheKey = () => `mri.drive.folders.${getClientId()}`;

/** Finds (or creates) MRI Workspace and its five sub-folders. Returns {root, guide, templates, backup, sop, dist}. */
export async function ensureFolders() {
  let cached = null;
  try { cached = JSON.parse(store.get(cacheKey()) || 'null'); } catch (_) { cached = null; }
  if (cached && cached.root && Object.keys(FOLDERS).every(k => cached[k]) && await folderStillExists(cached.root)) {
    let ok = true;
    for (const k of Object.keys(FOLDERS)) if (!(await folderStillExists(cached[k]))) { ok = false; break; }
    if (ok) return cached;
  }
  const ids = {};
  ids.root = (await findFolder(ROOT_NAME, null)) || (await createFolder(ROOT_NAME, null));
  for (const [key, name] of Object.entries(FOLDERS)) {
    ids[key] = (await findFolder(name, ids.root)) || (await createFolder(name, ids.root));
  }
  store.set(cacheKey(), JSON.stringify(ids));
  return ids;
}

export async function listFolder(folderId, { pageSize = 100 } = {}) {
  const url = `${DRIVE}/files?q=${encodeURIComponent(`'${folderId}' in parents and trashed=false`)}` +
    `&orderBy=${encodeURIComponent('modifiedTime desc')}&pageSize=${pageSize}` +
    `&fields=${encodeURIComponent('files(id,name,mimeType,size,modifiedTime,webViewLink)')}`;
  const { files } = await jsonGet(url);
  return files || [];
}

async function findByName(name, folderId) {
  const url = `${DRIVE}/files?q=${encodeURIComponent(`name='${q(name)}' and '${folderId}' in parents and trashed=false`)}&pageSize=1&fields=files(id)`;
  const { files } = await jsonGet(url);
  return files && files[0] ? files[0].id : null;
}

const FIELDS = 'id,name,mimeType,size,modifiedTime,webViewLink';

async function multipartUpload(method, url, metadata, blob, mimeType) {
  const boundary = `mri${uuid().replace(/-/g, '')}`;
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const body = new Blob([head, blob, `\r\n--${boundary}--`]);
  const res = await driveFetch(url, { method, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  return res.json();
}

async function resumableUpload(method, url, metadata, blob, mimeType) {
  const init = await driveFetch(url, {
    method, headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mimeType, 'X-Upload-Content-Length': String(blob.size) },
    body: JSON.stringify(metadata),
  });
  const session = init.headers.get('Location');
  if (!session) throw new DriveError('Google Drive tidak mengembalikan sesi upload.');
  const put = await fetchImpl(session, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: blob });
  if (!put.ok) throw new DriveError(`Upload ke Google Drive gagal (${put.status}).`, { status: put.status });
  return put.json();
}

/**
 * Uploads a Blob into one of the MRI folders. With overwrite=true an existing
 * file of the same name in that folder is updated instead of duplicated.
 * Resolves {id, name, size, modifiedTime, webViewLink}.
 */
export async function uploadFile(folderKey, name, blob, mimeType = 'application/octet-stream', { overwrite = false } = {}) {
  const folders = await ensureFolders();
  const folderId = folders[folderKey];
  if (!folderId) throw new DriveError(`Folder '${folderKey}' tidak dikenal.`);
  const existing = overwrite ? await findByName(name, folderId) : null;
  const big = blob.size > RESUMABLE_THRESHOLD;
  const send = big ? resumableUpload : multipartUpload;
  if (existing) {
    return send('PATCH', `${UPLOAD}/files/${existing}?uploadType=${big ? 'resumable' : 'multipart'}&fields=${FIELDS}`, { name }, blob, mimeType);
  }
  return send('POST', `${UPLOAD}/files?uploadType=${big ? 'resumable' : 'multipart'}&fields=${FIELDS}`, { name, parents: [folderId] }, blob, mimeType);
}

export async function downloadFile(fileId) {
  const res = await driveFetch(`${DRIVE}/files/${fileId}?alt=media`);
  return res.blob();
}

export async function deleteFile(fileId) {
  await driveFetch(`${DRIVE}/files/${fileId}`, { method: 'DELETE' });
}

/** Signed-in account, for display only (best effort). */
export async function accountInfo() {
  try {
    const j = await jsonGet(`${DRIVE}/about?fields=${encodeURIComponent('user(displayName,emailAddress)')}`);
    return j.user || null;
  } catch (_) { return null; }
}
