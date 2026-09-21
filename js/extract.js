/*
 * MRI — CV text extraction in the browser.
 *
 * Replaces pdfplumber / python-docx from the server version:
 *   PDF  -> pdf.js (vendored). Reproduces the server's page logic:
 *           * pages that contain a table / drawn box are read in normal
 *             top-to-bottom order;
 *           * otherwise, if the words show a clear two-column split, each
 *             column is read top-to-bottom on its own (left, then right).
 *   DOCX -> JSZip + XML: body paragraphs only, exactly like python-docx's
 *           document.paragraphs (table cells are NOT included).
 *   TXT  -> UTF-8 text.
 *
 * Limitation (same as before): scanned/image-only PDFs have no text layer and
 * are rejected — OCR is not supported.
 */
import { getPdfJs, getJSZip, getDOMParser } from './vendor.js';

const Y_TOL = 3;   // pdfplumber default y_tolerance
const X_TOL = 3;   // pdfplumber default x_tolerance

// ----------------------------------------------------------------- PDF ----

/** Turns pdf.js text items into word boxes {text, x0, x1, top}. */
function itemsToWords(items, pageHeight) {
  const pieces = []; // {text, x0, x1, top, spaceBefore, spaceAfter}
  for (const it of items) {
    const str = it.str;
    if (!str || !str.trim()) continue;
    const [a, b, , , e, f] = it.transform;
    if (Math.abs(b) > 0.2 * Math.abs(a || 1)) continue; // rotated / vertical text: ignored
    const h = it.height || Math.abs(a) || 10;
    const top = pageHeight - f - h;
    const total = str.length;
    const width = it.width || 0;
    const re = /\S+/g;
    let m;
    while ((m = re.exec(str)) !== null) {
      const startFrac = m.index / total;
      const endFrac = (m.index + m[0].length) / total;
      pieces.push({
        text: m[0], x0: e + width * startFrac, x1: e + width * endFrac, top,
        leadSpace: m.index > 0 && /\s/.test(str[m.index - 1]),
        trailSpace: m.index + m[0].length < total && /\s/.test(str[m.index + m[0].length]),
        startsItem: m.index === 0, endsItem: m.index + m[0].length === total,
      });
    }
  }
  return pieces;
}

/** pdfplumber-style chain clustering of word pieces into lines (by `top`). */
function clusterIntoLines(pieces) {
  const sorted = [...pieces].sort((a, b) => a.top - b.top);
  const lines = [];
  let cur = [], last = null;
  for (const w of sorted) {
    if (last === null || w.top <= last + Y_TOL) cur.push(w);
    else { lines.push(cur); cur = [w]; }
    last = w.top;
  }
  if (cur.length) lines.push(cur);
  return lines.map(l => l.sort((a, b) => a.x0 - b.x0));
}

/**
 * pdfplumber joins glyphs that sit within x_tolerance of each other into one
 * word even when the PDF drew them as separate text runs. Do the same for
 * runs that touch (no space character between them).
 */
function buildWords(pieces) {
  const words = [];
  for (const line of clusterIntoLines(pieces)) {
    let last = null;
    for (const p of line) {
      if (last && last.endsItem && p.startsItem && !last.trailSpace && !p.leadSpace
          && Math.abs(p.x0 - last.x1) <= X_TOL) {
        last.text += p.text;
        last.x1 = p.x1;
        last.endsItem = p.endsItem;
        last.trailSpace = p.trailSpace;
      } else {
        last = { ...p };
        words.push(last);
      }
    }
  }
  return words;
}

function wordsToText(words) {
  return clusterIntoLines(words).map(l => l.map(w => w.text).join(' ')).join('\n');
}

function pyRoundHalfEven(x) {
  const r = Math.round(x);
  return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r;
}

/** Column-by-column reconstruction (mirror of the server's `reconstruct`). */
function reconstructColumn(colWords) {
  const rows = new Map();
  for (const w of colWords) {
    const key = pyRoundHalfEven(w.top / 4) * 4;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(w);
  }
  return [...rows.keys()].sort((a, b) => a - b)
    .map(k => rows.get(k).sort((a, b) => a.x0 - b.x0).map(w => w.text).join(' ')).join('\n');
}

