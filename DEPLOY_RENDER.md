# Deploy Sistem SPK Sarastya ke Render

Panduan ini memakai Render Blueprint agar web service Node.js dan database PostgreSQL dibuat otomatis dari `render.yaml`.

## 1. Pastikan project sudah di GitHub

Upload isi folder project ini ke repository GitHub. Jangan upload file `.env` dan folder `node_modules`.

## 2. Buat deploy di Render

1. Masuk ke https://dashboard.render.com
2. Pilih `New`
3. Pilih `Blueprint`
4. Hubungkan repository GitHub project ini
5. Render akan membaca file `render.yaml`
6. Klik `Apply`

## 3. Tunggu proses selesai

Render akan membuat:

- Web service `spk-pkl-sarastya`
- PostgreSQL database `spk-sarastya-db`
- `DATABASE_URL` otomatis dari database
- `SESSION_SECRET` otomatis secara acak
- `NODE_ENV=production`

## 4. Buka aplikasi

Setelah deploy sukses, Render memberi URL seperti:

```text
https://spk-pkl-sarastya.onrender.com
```

Login awal:

```text
Username: admin
Password: admin123
```

Segera ganti password atau buat akun admin baru jika sistem dipakai sungguhan.

## Catatan

- Aplikasi memakai PostgreSQL online dari Render.
- Migrasi tabel dan data awal berjalan otomatis saat aplikasi start.
- Import Excel tetap bisa digunakan, file import hanya disimpan sementara.
- Jika deploy gagal, buka menu `Logs` di Render untuk melihat pesan error.
