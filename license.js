/*
 * MRI — Premium/VIP license verification (browser port of backend/license.py).
 *
 * Fully offline: a license is  base64url(payload) + "." + base64url(signature)
 * where the signature is Ed25519 over the payload bytes. This file only knows
 * the seller's PUBLIC key (config.js), which can verify but never create a
 * license. Codes are produced with seller_tools/generate_license.py, exactly
 * as before — existing codes keep working as long as the public key is the
 * same.
 *
 * HONEST LIMITATION: the whole app runs in the user's browser, so anyone who
 * edits their local copy of the code can bypass this check. It stops honest
 * users from activating a plan they did not buy; it is not copy protection.
 * (It also does not bind a code to one device — same trade-off as before.)
 */
import { getNacl } from './vendor.js';

export class LicenseError extends Error {}

function b64urlToBytes(str) {
  const padded = str + '='.repeat((4 - (str.length % 4)) % 4);
  const norm = padded.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(norm)) throw new Error('bad base64');
  const bin = atob(norm);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexToBytes(hex) {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2) throw new Error('bad hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function isIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/**
 * Returns the decoded payload {buyer, plan, issued} or throws LicenseError
 * with a message that can be shown to the user directly.
 */
export async function verifyLicenseText(licenseText, publicKeyHex) {
  if (!licenseText || !licenseText.trim()) {
    throw new LicenseError('Kode akses kosong. Tempel kode akses Premium yang kamu terima dari penjual.');
  }
  const text = licenseText.trim();
  if (!text.includes('.')) {
    throw new LicenseError('Format kode akses tidak dikenali — pastikan disalin lengkap tanpa terpotong.');
  }
  const cut = text.lastIndexOf('.');
  const payloadB64 = text.slice(0, cut);
  const sigB64 = text.slice(cut + 1);

  let payloadBytes, sigBytes;
  try {
    payloadBytes = b64urlToBytes(payloadB64);
    sigBytes = b64urlToBytes(sigB64);
  } catch (_) {
    throw new LicenseError('Kode akses tidak valid (mungkin rusak/terpotong saat disalin).');
  }

  let keyBytes;
  try { keyBytes = hexToBytes(publicKeyHex || ''); } catch (_) { keyBytes = null; }
  if (!keyBytes || keyBytes.length !== 32) {
    throw new LicenseError('Konfigurasi kunci lisensi aplikasi tidak valid (hubungi penjual).');
  }

  const nacl = await getNacl();
  let ok = false;
  try { ok = sigBytes.length === 64 && nacl.sign.detached.verify(payloadBytes, sigBytes, keyBytes); } catch (_) { ok = false; }
  if (!ok) throw new LicenseError('Kode akses tidak valid atau tidak cocok dengan aplikasi ini.');

  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes)); } catch (_) {
    throw new LicenseError('Kode akses rusak (isi tidak terbaca).');
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new LicenseError('Kode akses rusak (format data tidak valid).');
  }
  if (payload.plan !== 'PREMIUM' && payload.plan !== 'VIP') {
    throw new LicenseError('Kode akses ini bukan untuk paket Premium atau VIP.');
  }
  if (typeof payload.buyer !== 'string' || !payload.buyer.trim()) {
    throw new LicenseError('Kode akses tidak lengkap (data pembeli tidak ditemukan).');
  }
  if (typeof payload.issued !== 'string') {
    throw new LicenseError('Kode akses tidak lengkap (tanggal terbit tidak ditemukan).');
  }
  if (!isIsoDate(payload.issued)) {
    throw new LicenseError('Kode akses memiliki tanggal terbit yang tidak valid.');
  }
  return payload;
}