// --- table / drawn-box detection (approximates pdfplumber's find_tables) ---

const PAINT = new Set(['stroke', 'closeStroke', 'fill', 'eoFill', 'fillStroke', 'eoFillStroke', 'closeFillStroke', 'closeEOFillStroke']);

async function collectEdges(page, OPS) {
  const names = {};
  for (const [k, v] of Object.entries(OPS)) names[v] = k;
  const ol = await page.getOperatorList();
  const hs = [], vs = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let pending = null;
  const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  const pt = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
  const addSeg = (p, q) => {
    if (Math.abs(p[1] - q[1]) < 0.01 && Math.abs(p[0] - q[0]) >= 3) hs.push({ y: p[1], x0: Math.min(p[0], q[0]), x1: Math.max(p[0], q[0]) });
    else if (Math.abs(p[0] - q[0]) < 0.01 && Math.abs(p[1] - q[1]) >= 3) vs.push({ x: p[0], y0: Math.min(p[1], q[1]), y1: Math.max(p[1], q[1]) });
  };
  const commit = (segs) => { for (const [p, q] of segs) addSeg(p, q); };

  for (let i = 0; i < ol.fnArray.length; i++) {
    const name = names[ol.fnArray[i]];
    const args = ol.argsArray[i];
    if (name === 'save') stack.push(ctm);
    else if (name === 'restore') ctm = stack.pop() || ctm;
    else if (name === 'transform') ctm = mul(ctm, args);
    else if (name === 'constructPath') {
      const [ops, coords] = args;
      const segs = [];
      let ci = 0, cur = null, start = null;
      for (const op of ops) {
        if (op === OPS.moveTo) { cur = pt(coords[ci], coords[ci + 1]); start = cur; ci += 2; }
        else if (op === OPS.lineTo) { const n = pt(coords[ci], coords[ci + 1]); ci += 2; if (cur) segs.push([cur, n]); cur = n; }
        else if (op === OPS.curveTo) { ci += 6; cur = null; }
        else if (op === OPS.curveTo2 || op === OPS.curveTo3) { ci += 4; cur = null; }
        else if (op === OPS.closePath) { if (cur && start) segs.push([cur, start]); cur = start; }
        else if (op === OPS.rectangle) {
          const x = coords[ci], y = coords[ci + 1], w = coords[ci + 2], h = coords[ci + 3]; ci += 4;
          const p1 = pt(x, y), p2 = pt(x + w, y), p3 = pt(x + w, y + h), p4 = pt(x, y + h);
          segs.push([p1, p2], [p2, p3], [p3, p4], [p4, p1]);
        } else { pending = null; break; }
      }
      pending = segs;
    } else if (PAINT.has(name)) {
      if (pending) commit(pending);
      pending = null;
    } else if (name === 'endPath' || name === 'clip' || name === 'eoClip') {
      pending = null;
    }
  }
  return { hs, vs };
}

/** True when the drawn lines/rectangles enclose at least one cell. */
function hasTableCell(hs, vs) {
  const snap = (arr, key) => {
    const s = [...arr].sort((a, b) => a[key] - b[key]);
    let cur = null, last = null;
    const out = [];
    for (const e of s) {
      if (cur && e[key] <= last + 3) { cur.push(e); } else { cur = [e]; out.push(cur); }
      last = e[key];
    }
    return out.map(g => { const avg = g.reduce((t, e) => t + e[key], 0) / g.length; return g.map(e => ({ ...e, [key]: avg })); }).flat();
  };
  let H = snap(hs, 'y'), V = snap(vs, 'x');
  if (H.length + V.length > 400) return true; // busy graphic page: be conservative
  const TOL = 3;
  const crosses = (h, v) => v.x >= h.x0 - TOL && v.x <= h.x1 + TOL && h.y >= v.y0 - TOL && h.y <= v.y1 + TOL;
  H = H.sort((a, b) => a.y - b.y);
  for (let i = 0; i < H.length; i++) {
    for (let j = i + 1; j < H.length; j++) {
      if (H[j].y - H[i].y <= TOL) continue;
      const shared = V.filter(v => crosses(H[i], v) && crosses(H[j], v));
      if (shared.length >= 2) {
        const xs = shared.map(v => v.x).sort((a, b) => a - b);
        if (xs[xs.length - 1] - xs[0] > TOL) return true;
      }
    }
  }
  return false;
}

