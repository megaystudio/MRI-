// Regenerates docs/PANDUAN-PENGGUNA.md from js/guide.js (single source of truth).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guideMarkdown } from '../js/guide.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.writeFileSync(path.join(root, 'docs/PANDUAN-PENGGUNA.md'), guideMarkdown());
console.log('docs/PANDUAN-PENGGUNA.md written');
