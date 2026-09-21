# Deploy ke GitHub Pages (gratis, tanpa kartu kredit, tanpa menunggu approval)

Alur: **MRI → GitHub Repo → GitHub Pages → Browser HR → IndexedDB (& Local Storage) → Google Drive.**
Aplikasi ini murni file statis (tanpa server, tanpa build), jadi cukup mengunggah isi folder ini ke repositori.

## Persyaratan
- Akun GitHub gratis (cukup verifikasi email — tidak perlu kartu pembayaran).
- **Repositori harus Publik** pada paket GitHub Free. (Repo privat + Pages butuh paket berbayar.)
  Konsekuensinya: siapa pun bisa membaca kode aplikasi — lihat catatan lisensi di `seller_tools/README.md`.
  Data kandidat **tidak** ikut publik: data hanya ada di browser masing-masing pengguna.

## Langkah 1 — Siapkan `config.js`
1. Buat pasangan kunci lisensi (sekali saja) dengan `seller_tools/generate_keypair.py`, lalu tempel **public key** ke `config.js` → `PUBLIC_KEY_HEX`.
2. (Opsional tapi disarankan) isi `GOOGLE_CLIENT_ID` (lihat `SETUP-GOOGLE-DRIVE.md`) agar semua pengguna langsung bisa memakai Google Drive.
3. Jalankan sekali setelah mengubah file apa pun: `node tools/build_sw.mjs` (memperbarui cache offline `sw.js`).
   Tanpa Node.js pun aplikasi tetap jalan; hanya cache offline yang tidak ikut diperbarui.

## Langkah 2 — Unggah ke GitHub
**Cara mudah (tanpa Git):** buat repositori baru (Public) → *Add file → Upload files* → seret **isi** folder `mri-personal-workspace`
(index.html, config.js, sw.js, manifest.webmanifest, folder css, js, vendor, icons, docs, dst — jangan `node_modules`).
Jika browser membatasi jumlah file per unggahan, unggah per folder (`vendor`, `js`, `css`, `icons`).

**Cara Git:**
```bash
cd mri-personal-workspace
git init && git add . && git commit -m "MRI Personal Workspace"
git branch -M main
git remote add origin https://github.com/<akun-anda>/<nama-repo>.git
git push -u origin main
```

## Langkah 3 — Aktifkan Pages
Repositori → **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main`, folder `/ (root)` → Save.**
Dalam 1–3 menit alamatnya muncul: `https://<akun-anda>.github.io/<nama-repo>/`. Itulah alamat yang Anda berikan ke pembeli.

## Langkah 4 — Cek
1. Buka alamat tersebut → muncul layar "Selamat datang di Workspace Pribadi Anda".
2. Buat workspace uji → Load Demo Data → coba unggah CV.
3. Menu **Paket & Upgrade**: uji kode aktivasi yang Anda terbitkan sendiri.
4. Jika Drive dikonfigurasi: **Google Drive → Sambungkan**. Origin yang didaftarkan di Google harus persis `https://<akun-anda>.github.io` (tanpa `/<nama-repo>`).

## Memperbarui aplikasi
Ubah file → `node tools/build_sw.mjs` → push. Pengguna mendapat notifikasi "Versi baru tersedia" dan cukup memuat ulang (F5).
Data pengguna tidak tersentuh karena tersimpan di browser mereka, bukan di repositori.

## Catatan penting
- `file://` (klik ganda index.html) **tidak bisa** dipakai — browser memblokir modul JavaScript. Uji lokal dengan `python3 -m http.server` lalu buka `http://localhost:8000`.
- Data pengguna terikat pada **alamat (origin)**. Jika Anda pindah domain (mis. dari `user.github.io` ke domain sendiri), pengguna harus memindahkan data lewat Backup → Restore.
- Alternatif hosting gratis tanpa kartu yang memakai file yang sama: Cloudflare Pages, Netlify (keduanya mengizinkan repo privat).
