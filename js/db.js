/*
 * MRI Personal Workspace — local database (IndexedDB).
 *
 * Design:
 *  - IndexedDB is the durable store. On startup every table is loaded into
 *    memory (a personal HR workspace is small: hundreds to a few thousand
 *    rows), so queries are plain synchronous JS — a direct port of the
 *    SQL/ORM queries in the old FastAPI backend.
 *  - Every mutation is queued and flushed to IndexedDB in ONE transaction by
 *    commit(). run(fn) wraps a whole operation: if fn throws, the queue is
 *    dropped and memory is reloaded from disk, so a half-finished operation
 *    can never leave the workspace in an inconsistent state.
 *  - Original CV files (binary) are stored in their own object store and are
 *    NOT kept in memory.
 *  - Related child rows (education, skills, ...) are embedded inside their
 *    parent record (candidate / screening) instead of separate tables, which
 *    removes the need for cascade-delete logic.
 */

export const DB_NAME_DEFAULT = 'mri-workspace';
// v2: adds the 'knowledge_master' store (Knowledge Center master data). Existing stores are untouched:
// onupgradeneeded only creates the stores that do not exist yet, so data from v1 is preserved.
export const DB_VERSION = 2;

export const TABLES = [
  'candidates',
  'cvs',
  'job_requirements',
  'screenings',
  'talent_pool',
  'stage_config',
  'recruitment_stages',
  'audit_trail',
  'batch_upload_jobs',
  'employee_options',
  'employees',
  'knowledge_job_criteria',
  'knowledge_universities',
  'knowledge_interview_questions',
  'knowledge_master',
];
const META_STORE = 'meta';
const FILE_STORE = 'cv_files';

let dbName = DB_NAME_DEFAULT;
let idb = null;
let mem = {};
let meta = new Map();
let counters = {};
let queue = [];
let tail = Promise.resolve();
let versionChangeHandler = null;

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Operasi IndexedDB gagal.'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Transaksi IndexedDB gagal.'));
    tx.onabort = () => reject(tx.error || new Error('Transaksi IndexedDB dibatalkan.'));
  });
}

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const t of TABLES) if (!d.objectStoreNames.contains(t)) d.createObjectStore(t, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(META_STORE)) d.createObjectStore(META_STORE, { keyPath: 'key' });
      if (!d.objectStoreNames.contains(FILE_STORE)) d.createObjectStore(FILE_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const d = req.result;
      d.onversionchange = () => { d.close(); if (versionChangeHandler) versionChangeHandler(); };
      resolve(d);
    };
    req.onerror = () => reject(req.error || new Error('Tidak bisa membuka database lokal browser.'));
    req.onblocked = () => reject(new Error('Database lokal sedang dipakai tab lain. Tutup tab MRI lain lalu muat ulang.'));
  });
}

export function onVersionChange(fn) { versionChangeHandler = fn; }

async function loadAll() {
  const tx = idb.transaction([...TABLES, META_STORE], 'readonly');
  const newMem = {};
  const reads = TABLES.map(async (t) => {
    const rows = await requestToPromise(tx.objectStore(t).getAll());
    rows.sort((a, b) => a.id - b.id);
    newMem[t] = new Map(rows.map(r => [r.id, r]));
  });
  const metaRows = await requestToPromise(tx.objectStore(META_STORE).getAll());
  await Promise.all(reads);
  mem = newMem;
  meta = new Map(metaRows.map(r => [r.key, r.value]));
  const stored = meta.get('counters') || {};
  counters = {};
  for (const t of TABLES) {
    let max = 0;
    for (const id of mem[t].keys()) if (id > max) max = id;
    counters[t] = Math.max(stored[t] || 0, max);
  }
}

export async function open(name) {
  if (idb) return;
  if (name) dbName = name;
  idb = await openIdb();
  await loadAll();
}

export function close() {
  if (idb) { idb.close(); idb = null; }
  mem = {}; meta = new Map(); counters = {}; queue = [];
}

export function isOpen() { return !!idb; }

// ---------------------------------------------------------------- reads ---

export function all(table) { return [...mem[table].values()]; }
export function get(table, id) { return mem[table].get(id); }
export function count(table) { return mem[table].size; }
export function find(table, pred) { for (const r of mem[table].values()) if (pred(r)) return r; return undefined; }
export function filter(table, pred) { const out = []; for (const r of mem[table].values()) if (pred(r)) out.push(r); return out; }

export function getMeta(key, dflt = null) { return meta.has(key) ? meta.get(key) : dflt; }

// --------------------------------------------------------------- writes ---

