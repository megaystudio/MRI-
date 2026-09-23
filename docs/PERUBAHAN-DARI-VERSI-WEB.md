# Perubahan dibanding MRI versi Web (multi-tenant)

## Dihapus (sesuai ketentuan konversi)
- Sign-up, login, sesi, ganti password, halaman Manajemen User, semua role (ADMIN/HR/RECRUITER/INTERVIEWER/USER/READ_ONLY).
- Multi-tenant (`workspace_id`), rate-limit login/sign-up, Postgres, Cloudflare R2/S3, Docker/Render/Koyeb/Hugging Face.
- Batas "User/tim" pada paket (`max_users`) — tidak relevan untuk perorangan.

## Tetap
Seluruh modul 01–10 dan logika bisnisnya, lisensi Demo/Premium/VIP (format kode sama), engine AI rule-based, Knowledge Center, Employee Data Center, impor/ekspor Excel & PDF, audit trail, data demo.

## Baru
Data & Backup (unduh/pulihkan ZIP, pindah perangkat), Google Drive (backup, panduan, template, SOP, file distribusi, salinan otomatis laporan),
layar setup awal, mode offline (PWA), penguncian satu-tab, pengingat backup.

## Perbaikan/perbedaan perilaku yang disengaja
| Hal | Sebelumnya | Sekarang |
|---|---|---|
| Batas kandidat Premium (500) | tercantum di tabel paket tetapi **tidak pernah ditegakkan** (hanya Demo yang dicek) | ditegakkan untuk semua paket berbatas |
| Hitungan lowongan untuk batas paket | ikut menghitung lowongan data demo | hanya lowongan nyata (konsisten dengan hitungan kandidat) |
| Paket tersimpan | field `plan` di database | dihitung ulang dari kode aktivasi setiap kali |
| PDF terproteksi password | "Gagal membaca isi file … Detail: " (kosong) | pesan spesifik: dilindungi password |
| Edit karyawan: kolom teks dikosongkan | terhitung sebagai "berubah" dari null → "" | dianggap tidak berubah |
| Skor tahap dengan teks non-angka (mis. `Komunikasi:baik`) | error validasi tak terbaca | pesan jelas: skor harus angka |
| Waktu pada UI | disimpan tanpa zona waktu (UTC) lalu ditampilkan seolah waktu lokal | disimpan ISO-UTC (`Z`), tampil benar di zona waktu pengguna |
| Data demo | PRNG Python | PRNG berbeda (jumlah karyawan dsb. bisa berbeda, tetap konsisten) |
| Nama reviewer di audit trail | username akun | nama pemilik workspace |

## Bukan bagian konversi ini (tidak dikerjakan)
OCR untuk CV hasil scan; enkripsi data/backup dengan passphrase; sinkronisasi otomatis antar perangkat; migrasi data dari server lama
(jika ada data penting di server lama, ekspor lewat Excel/`Export` yang tersedia lalu impor, atau minta migrasi khusus).

## v2.1 — Perbaikan sesuai Catatan Perbaikan MRI Workspace
1. **Job Requirement**: sekarang bisa direview (detail lengkap + statistik pemakaian), diedit (form yang sama dengan pembuatan, validasi penuh, mendeteksi apakah perubahan memengaruhi skor), dan dihapus (konfirmasi bila sudah dipakai untuk screening/tahapan; data terkait di Talent Pool/Employee tidak ikut terhapus, hanya tautannya dilepas).
2. **Import Job Requirement dari Excel**: tombol "Download Template" (dengan dropdown validasi & sheet referensi Knowledge Center) dan "Upload & Import" di halaman Job Requirement; hasil import melaporkan baris valid/duplikat/invalid per baris.
3. **Knowledge Center vs Job Requirement**: sekarang dipisah tegas secara konsep dan navigasi — Job Requirement adalah satu lowongan konkret; Knowledge Center adalah referensi/master data yang dipakai lowongan mana pun.
4. **Knowledge Center sebagai master data**: 10 kategori referensi baru — Posisi, Departemen, Job Level, Lokasi Kerja, Level Pendidikan, Standar IPK, Sertifikasi, Hard Skill, Soft Skill, Sumber CV — dipakai sebagai pilihan (dengan datalist/chip picker) di form Job Requirement, Template Kriteria, dan CV Intake.
5. **Tambah item Knowledge Center**: manual (form tambah di setiap kategori) atau import Excel per kategori maupun sekaligus semua kategori (template multi-sheet dengan Petunjuk).
6. **Screening Center — detail kecocokan**: baris kandidat menampilkan status per kriteria (bukan hanya skor), dan Review/detail baris menampilkan tabel perbandingan penuh Requirement vs CV per kriteria (skor, requirement, apa yang ada di CV, item yang match/tidak) — sama seperti sebelumnya hanya tampil ringkas saat klik Review.
7. **Lihat dokumen CV dari Screening Center**: tombol "Lihat CV" di setiap baris kandidat dan di modal Review membuka file CV asli (render PDF per halaman, atau teks hasil ekstraksi untuk DOCX/TXT) tanpa meninggalkan halaman.
8. **CV Bank & Search**: kolom baru "Dokumen CV" (buka file asli) dan "Hasil Screening" (semua lowongan yang pernah di-screening beserta skor, klik untuk membuka detail) untuk setiap kandidat.
9. **Navigasi di HP**: sidebar diganti drawer yang bisa dibuka dari tombol menu di top bar (atau geser dari tepi layar), bukan sidebar sempit atau top bar tanpa menu — daftar menu penuh tetap tersedia di semua ukuran layar.
