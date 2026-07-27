import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import { RECOMMENDED_SWARA_VERSION, RECOMMENDED_SWARA_WEIGHTS } from './services/decisionSupport.js';

dotenv.config();

const { Pool } = pg;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL belum diatur. Salin .env.example menjadi .env lalu sesuaikan koneksi PostgreSQL.');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(':');
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

export async function initializeDatabase() {
  const migration = await fs.readFile(path.join(root, 'src-js', 'migrations', '001_initial.sql'), 'utf8');
  await pool.query(migration);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await seedUsers(client);
    await seedPeriods(client);
    await seedCriteria(client);
    await applyRecommendedCriteriaWeights(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}


async function applyRecommendedCriteriaWeights(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  const { rows: [setting] } = await client.query(
    "SELECT value FROM app_settings WHERE key='criteria_weight_version'",
  );
  if (setting?.value === RECOMMENDED_SWARA_VERSION) return;

  for (const [code, weight] of Object.entries(RECOMMENDED_SWARA_WEIGHTS)) {
    await client.query('UPDATE criteria SET weight=$1 WHERE code=$2', [weight, code]);
  }

  await client.query(`UPDATE swara_process_state
    SET weights_ready=TRUE, updated_at=CURRENT_TIMESTAMP
    WHERE id=1`);
  await client.query(`INSERT INTO app_settings (key,value,updated_at)
    VALUES ('criteria_weight_version',$1,CURRENT_TIMESTAMP)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=CURRENT_TIMESTAMP`, [RECOMMENDED_SWARA_VERSION]);
}
async function seedUsers(client) {
  await client.query("UPDATE users SET role='super_admin', business_unit='', account_status='active' WHERE username IN ('admin','hg')");

  const users = [
    ['admin', 'admin123', 'Super Admin SPK', 'super_admin', ''],
    ['sib', 'rekrutmen123', 'Tim Rekrutmen SIB', 'recruiter', 'Sarastya Insan Bertumbuh'],
    ['sti', 'rekrutmen123', 'Tim Rekrutmen STI', 'recruiter', 'Sarastya Technology Innovations'],
    ['sbp', 'rekrutmen123', 'Tim Rekrutmen SBP', 'recruiter', 'Sarastya Business Process'],
    ['appslings', 'rekrutmen123', 'Tim Rekrutmen Appslings', 'recruiter', 'Appslings'],
  ];

  for (const [username, password, name, role, businessUnit] of users) {
    await client.query(
      `INSERT INTO users (username,password,name,role,business_unit,account_status)
       VALUES ($1,$2,$3,$4,$5,'active')
       ON CONFLICT (username) DO UPDATE SET
         name=EXCLUDED.name,
         role=EXCLUDED.role,
         business_unit=EXCLUDED.business_unit,
         account_status='active'`,
      [username, hashPassword(password), name, role, businessUnit],
    );
  }
}

async function seedPeriods(client) {
  const { rows: [{ total }] } = await client.query('SELECT COUNT(*)::int AS total FROM periods');
  if (total > 0) return;
  await client.query(
    'INSERT INTO periods (name,year,status) VALUES ($1,$2,$3)',
    ['Gelombang 2 (Juli-Desember)', 2026, 'active'],
  );
}

async function seedCriteria(client) {
  const { rows: [{ total }] } = await client.query('SELECT COUNT(*)::int AS total FROM criteria');
  if (total > 0) return;

  const criteria = [
    ['K1','Kejujuran dalam Jawaban','benefit',1,0], ['K16','Kualitas Hasil Project Test','benefit',2,.05],
    ['K7','Pemahaman Identitas Sarastya','benefit',3,.10], ['K8','Kemampuan Mencapai Target','benefit',4,.10],
    ['K3','Pemikiran Strategis','benefit',5,.05], ['K4','Inisiatif','benefit',6,.10],
    ['K5','Kemampuan Perencanaan','benefit',7,.10], ['K19','Kemampuan Analisis','benefit',8,.10],
    ['K20','Kemampuan Komunikasi','benefit',9,.05], ['K11','Keterampilan Membangun Kolaborasi Tim','benefit',10,.10],
    ['K9','Kemampuan Menghadapi Tekanan','benefit',11,.10], ['K10','Kemampuan Bangkit dalam Kegagalan','benefit',12,.10],
    ['K13','Kemampuan Belajar Hal Baru','benefit',13,.15], ['K12','Kemampuan Adaptasi terhadap Perubahan','benefit',14,.10],
    ['K14','Kreativitas Hasil','benefit',15,.15], ['K15','Inovasi Hasil','benefit',16,.10],
    ['K17','Kepatuhan terhadap Norma','benefit',17,.15], ['K18','Ketepatan Waktu','cost',18,.10],
    ['K2','Kemampuan untuk Membantu','benefit',19,.15], ['K6','Pemahaman Belief System','benefit',20,.10],
  ];

  for (const criterion of criteria) {
    const { rows: [inserted] } = await client.query(
      'INSERT INTO criteria (code,name,type,priority_order,sj) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      criterion,
    );
    const levels = criterion[0] === 'K18'
      ? [['Lebih cepat dari deadline',1],['Tepat pada deadline',2],['Terlambat dengan izin',3],['Terlambat kurang dari 3 hari tanpa izin',4],['Terlambat 3 hari atau lebih tanpa izin',5]]
      : [['Sangat baik',5],['Baik',4],['Cukup',3],['Kurang',2],['Sangat kurang',1]];
    for (const [label, score] of levels) {
      await client.query(
        'INSERT INTO subcriteria (criterion_id,label,score) VALUES ($1,$2,$3)',
        [inserted.id, label, score],
      );
    }
  }

}