export function insert(table, obj) {
  counters[table] = (counters[table] || 0) + 1;
  obj.id = counters[table];
  mem[table].set(obj.id, obj);
  queue.push({ store: table, kind: 'put', value: obj });
  return obj;
}

/** Call after mutating a record that is already in the table. */
export function save(table, obj) {
  mem[table].set(obj.id, obj);
  queue.push({ store: table, kind: 'put', value: obj });
  return obj;
}

export function remove(table, id) {
  mem[table].delete(id);
  queue.push({ store: table, kind: 'delete', key: id });
}

export function setMeta(key, value) {
  meta.set(key, value);
  queue.push({ store: META_STORE, kind: 'put', value: { key, value } });
}

export function putFile(id, name, type, data) {
  queue.push({ store: FILE_STORE, kind: 'put', value: { id, name, type, size: data.byteLength, data } });
}

export function deleteFile(id) {
  queue.push({ store: FILE_STORE, kind: 'delete', key: id });
}

export async function getFile(id) {
  const tx = idb.transaction([FILE_STORE], 'readonly');
  return requestToPromise(tx.objectStore(FILE_STORE).get(id));
}

export async function listFileIds() {
  const tx = idb.transaction([FILE_STORE], 'readonly');
  return requestToPromise(tx.objectStore(FILE_STORE).getAllKeys());
}

export async function fileStats() {
  const tx = idb.transaction([FILE_STORE], 'readonly');
  const store = tx.objectStore(FILE_STORE);
  const rows = await requestToPromise(store.getAll());
  return { count: rows.length, bytes: rows.reduce((s, r) => s + (r.size || 0), 0) };
}

export async function commit() {
  if (!queue.length) return;
  const ops = queue;
  queue = [];
  const stores = new Set([META_STORE]);
  for (const op of ops) stores.add(op.store);
  const tx = idb.transaction([...stores], 'readwrite');
  const done = txDone(tx);
  for (const op of ops) {
    const os = tx.objectStore(op.store);
    if (op.kind === 'put') os.put(op.value); else os.delete(op.key);
  }
  tx.objectStore(META_STORE).put({ key: 'counters', value: { ...counters } });
  meta.set('counters', { ...counters });
  await done;
}

async function acquire() {
  let release;
  const gate = new Promise(r => { release = r; });
  const prev = tail;
  tail = prev.then(() => gate);
  await prev;
  return release;
}

/**
 * Runs one atomic unit of work. All changes queued by fn are written in a
 * single IndexedDB transaction when fn resolves; if fn throws, nothing is
 * written and memory is reloaded from disk.
 */
export async function run(fn) {
  const release = await acquire();
  try {
    const result = await fn();
    await commit();
    return result;
  } catch (err) {
    queue = [];
    try { await loadAll(); } catch (_) { /* keep original error */ }
    throw err;
  } finally {
    release();
  }
}

// ------------------------------------------------------ bulk operations ---

/** Deep-cloned snapshot of every table + meta (used by backup). */
export function snapshot() {
  const tables = {};
  for (const t of TABLES) tables[t] = JSON.parse(JSON.stringify(all(t)));
  const metaOut = {};
  for (const [k, v] of meta.entries()) metaOut[k] = JSON.parse(JSON.stringify(v));
  return { tables, meta: metaOut };
}

/** Replaces the entire database with the given snapshot (+ optional files). */
export async function restoreSnapshot(snap, files = []) {
  const release = await acquire();
  try {
    const tx = idb.transaction([...TABLES, META_STORE, FILE_STORE], 'readwrite');
    const done = txDone(tx);
    for (const t of TABLES) {
      const os = tx.objectStore(t);
      os.clear();
      for (const row of (snap.tables[t] || [])) os.put(row);
    }
    const metaStore = tx.objectStore(META_STORE);
    metaStore.clear();
    const newCounters = { ...(snap.meta && snap.meta.counters ? snap.meta.counters : {}) };
    for (const t of TABLES) {
      let max = 0;
      for (const row of (snap.tables[t] || [])) if (row.id > max) max = row.id;
      newCounters[t] = Math.max(newCounters[t] || 0, max);
    }
    for (const [k, v] of Object.entries(snap.meta || {})) {
      if (k === 'counters') continue;
      metaStore.put({ key: k, value: v });
    }
    metaStore.put({ key: 'counters', value: newCounters });
    const fileStore = tx.objectStore(FILE_STORE);
    fileStore.clear();
    for (const f of files) fileStore.put(f);
    await done;
    queue = [];
    await loadAll();
  } finally {
    release();
  }
}

export async function wipeAll() {
  await restoreSnapshot({ tables: {}, meta: {} }, []);
}

export async function deleteDatabase(name) {
  close();
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name || dbName);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}
