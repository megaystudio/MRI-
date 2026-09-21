/*
 * MRI Personal Workspace — konfigurasi penjual.
 * File ini satu-satunya yang perlu Anda (penjual) ubah sebelum deploy.
 */
export const CONFIG = {
  APP_NAME: 'MRI — Megay Recruitment Intelligent',
  APP_VERSION: '2.0.0',
  // Data format version written into backups (bump only if the backup layout changes).
  BACKUP_FORMAT: 1,

  // Kunci PUBLIK Ed25519 untuk memverifikasi kode aktivasi Premium/VIP.
  // Buat pasangan kunci sekali dengan seller_tools/generate_keypair.py,
  // lalu tempel kunci PUBLIK-nya di sini. (Nilai di bawah adalah nilai yang
  // sama dengan backend lama, supaya kode aktivasi yang sudah terbit tetap valid.)
  PUBLIC_KEY_HEX: '280ee0ea20a998ece254e96073419539e4f3ef1308c7dc84bdaa18932cc8b862',

  // OAuth Client ID untuk Google Drive (lihat docs/SETUP-GOOGLE-DRIVE.md).
  // Boleh dikosongkan: pengguna tetap bisa memasukkannya sendiri di halaman Google Drive.
  GOOGLE_CLIENT_ID: '235596828540-tjrbjjpk0s3cct67oa2dmi8s4oe4qodo.apps.googleusercontent.com',
};
