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