async function extractPdfPage(page, pdfjs) {
  const viewport = page.getViewport({ scale: 1 });
  const pageWidth = viewport.width, pageHeight = viewport.height;
  const tc = await page.getTextContent();
  const words = buildWords(itemsToWords(tc.items, pageHeight));
  if (!words.length) return '';

  let tables = false;
  try {
    const { hs, vs } = await collectEdges(page, pdfjs.OPS);
    tables = hasTableCell(hs, vs);
  } catch (_) { tables = false; }
  if (tables) return wordsToText(words);

  const mid = pageWidth / 2;
  const band = pageWidth * 0.06;
  const left = words.filter(w => w.x0 < mid - band);
  const right = words.filter(w => w.x0 > mid + band);
  const straddling = words.filter(w => w.x0 >= mid - band && w.x0 <= mid + band);
  const isTwoColumn = left.length >= 6 && right.length >= 6 && straddling.length <= Math.max(2, Math.trunc(words.length * 0.08));
  if (!isTwoColumn) return wordsToText(words);
  return reconstructColumn(left) + '\n\n' + reconstructColumn(right);
}

export async function extractPdfText(arrayBuffer) {
  const pdfjs = await getPdfJs();
  const data = new Uint8Array(arrayBuffer.slice(0));
  let doc;
  try {
    doc = await pdfjs.getDocument({ data, isEvalSupported: false, verbosity: 0, useSystemFonts: false, disableFontFace: true }).promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') throw new Error('PDF dilindungi password — buka proteksinya dulu lalu unggah ulang.');
    throw err;
  }
  const parts = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      parts.push(await extractPdfPage(page, pdfjs));
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------- DOCX ----

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function childrenNS(el, local) {
  const out = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.localName === local && n.namespaceURI === W_NS) out.push(n);
  return out;
}

function runText(r) {
  let s = '';
  for (let n = r.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1 || n.namespaceURI !== W_NS) continue;
    switch (n.localName) {
      case 't': s += n.textContent; break;
      case 'tab': case 'ptab': s += '\t'; break;
      case 'br': { const t = n.getAttributeNS(W_NS, 'type') || n.getAttribute('w:type'); if (!t || t === 'textWrapping') s += '\n'; break; }
      case 'cr': s += '\n'; break;
      case 'noBreakHyphen': s += '-'; break;
      default: break;
    }
  }
  return s;
}

function paragraphText(p) {
  let s = '';
  for (let n = p.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1 || n.namespaceURI !== W_NS) continue;
    if (n.localName === 'r') s += runText(n);
    else if (n.localName === 'hyperlink') for (const r of childrenNS(n, 'r')) s += runText(r);
  }
  return s;
}

export async function extractDocxText(arrayBuffer) {
  const JSZip = await getJSZip();
  const zip = await JSZip.loadAsync(arrayBuffer);
  const entry = zip.file('word/document.xml');
  if (!entry) throw new Error('Bukan file DOCX yang valid (word/document.xml tidak ada).');
  const xml = await entry.async('string');
  const doc = getDOMParser().parseFromString(xml, 'application/xml');
  const body = doc.getElementsByTagNameNS(W_NS, 'body')[0];
  if (!body) throw new Error('Isi dokumen DOCX tidak terbaca.');
  return childrenNS(body, 'p').map(paragraphText).join('\n');
}

// ----------------------------------------------------------------- TXT ----

export function extractPlainText(arrayBuffer) {
  return new TextDecoder('utf-8', { fatal: false }).decode(arrayBuffer).replace(/\uFFFD/g, '');
}

export async function extractTextFromBuffer(arrayBuffer, ext) {
  if (ext === '.pdf') return extractPdfText(arrayBuffer);
  if (ext === '.docx') return extractDocxText(arrayBuffer);
  return extractPlainText(arrayBuffer);
}
