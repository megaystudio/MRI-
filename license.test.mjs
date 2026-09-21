import fs from 'node:fs';
import assert from 'node:assert/strict';
import { verifyLicenseText, LicenseError } from '../js/license.js';
const L = JSON.parse(fs.readFileSync(process.argv[2] || '/tmp/licenses.json', 'utf8'));

const p = await verifyLicenseText(L.premium, L.pub);
assert.equal(p.plan, 'PREMIUM'); assert.equal(p.buyer, 'Budi Santoso (Order #123)');
const v = await verifyLicenseText('  ' + L.vip + '\n', L.pub);
assert.equal(v.plan, 'VIP'); assert.equal(v.buyer, 'Nama Dengan Aksén & Emoji ✓');

async function rejects(text, key, re) {
  await assert.rejects(() => verifyLicenseText(text, key), (e) => e instanceof LicenseError && re.test(e.message), `expected rejection ${re} for ${String(text).slice(0, 30)}`);
}
await rejects('', L.pub, /kosong/);
await rejects('abcdef', L.pub, /Format kode akses/);
await rejects('###.###', L.pub, /rusak\/terpotong/);
await rejects(L.wrong_key, L.pub, /tidak valid atau tidak cocok/);
await rejects(L.premium.slice(0, -4) + 'AAAA', L.pub, /tidak valid atau tidak cocok/);   // tampered signature
await rejects(L.bad_plan, L.pub, /bukan untuk paket Premium atau VIP/);
await rejects(L.bad_date, L.pub, /tanggal terbit yang tidak valid/);
await rejects(L.empty_buyer, L.pub, /data pembeli/);
await rejects(L.premium, 'zz', /Konfigurasi kunci/);
// flip one payload character -> signature no longer matches
const [pl, sg] = L.premium.split('.');
await rejects(pl.slice(0, 10) + (pl[10] === 'A' ? 'B' : 'A') + pl.slice(11) + '.' + sg, L.pub, /tidak valid/);
console.log('license: all checks passed (accept Premium/VIP made by seller_tools logic; reject tampered/wrong-key/invalid)');
