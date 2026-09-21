# Arsitektur MRI Personal Workspace

```
Repo GitHub ──► GitHub Pages ──► Browser HR
                                   │  index.html + js/*.js (modul ES, tanpa build)
                                   │
                                   ├─ IndexedDB  "mri-workspace"  ← database (data HR + file CV asli)
                                   ├─ localStorage               ← preferensi ringan (waktu backup terakhir, Client ID, status Drive)
                                   ├─ Service Worker             ← cache aplikasi agar bisa dipakai offline
                                   └─ Google Drive (akun pengguna) ← backup, template Excel, panduan, manual/SOP, file distribusi
```
Tidak ada server aplikasi, database server, object storage, maupun akun pengguna. Satu browser-profile = satu workspace = satu orang.

## Dari FastAPI ke browser
UI lama memanggil `fetch('/api/...')`. Agar UI dan bentuk JSON tetap sama, "server" kini ada di browser:
`js/core.js` → `api(path, options)` mencocokkan pola URL yang sama dan menjalankan handler terhadap IndexedDB.

| Sebelumnya (Python) | Sekarang (browser) |
|---|---|
| FastAPI + SQLAlchemy + SQLite/Postgres | `js/db.js` (IndexedDB + cache memori + transaksi + rollback) |
| `ai_engine.py` (ekstraksi & screening) | `js/engine.js` — port baris-demi-baris, hasil identik (lihat pengujian) |
| pdfplumber / python-docx | `js/extract.js` — pdf.js / JSZip+XML (logika 2-kolom & deteksi tabel dipertahankan) |
| openpyxl / reportlab | `js/reports.js` — ExcelJS / jsPDF+autoTable |
| `license.py` (Ed25519, cryptography) | `js/license.js` — Ed25519 (tweetnacl), format kode sama persis |
| Login, sesi, RBAC, multi-user, multi-tenant | dihapus — pemilik workspace = reviewer |
| Cloudflare R2 / disk server untuk CV | tabel `cv_files` di IndexedDB + backup ZIP + Google Drive |
| `demo_data.py` | `js/demo.js` (PRNG berbeda → data demo tidak identik, tetap konsisten & repeatable) |

## Model data
Tabel: `candidates` (pendidikan/pengalaman/skill/sertifikasi tertanam di dalamnya), `cvs`, `job_requirements`, `screenings`
(keputusan HR tertanam), `talent_pool`, `recruitment_stages`, `stage_config`, `employees`, `employee_options`,
`knowledge_*` (3 tabel), `audit_trail`, `batch_upload_jobs` (file per batch tertanam), plus `meta` (profil, lisensi, counter ID)
dan `cv_files` (biner CV asli). ID selalu naik dan tidak dipakai ulang.

## Keputusan desain penting
- **Satu penulis:** Web Locks memastikan hanya satu tab yang membuka workspace (dua tab menulis ke DB yang sama akan saling menimpa).
- **Atomik:** setiap operasi tulis berjalan dalam satu transaksi IndexedDB; jika gagal, memori dimuat ulang dari disk (tidak ada data setengah jadi).
- **Paket dihitung ulang dari kode aktivasi** setiap kali (bukan dari field "plan" yang tersimpan), sehingga mengedit database tidak mengubah paket.
- **Data offline-first:** semua pustaka di-host sendiri di `vendor/` (tanpa CDN, font juga lokal). Satu-satunya panggilan jaringan adalah Google (login + Drive) bila pengguna menyambungkannya.
- **Backup = ZIP biasa** (`manifest.json`, `data.json`, `cv_files/`). Restore mengganti seluruh workspace dan memvalidasi berkas sebelum menyentuh data.

## Risiko yang melekat pada model "data di browser"
1. Data hilang jika pengguna menghapus data situs / mengganti perangkat tanpa backup → ada banner pengingat backup (≥7 hari), permintaan penyimpanan persisten, dan fitur backup ke Drive.
2. Safari dapat menghapus data situs yang lama tidak dibuka → wajib backup rutin.
3. Data tidak terenkripsi di disk (sama seperti data browser lainnya) → gunakan perangkat pribadi yang terkunci; file backup berisi data pribadi kandidat.
4. Lisensi tidak bisa dijamin anti-bajak (kode publik, dijalankan di klien).

## Pengujian (folder `tests/`)
| Berkas | Yang dibuktikan |
|---|---|
| `parity_engine.py` + `parity.test.mjs` | 1.510 teks CV & 2.500 skenario screening: keluaran engine JS **identik** dengan `ai_engine.py` asli |
| `make_test_files.py`, `make_chrome_pdfs.py` + `files.test.mjs` | 22 file PDF/DOCX/TXT (reportlab & Chromium; 1 kolom, 2 kolom, tabel, sidebar): teks hasil ekstraksi identik dengan pdfplumber/python-docx, hash SHA-256 sama |
| `scenario_reference.py` + `services.test.mjs` | 93 respons layanan (kandidat, screening, keputusan, stage, karyawan, impor Excel, knowledge, dashboard, audit, demo, lisensi, error) identik dengan backend FastAPI asli |
| `license.test.mjs` | kode dari logika `seller_tools` diterima; kode rusak/ditandatangani kunci lain/dimodifikasi ditolak |
| `extra.test.mjs` | file cacat, batas paket, tamper lisensi, batch, rollback, persistensi, backup/restore, ekspor, klien Drive (server Drive tiruan) |
| `e2e.py` | Chromium sungguhan: seluruh alur UI termasuk backup → hapus → pulihkan, Drive (Google ditiru), tab ganda, mode offline |
