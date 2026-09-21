/*
 * MRI Personal Workspace — small shared helpers.
 *
 * Several helpers exist purely so the browser port behaves the same as the
 * original Python backend (rounding mode, str.splitlines, isdigit, ...).
 * That matters because scores and extraction results must not silently
 * change when the app moves from a server to the browser.
 */

export class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

/** Python-style round(x, nd): exact-decimal, ties to even (NOT Math.round). */
export function pyRound(x, nd = 0) {
  if (x === null || x === undefined || Number.isNaN(x) || !Number.isFinite(x)) return x;
  const neg = x < 0;
  const ax = Math.abs(x);
  // toFixed(n) gives the exact decimal expansion of the double for n <= 100.
  const full = ax.toFixed(Math.min(100, nd + 30));
  const dot = full.indexOf('.');
  const intPart = full.slice(0, dot);
  const frac = full.slice(dot + 1);
  const keep = frac.slice(0, nd);
  const rest = frac.slice(nd);
  let digits = (intPart + keep).split('').map(Number); // integer digits of ax*10^nd (truncated)
  const first = rest.charCodeAt(0) - 48;
  const restAfterFirstIsZero = /^0*$/.test(rest.slice(1));
  let roundUp;
  if (first > 5 || (first === 5 && !restAfterFirstIsZero)) roundUp = true;
  else if (first < 5) roundUp = false;
  else roundUp = digits[digits.length - 1] % 2 === 1; // exact tie -> half to even
  if (roundUp) {
    let i = digits.length - 1;
    while (i >= 0) {
      if (digits[i] === 9) { digits[i] = 0; i--; } else { digits[i]++; break; }
    }
    if (i < 0) digits.unshift(1);
  }
  let s = digits.join('');
  if (nd > 0) s = s.slice(0, s.length - nd) + '.' + s.slice(s.length - nd);
  const v = Number(s);
  return neg && v !== 0 ? -v : v;
}

/** Python str.splitlines() (no trailing empty element). */
export function splitlines(s) {
  if (!s) return [];
  const parts = s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (parts.length && parts[parts.length - 1] === '' ) parts.pop();
  return parts;
}

/** Length in Unicode code points (Python len()). */
export function pylen(s) {
  let n = 0;
  for (const _ of s) n++; // eslint-disable-line no-unused-vars
  return n;
}

/** Python str.isdigit() for a single character. */
export function isDigitChar(ch) {
  return /\p{Nd}|[\u00B2\u00B3\u00B9\u2070\u2074-\u2079\u2080-\u2089]/u.test(ch);
}

export function pySplitWords(s) {
  return s.split(/\s+/).filter(Boolean);
}

/** Python-ish "snippet" cleanup used all over the extractor. */
export function snippetOf(text, start, end) {
  return text.slice(Math.max(0, start), end).replace(/\n/g, ' ').trim();
}

export async function sha256Hex(arrayBuffer) {
  const subtle = (globalThis.crypto && globalThis.crypto.subtle) ? globalThis.crypto.subtle : null;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', arrayBuffer);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(Buffer.from(arrayBuffer)).digest('hex');
}

export function nowIso() { return new Date().toISOString(); }

export function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Whole days between two instants, floored like Python's timedelta.days. */
export function daysBetween(later, earlier) {
  return Math.floor((later.getTime() - earlier.getTime()) / 86400000);
}

/** Days from now until an ISO date (YYYY-MM-DD…); null when unparseable. */
export function contractDaysRemaining(contractEndDate, now = new Date()) {
  if (!contractEndDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(contractEndDate));
  if (!m) return null;
  const end = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const chk = new Date(end);
  if (chk.getUTCFullYear() !== +m[1] || chk.getUTCMonth() !== +m[2] - 1 || chk.getUTCDate() !== +m[3]) return null;
  return Math.floor((end - now.getTime()) / 86400000);
}

export function isValidIsoDate(s) {
  return contractDaysRemaining(String(s).slice(0, 10), new Date()) !== null;
}

export function ymd(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function ymdCompact(d = new Date()) {
  return ymd(d).replace(/-/g, '');
}

export function fileExt(name) {
  const i = (name || '').lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
}

export function safeFilename(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'file';
}

export function deepClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

export function uuid() {
  if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/** Formats a number the way Python prints a float (50 -> "50.0"). */
export function pyFloatStr(n) {
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}
