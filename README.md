# SPK Seleksi PKL/Magang Sarastya

Aplikasi Node.js untuk seleksi peserta PKL/Magang menggunakan pembobotan SWARA, perangkingan MABAC, dan database PostgreSQL.

## Persyaratan

- Node.js 20 atau lebih baru
- PostgreSQL 14 atau lebih baru

## Menyiapkan database

Masuk ke PostgreSQL melalui pgAdmin atau `psql`, kemudian buat database:

```sql
CREATE DATABASE spk_sarastya;
```

Salin `.env.example` menjadi `.env`, lalu sesuaikan username dan password PostgreSQL:

```env
DATABASE_URL=postgresql://postgres:password@localhost:5432/spk_sarastya
SESSION_SECRET=ganti-dengan-secret-yang-aman
PORT=3000
NODE_ENV=development
```

## Menjalankan aplikasi

```powershell
npm install
npm run dev
```

Buka `http://localhost:3000`.

Tabel, data awal, 20 kriteria, subkriteria, dan bobot SWARA dibuat otomatis saat aplikasi pertama dijalankan.

Tim Rekrutmen dapat menetapkan kandidat sebagai diterima atau ditolak melalui halaman hasil MABAC. Keputusan tersebut menjadi sumber angka `Jumlah Diterima` pada dashboard.

Dashboard menampilkan jumlah pendaftar, diterima, ditolak, serta komposisi asal instansi SMK dan perguruan tinggi. Jenis instansi dipilih saat kandidat ditambahkan agar rekap tidak bergantung pada penulisan nama instansi.

## Import data Google Form

Menu Data Kandidat menyediakan import file Excel hasil Google Form. Kolom yang dibaca otomatis:

- `Nama Lengkap`
- `Nama Sekolah/Kampus`
- `Jurusan/Bidang Studi`
- `Pilih Bidang Magang Sesuai dengan Minat Kamu`, `Pilih Bidang yang Kamu Minati`, atau kolom minat bidang lain yang terisi
- `Pilih Unit Bisnis Sesuai Minat` jika nilainya sudah sesuai dengan daftar unit bisnis sistem

Jika file Excel belum memakai nama unit bisnis baru, sistem memakai fallback internal. Unit bisnis yang digunakan pada perangkingan adalah:

- Sarastya Insan Bertumbuh
- Sarastya Technology Innovations
- Sarastya Business Process
- Appslings

Perangkingan MABAC dan pengisian penilaian kandidat dipisahkan berdasarkan periode seleksi dan unit bisnis. Dengan begitu kandidat Sarastya Insan Bertumbuh, Sarastya Technology Innovations, Sarastya Business Process, dan Appslings tidak tercampur dalam satu hasil ranking.

## Alur pembobotan SWARA

1. Ranking empat decision maker, rata-rata, ranking final, Sj, Kj, Qj, dan Wj dihitung melalui workbook Excel.
2. Tim Rekrutmen memasukkan bobot akhir Wj untuk setiap kriteria ke dalam sistem.
3. Sistem memastikan seluruh bobot berada pada rentang 0-1 dan total bobot tepat sama dengan 1.
4. Bobot yang valid disimpan dan digunakan pada perhitungan MABAC.

## Akun awal

- Tim Rekrutmen: `admin` / `admin123`
- HG SAI: `hg` / `hg123`

Pengguna baru dapat mendaftar melalui halaman registrasi. Demi keamanan, registrasi publik hanya membuat akun dengan peran HG SAI; akun Tim Rekrutmen tetap dikelola secara internal.

Ganti password akun awal sebelum aplikasi digunakan pada lingkungan produksi.

## Pengujian

```powershell
npm test
```

K18 Ketepatan Waktu tetap menggunakan tipe `cost`: skor 1 adalah kondisi terbaik dan skor 5 adalah kondisi terburuk.
