# MRI — Megay Recruitment Intelligent · Personal Workspace

Workspace rekrutmen pribadi untuk seorang HR. Aplikasi web statis: **tanpa server, tanpa akun, tanpa biaya hosting**.

- **Data** (kandidat, CV asli, lowongan, screening, keputusan, karyawan) → **IndexedDB di browser pengguna**.
- **Google Drive pengguna** → backup, template Excel, panduan, manual/SOP, file distribusi.
- **Backup / Restore / Import backup** → pindah perangkat cukup dengan satu file `.zip`.
- **Lisensi Demo / Premium / VIP** tetap berlaku (kode aktivasi Ed25519, diverifikasi offline).
- **Deploy:** GitHub Pages (gratis, tanpa kartu kredit, tanpa approval).

```
MRI → GitHub Repo → GitHub Pages → Browser HR → IndexedDB & localStorage → Google Drive
```

## Mulai cepat
| Ingin… | Baca |
|---|---|
| Menaruh aplikasi online | [`docs/DEPLOY-GITHUB-PAGES.md`](docs/DEPLOY-GITHUB-PAGES.md) |
| Mengaktifkan Google Drive | [`docs/SETUP-GOOGLE-DRIVE.md`](docs/SETUP-GOOGLE-DRIVE.md) |
| Menerbitkan kode Premium/VIP | `seller_tools/README.md` (folder terpisah, jangan di-push) |
| Memahami rancangan & pengujian | [`docs/ARSITEKTUR.md`](docs/ARSITEKTUR.md) |
| Tahu apa yang berubah dari versi Web | [`docs/PERUBAHAN-DARI-VERSI-WEB.md`](docs/PERUBAHAN-DARI-VERSI-WEB.md) |
| Panduan untuk pengguna akhir | [`docs/PANDUAN-PENGGUNA.md`](docs/PANDUAN-PENGGUNA.md) |

## Coba di komputer sendiri
```bash
python3 -m http.server 8000      # lalu buka http://localhost:8000
```
(Klik ganda `index.html` tidak bisa — browser memblokir modul JavaScript dari `file://`.)

## Paket
| Paket | Kandidat nyata | Lowongan | Export laporan |
|---|---:|---:|:---:|
| Demo | 15 | 3 | ❌ |
| Premium | 500 | 50 | ✅ |
| VIP | Unlimited | Unlimited | ✅ |

## Struktur
```
index.html · config.js · sw.js · manifest.webmanifest
css/        gaya antarmuka (font di-host sendiri)
js/         app.js (UI) + services (db, engine, extract, reports, license, backup, drive, demo, guide)
vendor/     pdf.js, ExcelJS, jsPDF, JSZip, TweetNaCl, font — di-host sendiri, tanpa CDN
docs/       panduan & dokumentasi
tests/      pengujian otomatis (bandingkan dengan backend Python asli + uji browser sungguhan)
tools/      build_sw.mjs (cache offline), build_docs.mjs
```

## Browser yang didukung
Chrome/Edge/Firefox/Safari versi terbaru (perlu IndexedDB, ES modules, Web Crypto, lookbehind regex → Safari 16.4+, Chrome 96+, Firefox 102+).
