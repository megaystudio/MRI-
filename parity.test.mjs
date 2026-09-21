// Compares the JS engine with the ORIGINAL Python engine on a shared corpus.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { extractCandidateProfile, screenCandidate } from '../js/engine.js';

const file = process.argv[2] || '/tmp/parity.json';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

function diff(a, b, path = '') {
  if (a === b) return null;
  if (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return `${path}: expected ${JSON.stringify(a)} got ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array mismatch`;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) { const d = diff(a[k], b[k], `${path}.${k}`); if (d) return d; }
  return null;
}

let extractionFails = 0, screeningFails = 0;
data.texts.forEach((t, i) => {
  const got = extractCandidateProfile(t);
  const d = diff(data.extraction[i], got);
  if (d) { extractionFails++; if (extractionFails <= 5) console.log(`EXTRACTION #${i}:`, d, '\n--- text ---\n' + t.slice(0, 400)); }
});
data.screening.forEach((s, i) => {
  const got = screenCandidate(s.candidate, s.vacancy);
  const d = diff(s.expected, got);
  if (d) { screeningFails++; if (screeningFails <= 5) console.log(`SCREENING #${i}:`, d, JSON.stringify(s.candidate), JSON.stringify(s.vacancy)); }
});
console.log(`extraction: ${data.texts.length - extractionFails}/${data.texts.length} identical`);
console.log(`screening : ${data.screening.length - screeningFails}/${data.screening.length} identical`);
assert.equal(extractionFails + screeningFails, 0);
