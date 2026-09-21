// Compares browser-side extraction (pdf.js / docx / txt) with the ORIGINAL pdfplumber/python-docx pipeline.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { extractTextFromBuffer } from '../js/extract.js';
import { extractCandidateProfile } from '../js/engine.js';
import { sha256Hex, fileExt } from '../js/util.js';

const require = createRequire(import.meta.url);
const { DOMParser } = require('@xmldom/xmldom');
globalThis.__MRI_DOMParser = DOMParser;

const dir = process.argv[2] || '/tmp/cvfiles';
const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
const words = (t) => t.split(/\s+/).filter(Boolean).sort().join(' ');
let bad = 0, exactText = 0;
for (const rec of expected) {
  const buf = fs.readFileSync(path.join(dir, rec.file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const text = await extractTextFromBuffer(ab, fileExt(rec.file));
  const prof = extractCandidateProfile(text);
  const hash = await sha256Hex(ab);
  const problems = [];
  if (hash !== rec.sha256) problems.push('sha256 differs');
  if (words(text) !== words(rec.text)) problems.push('word multiset differs');
  if (text.trim() === rec.text.trim()) exactText++;
  for (const k of ['name', 'email', 'phone', 'highest_education', 'total_experience_years']) {
    if (JSON.stringify(prof[k]) !== JSON.stringify(rec.profile[k])) problems.push(`${k}: expected ${JSON.stringify(rec.profile[k])} got ${JSON.stringify(prof[k])}`);
  }
  const names = (arr, f) => arr.map(f).sort().join('|');
  if (names(prof.skills, s => s.skill_name) !== names(rec.profile.skills, s => s.skill_name)) problems.push('skills differ');
  if (names(prof.certifications, c => c.name) !== names(rec.profile.certifications, c => c.name)) problems.push('certifications differ');
  if (prof.experiences.length !== rec.profile.experiences.length) problems.push(`experiences ${prof.experiences.length} vs ${rec.profile.experiences.length}`);
  const posOf = (arr) => arr.map(e => `${e.position}@${e.company}`).sort().join('|');
  if (posOf(prof.experiences) !== posOf(rec.profile.experiences)) problems.push(`position/company differ: ${posOf(prof.experiences)} VS ${posOf(rec.profile.experiences)}`);
  if (problems.length) { bad++; console.log(`✗ ${rec.file}: ${problems.join('; ')}`); if (process.env.VERBOSE) console.log('--- js ---\n' + text + '\n--- py ---\n' + rec.text); }
  else console.log(`✓ ${rec.file} (${rec.kind})${text.trim() === rec.text.trim() ? '  text identical' : ''}`);
}
console.log(`${expected.length - bad}/${expected.length} files give the same candidate profile; ${exactText} have byte-identical text`);
assert.equal(bad, 0);
