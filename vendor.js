/*
 * Lazy loaders for the third-party libraries shipped inside /vendor.
 * Everything is self-hosted (no CDN) so the app keeps working offline and
 * no candidate data ever depends on a third-party host being reachable.
 *
 * In a browser each library is loaded on first use with a <script> tag.
 * Under Node (used only by the automated tests) the same libraries are
 * resolved from node_modules, so tests exercise identical code paths.
 */
const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
const cache = {};

function baseUrl() {
  return new URL('../vendor/', import.meta.url).href;
}

function loadScript(file) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = baseUrl() + file;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Gagal memuat pustaka ${file}. Muat ulang halaman dan coba lagi.`));
    document.head.appendChild(s);
  });
}

async function nodeRequire(name) {
  const { createRequire } = await import('node:module');
  const req = createRequire(process.env.MRI_TEST_ROOT ? process.env.MRI_TEST_ROOT + '/' : import.meta.url);
  return req(name);
}

export async function getExcelJS() {
  if (cache.excel) return cache.excel;
  if (isBrowser) {
    if (!window.ExcelJS) await loadScript('exceljs.min.js');
    cache.excel = window.ExcelJS;
  } else {
    cache.excel = await nodeRequire('exceljs');
  }
  return cache.excel;
}

export async function getJsPDF() {
  if (cache.jspdf) return cache.jspdf;
  if (isBrowser) {
    if (!window.jspdf) await loadScript('jspdf.umd.min.js');
    if (!window.jspdf.jsPDF.API.autoTable) await loadScript('jspdf.plugin.autotable.min.js');
    cache.jspdf = window.jspdf.jsPDF;
  } else {
    const mod = await nodeRequire('jspdf');
    const jsPDF = mod.jsPDF || mod.default || mod;
    const auto = await nodeRequire('jspdf-autotable');
    const applyPlugin = auto.applyPlugin || (auto.default && auto.default.applyPlugin);
    if (applyPlugin) applyPlugin(jsPDF);
    cache.jspdf = jsPDF;
  }
  return cache.jspdf;
}

export async function getJSZip() {
  if (cache.jszip) return cache.jszip;
  if (isBrowser) {
    if (!window.JSZip) await loadScript('jszip.min.js');
    cache.jszip = window.JSZip;
  } else {
    cache.jszip = await nodeRequire('jszip');
  }
  return cache.jszip;
}

export async function getNacl() {
  if (cache.nacl) return cache.nacl;
  if (isBrowser) {
    if (!window.nacl) await loadScript('nacl-fast.min.js');
    cache.nacl = window.nacl;
  } else {
    cache.nacl = await nodeRequire('tweetnacl');
  }
  return cache.nacl;
}

export async function getPdfJs() {
  if (cache.pdfjs) return cache.pdfjs;
  if (isBrowser) {
    const mod = await import(new URL('./pdfjs/pdf.min.mjs', baseUrl()).href);
    mod.GlobalWorkerOptions.workerSrc = new URL('./pdfjs/pdf.worker.min.mjs', baseUrl()).href;
    cache.pdfjs = mod;
  } else {
    const path = await import('node:path');
    const url = await import('node:url');
    const root = process.env.MRI_TEST_ROOT || process.cwd();
    const mod = await import(url.pathToFileURL(path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
    mod.GlobalWorkerOptions.workerSrc = url.pathToFileURL(path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
    cache.pdfjs = mod;
  }
  return cache.pdfjs;
}

export function getDOMParser() {
  if (typeof DOMParser !== 'undefined') return new DOMParser();
  if (globalThis.__MRI_DOMParser) return new globalThis.__MRI_DOMParser();
  throw new Error('DOMParser tidak tersedia di lingkungan ini.');
}
