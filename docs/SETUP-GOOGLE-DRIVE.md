# Menyiapkan Google Drive (sekali oleh penjual, gratis)

MRI memakai **Google Identity Services** + **Drive API v3** langsung dari browser. Tidak ada server MRI yang
memegang token atau file pengguna. Scope yang diminta hanya `https://www.googleapis.com/auth/drive.file`:
aplikasi hanya bisa melihat file/folder yang **dibuatnya sendiri** (folder "MRI Workspace"), bukan seluruh Drive.

## Langkah di Google Cloud Console (tanpa kartu kredit)
1. https://console.cloud.google.com → buat **proyek baru** (mis. "MRI Workspace").
2. **APIs & Services → Library →** cari **Google Drive API → Enable**.
3. **OAuth consent screen** → User type **External** → isi nama aplikasi, email dukungan, email developer.
   Di *Scopes* tambahkan `.../auth/drive.file` (scope non-sensitif).
4. **Publishing status:** klik **Publish app → In production**.
   - Untuk scope `drive.file` biasanya tidak perlu proses verifikasi Google. Pengguna mungkin tetap melihat
     layar persetujuan standar.
   - Jika dibiarkan **Testing**, hanya email yang Anda daftarkan sebagai *Test users* (maks. 100) yang bisa login — cocok untuk uji awal.
5. **Credentials → Create credentials → OAuth client ID → Web application.**
   - **Authorized JavaScript origins:** `https://<akun-anda>.github.io` (dan `http://localhost:8000` untuk uji lokal). Tanpa path, tanpa `/` di akhir.
   - Redirect URI tidak diperlukan.
6. Salin **Client ID** (`...apps.googleusercontent.com`) ke `config.js` → `GOOGLE_CLIENT_ID`, lalu deploy ulang.
   Client ID bukan rahasia (memang terlihat di browser). **Jangan** membuat/menyalin *client secret* — tidak dipakai.

Pengguna yang tidak ingin bergantung pada Client ID milik Anda bisa membuat Client ID sendiri dengan langkah yang sama
dan memasukkannya di halaman **Google Drive** (disimpan di browser mereka).

## Struktur folder di Drive pengguna
```
MRI Workspace/
  1 Panduan/          Panduan Pengguna MRI.pdf
  2 Template Excel/   Template Import Karyawan / Kriteria Jabatan / Daftar Universitas / Bank Pertanyaan (.xlsx)
  3 Backup Data/      MRI-Backup_<workspace>_<tanggal>.zip
  4 Manual & SOP/     dokumen milik pengguna (diunggah lewat MRI)
  5 File Distribusi/  salinan laporan yang diekspor + file yang ingin dibagikan
```
Karena scope `drive.file`, file yang diletakkan **manual** lewat drive.google.com di folder itu tidak terlihat oleh MRI;
unggahlah lewat halaman Google Drive di MRI.

## Pemecahan masalah
| Gejala | Penyebab umum |
|---|---|
| `redirect_uri_mismatch` / `origin_mismatch` | Origin di Credentials tidak persis sama dengan alamat aplikasi. |
| "Access blocked: app has not completed verification" | App masih *Testing* dan email pengguna belum ada di Test users. |
| Jendela login tidak muncul | Browser memblokir pop-up; izinkan pop-up untuk situs ini. |
| "Google Drive API belum diaktifkan" | Langkah 2 belum dilakukan pada proyek yang sama dengan Client ID. |
| Sesi habis setelah ±1 jam | Normal — token akses berumur pendek; klik "Sambungkan Google Drive" lagi. |
