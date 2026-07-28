import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs/promises';
import multer from 'multer';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, initializeDatabase, pool, verifyPassword } from './database.js';
import { BUSINESS_UNITS, parseCandidateSpreadsheet } from './services/candidateImport.js';
import { criteriaDetails } from './services/criteriaDetails.js';
import {
  calculateMabac,
  parseWeight,
  RECOMMENDED_SWARA_WEIGHTS,
  validateWeights,
} from './services/decisionSupport.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const importDir = process.env.VERCEL
  ? path.join(os.tmpdir(), 'spk-sarastya-imports')
  : path.join(root, 'tmp', 'imports');
await initializeDatabase();
await fs.mkdir(importDir, { recursive: true });

const app = express();
const PgSessionStore = connectPgSimple(session);
const PERIOD_NAME_OPTIONS = [
  'Gelombang 1 (Januari-Juni)',
  'Gelombang 2 (Juli-Desember)',
];
const upload = multer({
  dest: importDir,
  limits: { fileSize: 5 * 1024 * 1024 },
});

app.set('view engine', 'ejs');
app.set('views', path.join(root, 'views'));
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(root, 'public')));
app.use('/public', express.static(path.join(root, 'public')));
app.use(session({
  store: new PgSessionStore({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'ganti-secret-saat-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000,
  },
}));

app.use((req, res, next) => {
  req.session.csrf ??= crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  res.locals.user = req.session.user || null;
  res.locals.page = '';
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.businessUnits = BUSINESS_UNITS;
  res.locals.number = (value, digits = 4) => Number(value).toFixed(digits);
  res.locals.datetime = (value) => value ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' }).format(new Date(value)) : 'Belum tercatat';
  next();
});

function flash(req, message, type = 'success') {
  req.session.flash = { message, type };
}

function parseBulkWeights(text = '') {
  const result = {};
  const pattern = /\b([KC]\d{1,2})\b\s*(?:=|:|-)?\s*([0-9]+(?:[.,][0-9]+)?)/gi;
  for (const match of String(text).matchAll(pattern)) {
    const code = match[1].toUpperCase().replace(/^C/, 'K');
    result[code] = match[2];
  }
  return result;
}

function firstValidWeight(...values) {
  return values.find((value) => {
    const parsed = parseWeight(value);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1;
  });
}

function requireCsrf(req, res, next) {
  if (!req.body.csrf || req.body.csrf !== req.session.csrf) return res.status(419).send('Sesi formulir kedaluwarsa.');
  next();
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function recruiterOnly(req, res, next) {
  if (req.session.user?.role !== 'recruiter') return res.status(403).send('Akses hanya tersedia untuk Tim Rekrutmen.');
  next();
}

function isSuperAdmin(user) {
  return user?.role === 'super_admin';
}

function canRecruit(user) {
  return user?.role === 'recruiter' || isSuperAdmin(user);
}

function requireRecruitmentAccess(req, res, next) {
  if (!canRecruit(req.session.user)) return res.status(403).send('Akses hanya tersedia untuk Super Admin SPK atau Tim Rekrutmen.');
  next();
}

function superAdminOnly(req, res, next) {
  if (!isSuperAdmin(req.session.user)) return res.status(403).send('Akses hanya tersedia untuk Super Admin SPK.');
  next();
}

function normalizeBusinessUnitInput(value) {
  return BUSINESS_UNITS.includes(value) ? value : BUSINESS_UNITS[0];
}

function scopedBusinessUnit(req, value) {
  if (req.session.user?.role === 'recruiter') return req.session.user.business_unit;
  return normalizeBusinessUnitInput(value);
}
function makePagination(totalItems, rawPage, perPage = 20) {
  const total = Number(totalItems || 0);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const parsedPage = Number.parseInt(rawPage, 10);
  const page = Math.min(Math.max(Number.isFinite(parsedPage) ? parsedPage : 1, 1), totalPages);
  const offset = (page - 1) * perPage;
  const pages = [];
  const start = Math.max(1, page - 2);
  const end = Math.min(totalPages, page + 2);
  for (let item = start; item <= end; item += 1) pages.push(item);
  return {
    page,
    perPage,
    totalItems: total,
    totalPages,
    offset,
    startItem: total ? offset + 1 : 0,
    endItem: Math.min(offset + perPage, total),
    pages,
  };
}

app.get('/health', (req, res) => res.status(200).send('ok'));
app.get('/', (req, res) => res.redirect(req.session.user ? '/dashboard' : '/login'));
app.get('/login', (req, res) => res.render('login', { title: 'Masuk' }));
app.get('/register', (req, res) => res.render('register', { title: 'Daftar Akun', businessUnits: BUSINESS_UNITS }));
app.post('/register', requireCsrf, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const confirmation = String(req.body.password_confirmation || '');
  const businessUnit = normalizeBusinessUnitInput(req.body.business_unit);

  if (name.length < 3 || username.length < 4) {
    flash(req, 'Nama minimal 3 karakter dan username minimal 4 karakter.', 'error');
    return res.redirect('/register');
  }
  if (password.length < 8 || password !== confirmation) {
    flash(req, 'Password minimal 8 karakter dan konfirmasi harus sama.', 'error');
    return res.redirect('/register');
  }

  try {
    await pool.query(
      'INSERT INTO users (username,password,name,role,business_unit,account_status) VALUES ($1,$2,$3,$4,$5,$6)',
      [username, hashPassword(password), name, 'recruiter', businessUnit, 'pending'],
    );
  } catch (error) {
    if (error.code === '23505') {
      flash(req, 'Username sudah digunakan.', 'error');
      return res.redirect('/register');
    }
    throw error;
  }

  flash(req, 'Pendaftaran Tim Rekrutmen Berhasil, silahkan tunggu konfirmasi dari HG Sarastya');
  res.redirect('/login');
});
app.post('/login', requireCsrf, async (req, res) => {
  const { rows: [account] } = await pool.query(
    'SELECT * FROM users WHERE username=$1',
    [String(req.body.username).trim()],
  );
  if (!account || !verifyPassword(String(req.body.password), account.password)) {
    flash(req, 'Username atau password tidak sesuai.', 'error');
    return res.redirect('/login');
  }
  if (account.account_status !== 'active') {
    flash(req, account.account_status === 'pending'
      ? 'Akun Tim Rekrutmen masih menunggu persetujuan Super Admin SPK.'
      : 'Akun Tim Rekrutmen ditolak atau dinonaktifkan.',
    'error');
    return res.redirect('/login');
  }
  const { password, ...safeAccount } = account;
  req.session.user = safeAccount;
  res.redirect('/dashboard');
});
app.get('/profile', requireAuth, (req, res) => {
  res.render('profile', { title: 'Edit Profil', page: 'profile' });
});

app.post('/profile', requireAuth, requireCsrf, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const confirmation = String(req.body.password_confirmation || '');

  if (name.length < 3 || username.length < 4) {
    flash(req, 'Nama minimal 3 karakter dan username minimal 4 karakter.', 'error');
    return res.redirect('/profile');
  }
  if (password && (password.length < 8 || password !== confirmation)) {
    flash(req, 'Password baru minimal 8 karakter dan konfirmasi harus sama.', 'error');
    return res.redirect('/profile');
  }

  try {
    const params = [name, username, req.session.user.id];
    const passwordSql = password ? ', password=$4' : '';
    if (password) params.push(hashPassword(password));

    const { rows: [account] } = await pool.query(
      `UPDATE users
       SET name=$1, username=$2${passwordSql}
       WHERE id=$3
       RETURNING id,username,name,role,business_unit,account_status,created_at`,
      params,
    );

    req.session.user = account;
    flash(req, 'Profil berhasil diperbarui.');
    res.redirect('/profile');
  } catch (error) {
    if (error.code === '23505') {
      flash(req, 'Username sudah digunakan.', 'error');
      return res.redirect('/profile');
    }
    throw error;
  }
});

app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.get('/users', requireAuth, superAdminOnly, async (req, res) => {
  const { rows: users } = await pool.query(`SELECT u.id,u.username,u.name,u.role,u.business_unit,u.account_status,u.created_at,
      COUNT(cs.candidate_id)::int AS score_count
    FROM users u
    LEFT JOIN candidate_scores cs ON cs.scored_by_user_id=u.id
    WHERE u.role='recruiter'
    GROUP BY u.id
    ORDER BY
      CASE u.account_status
        WHEN 'pending' THEN 1
        WHEN 'active' THEN 2
        WHEN 'inactive' THEN 3
        ELSE 4
      END,
      u.created_at DESC,u.id DESC`);
  res.render('users', { title: 'Kelola Akun Tim Rekrutmen', page: 'users', users });
});

app.post('/users/:id/status', requireAuth, superAdminOnly, requireCsrf, async (req, res) => {
  const status = ['pending', 'active', 'inactive', 'rejected'].includes(req.body.account_status) ? req.body.account_status : 'pending';
  const businessUnit = normalizeBusinessUnitInput(req.body.business_unit);
  if (status === 'rejected') {
    const { rowCount } = await pool.query(
      "DELETE FROM users WHERE id=$1 AND role='recruiter' AND account_status='pending'",
      [Number(req.params.id)],
    );
    flash(req, rowCount ? 'Pendaftaran Tim Rekrutmen berhasil ditolak dan akun dihapus dari daftar.' : 'Akun Tim Rekrutmen tidak ditemukan atau sudah pernah aktif.', rowCount ? 'success' : 'error');
    return res.redirect('/users');
  }

  const { rowCount } = await pool.query(
    "UPDATE users SET account_status=$1,business_unit=$2 WHERE id=$3 AND role='recruiter'",
    [status, businessUnit, Number(req.params.id)],
  );
  flash(req, rowCount ? 'Status akun Tim Rekrutmen berhasil diperbarui.' : 'Akun Tim Rekrutmen tidak ditemukan.', rowCount ? 'success' : 'error');
  res.redirect('/users');
});

app.post('/users/:id/inactivate', requireAuth, superAdminOnly, requireCsrf, async (req, res) => {
  const { rowCount } = await pool.query(
    "UPDATE users SET account_status='inactive' WHERE id=$1 AND role='recruiter' AND account_status='active'",
    [Number(req.params.id)],
  );
  flash(req, rowCount ? 'Akun Tim Rekrutmen berhasil dinonaktifkan. Riwayat penilaian tetap tersimpan.' : 'Akun Tim Rekrutmen tidak ditemukan atau sudah nonaktif.', rowCount ? 'success' : 'error');
  res.redirect('/users');
});

app.get('/dashboard', requireAuth, async (req, res) => {
  const { rows: periods } = await pool.query('SELECT * FROM periods ORDER BY year DESC,id DESC');
  const requestedPeriodId = Number(req.query.period_id || 0);
  const periodId = periods.some((period) => period.id === requestedPeriodId)
    ? requestedPeriodId
    : periods.find((period) => period.status === 'active')?.id || periods[0]?.id || 0;
  const activePeriod = periods.find((period) => period.status === 'active') || periods[0] || null;
  const selectedPeriod = periods.find((period) => period.id === periodId) || activePeriod;
  const dashboardParams = [periodId];
  let dashboardBusinessUnitScope = '';
  if (req.session.user.role === 'recruiter') {
    dashboardParams.push(req.session.user.business_unit);
    dashboardBusinessUnitScope = ` AND c.business_unit=$${dashboardParams.length}`;
  }

  const uniqueCandidatesCte = `WITH candidate_rows AS (
      SELECT c.*,
        (SELECT COUNT(*)::int FROM candidate_scores cs WHERE cs.candidate_id=c.id) AS score_count
      FROM candidates c
      WHERE c.period_id=$1${dashboardBusinessUnitScope}
    ),
    unique_candidates AS (
      SELECT *,
        ROW_NUMBER() OVER (
          PARTITION BY
            LOWER(TRIM(name)),
            LOWER(TRIM(institution)),
            LOWER(TRIM(major)),
            LOWER(TRIM(interest)),
            business_unit,
            period_id
          ORDER BY score_count DESC,id ASC
        ) AS duplicate_rank
      FROM candidate_rows
    )`;

  const [
    { rows: [summary] },
    { rows: statusRows },
    { rows: unitRows },
  ] = await Promise.all([
    pool.query(`${uniqueCandidatesCte}
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE selection_status='accepted')::int AS accepted,
        COUNT(*) FILTER (WHERE selection_status='rejected')::int AS rejected,
        COUNT(*) FILTER (WHERE institution_type='smk')::int AS smk,
        COUNT(*) FILTER (WHERE institution_type='university')::int AS university
      FROM unique_candidates
      WHERE duplicate_rank=1`, dashboardParams),
    pool.query(`${uniqueCandidatesCte}
      SELECT selection_status, COUNT(*)::int AS total
      FROM unique_candidates
      WHERE duplicate_rank=1 AND selection_status IN ('accepted','rejected')
      GROUP BY selection_status`, dashboardParams),
    pool.query(`${uniqueCandidatesCte}
      SELECT business_unit,
        COUNT(*) FILTER (WHERE selection_status='accepted')::int AS accepted,
        COUNT(*) FILTER (WHERE selection_status='rejected')::int AS rejected
      FROM unique_candidates
      WHERE duplicate_rank=1
      GROUP BY business_unit`, dashboardParams),
  ]);

  const stats = {
    'Jumlah Pendaftar': summary.total,
    'Jumlah Diterima': summary.accepted,
    'Jumlah Ditolak': summary.rejected,
    'Pendaftar dari SMK': summary.smk,
    'Pendaftar dari Perguruan Tinggi': summary.university,
  };
  const statusTotals = Object.fromEntries(statusRows.map((row) => [row.selection_status, row.total]));
  const unitTotals = new Map(unitRows.map((row) => [row.business_unit, row]));
  const institutionChart = [
    { label: 'SMK', value: summary.smk, className: 'smk' },
    { label: 'Perguruan Tinggi', value: summary.university, className: 'university' },
  ];
  const statusChart = [
    { label: 'Diterima', value: statusTotals.accepted || 0, className: 'accepted' },
    { label: 'Ditolak', value: statusTotals.rejected || 0, className: 'rejected' },
  ];
  const dashboardUnits = req.session.user.role === 'recruiter' ? [req.session.user.business_unit] : BUSINESS_UNITS;
  const unitStatusChart = dashboardUnits.map((unit) => ({
    unit,
    accepted: unitTotals.get(unit)?.accepted || 0,
    rejected: unitTotals.get(unit)?.rejected || 0,
  }));

  res.render('dashboard', {
    title: 'Dashboard',
    page: 'dashboard',
    stats,
    periods,
    periodId,
    activePeriod,
    selectedPeriod,
    institutionChart,
    statusChart,
    unitStatusChart,
  });
});

app.get('/periods', requireAuth, superAdminOnly, async (req, res) => {
  const { rows: periods } = await pool.query(`WITH unique_candidates AS (
      SELECT DISTINCT ON (
        period_id,
        business_unit,
        LOWER(TRIM(name)),
        LOWER(TRIM(institution)),
        LOWER(TRIM(major)),
        LOWER(TRIM(interest))
      ) period_id
      FROM candidates
      ORDER BY
        period_id,
        business_unit,
        LOWER(TRIM(name)),
        LOWER(TRIM(institution)),
        LOWER(TRIM(major)),
        LOWER(TRIM(interest)),
        id ASC
    )
    SELECT p.*, COUNT(uc.period_id)::int AS candidate_count
    FROM periods p
    LEFT JOIN unique_candidates uc ON uc.period_id=p.id
    GROUP BY p.id
    ORDER BY p.year DESC,p.id DESC`);
  res.render('periods', { title: 'Periode Seleksi', page: 'periods', periods, periodNameOptions: PERIOD_NAME_OPTIONS });
});
app.post('/periods', requireAuth, superAdminOnly, requireCsrf, async (req, res) => {
  const periodName = String(req.body.name || '').trim();
  if (!PERIOD_NAME_OPTIONS.includes(periodName)) {
    flash(req, 'Nama periode harus dipilih dari Gelombang 1 atau Gelombang 2.', 'error');
    return res.redirect('/periods');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("UPDATE periods SET status='closed', closed_at=COALESCE(closed_at,CURRENT_TIMESTAMP) WHERE status='active'");
    await client.query(
      "INSERT INTO periods (name,year,status) VALUES ($1,$2,'active')",
      [periodName, Number(req.body.year)],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  flash(req, 'Periode baru berhasil dibuka dan otomatis aktif. Periode lama diarsipkan sehingga data kandidat baru mulai kosong.');
  res.redirect('/periods');
});
app.post('/periods/:id/close', requireAuth, superAdminOnly, requireCsrf, async (req, res) => {
  const { rowCount } = await pool.query("UPDATE periods SET status='closed', closed_at=COALESCE(closed_at,CURRENT_TIMESTAMP) WHERE id=$1 AND status='active'", [Number(req.params.id)]);
  flash(req, rowCount ? 'Periode aktif berhasil ditutup.' : 'Periode sudah ditutup atau tidak ditemukan.', rowCount ? 'success' : 'error');
  res.redirect('/periods');
});
app.post('/periods/:id/delete', requireAuth, superAdminOnly, requireCsrf, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM periods WHERE id=$1', [Number(req.params.id)]);
  flash(req, rowCount ? 'Periode dan data terkait berhasil dihapus.' : 'Periode tidak ditemukan.', rowCount ? 'success' : 'error');
  res.redirect('/periods');
});

app.get('/candidates', requireAuth, requireRecruitmentAccess, async (req, res) => {
  const { rows: periods } = await pool.query('SELECT * FROM periods ORDER BY year DESC,id DESC');
  const activePeriod = periods.find((period) => period.status === 'active') || periods[0] || null;
  const rawPeriodId = String(req.query.period_id ?? '').trim();
  const requestedPeriodId = rawPeriodId === 'all' ? 0 : Number(rawPeriodId || activePeriod?.id || 0);
  const periodId = requestedPeriodId && periods.some((period) => period.id === requestedPeriodId)
    ? requestedPeriodId
    : rawPeriodId === 'all' ? 0 : activePeriod?.id || periods[0]?.id || 0;
  const filters = {
    query: String(req.query.q || '').trim(),
    institutionType: ['smk', 'university'].includes(req.query.institution_type) ? req.query.institution_type : '',
    businessUnit: req.session.user.role === 'recruiter'
      ? req.session.user.business_unit
      : BUSINESS_UNITS.includes(req.query.business_unit) ? req.query.business_unit : '',
    periodId,
    periodArchiveMode: rawPeriodId === 'all',
    status: ['not_passed', 'pending', 'accepted'].includes(req.query.status) ? req.query.status : '',
  };
  const conditions = [];
  const params = [];
  if (filters.query) {
    params.push(`%${filters.query}%`);
    conditions.push(`(c.name ILIKE $${params.length} OR c.institution ILIKE $${params.length} OR c.major ILIKE $${params.length} OR c.interest ILIKE $${params.length})`);
  }
  if (filters.institutionType) {
    params.push(filters.institutionType);
    conditions.push(`c.institution_type=$${params.length}`);
  }
  if (filters.businessUnit) {
    params.push(filters.businessUnit);
    conditions.push(`c.business_unit=$${params.length}`);
  }
  if (filters.periodId) {
    params.push(filters.periodId);
    conditions.push(`c.period_id=$${params.length}`);
  }
  if (filters.status === 'not_passed') {
    conditions.push(`(c.document_status='failed' OR c.selection_status='rejected')`);
  } else if (filters.status === 'pending') {
    conditions.push(`c.document_status<>'failed' AND c.selection_status='pending'`);
  } else if (filters.status === 'accepted') {
    conditions.push(`c.document_status<>'failed' AND c.selection_status='accepted'`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [{ rows: candidates }, { rows: [{ total: criteriaCount }] }] = await Promise.all([
    pool.query(`WITH candidate_rows AS (
        SELECT c.*,p.name AS period_name,p.year,
          (SELECT COUNT(*)::int FROM candidate_scores cs WHERE cs.candidate_id=c.id) AS score_count
        FROM candidates c
        JOIN periods p ON p.id=c.period_id ${where}
      ),
      unique_candidates AS (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY
              LOWER(TRIM(name)),
              LOWER(TRIM(institution)),
              LOWER(TRIM(major)),
              LOWER(TRIM(interest)),
              business_unit,
              period_id
            ORDER BY score_count DESC,id ASC
          ) AS duplicate_rank
        FROM candidate_rows
      )
      SELECT * FROM unique_candidates
      WHERE duplicate_rank=1
      ORDER BY
        CASE WHEN document_status='failed' OR selection_status='rejected' THEN 1 ELSE 0 END,
        LOWER(TRIM(name)) ASC,
        id ASC`, params),
    pool.query('SELECT COUNT(*)::int AS total FROM criteria'),
  ]);
  const importPeriodId = activePeriod?.id || periods[0]?.id || 0;
  const selectedPeriod = filters.periodId ? periods.find((period) => period.id === filters.periodId) || activePeriod : null;
  const pagination = makePagination(candidates.length, req.query.page, 20);
  const pagedCandidates = candidates.slice(pagination.offset, pagination.offset + pagination.perPage);
  const candidatePageQuery = {
    q: filters.query,
    institution_type: filters.institutionType,
    business_unit: filters.businessUnit,
    period_id: filters.periodArchiveMode ? 'all' : filters.periodId,
    status: filters.status,
  };
  res.render('candidates', {
    title: 'Data Kandidat',
    page: 'candidates',
    periods,
    candidates: pagedCandidates,
    criteriaCount,
    filters,
    importPeriodId,
    selectedPeriod,
    activePeriod,
    pagination,
    candidatePageQuery,
  });
});
app.post('/candidates/import', requireAuth, superAdminOnly, upload.single('spreadsheet'), requireCsrf, async (req, res) => {
  if (!req.file) {
    flash(req, 'Pilih file Excel hasil Google Form terlebih dahulu.', 'error');
    return res.redirect('/candidates');
  }

  let periodId = Number(req.body.period_id || 0);
  if (!periodId) {
    const { rows: [period] } = await pool.query("SELECT id FROM periods WHERE status='active' ORDER BY year DESC,id DESC LIMIT 1");
    periodId = period?.id || 0;
  }
  if (!periodId) {
    flash(req, 'Import gagal. Tambahkan periode pendaftaran terlebih dahulu.', 'error');
    await fs.rm(req.file.path, { force: true });
    return res.redirect('/candidates');
  }

  const defaultBusinessUnit = BUSINESS_UNITS[0];
  let insertedCount = 0;
  let duplicateCount = 0;
  let failedDocumentCount = 0;

  try {
    const result = parseCandidateSpreadsheet(req.file.path, { defaultBusinessUnit });
    if (result.missing.length) {
      flash(req, `Import gagal. Kolom wajib belum ditemukan: ${result.missing.join(', ')}.`, 'error');
      return res.redirect('/candidates');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const candidate of result.candidates) {
        if (candidate.documentStatus === 'failed') failedDocumentCount += 1;
        const candidateValues = [
          periodId,
          candidate.name,
          candidate.institution,
          candidate.institutionType,
          candidate.major,
          candidate.interest,
          candidate.businessUnit,
          candidate.coverLetterFile,
          candidate.cvFile,
          candidate.transcriptFile,
          candidate.portfolioFile,
          candidate.photoFile,
          candidate.documentStatus,
          candidate.documentNote,
          candidate.selectionStatus,
          candidate.interviewVideoUrl,
          candidate.presentationVideoUrl,
        ];
        const insertResult = await client.query(
          `INSERT INTO candidates (
             period_id,name,institution,institution_type,major,interest,business_unit,
             cover_letter_file,cv_file,transcript_file,portfolio_file,photo_file,
             document_status,document_note,selection_status,interview_video_url,presentation_video_url
           )
           SELECT $1::integer,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text,
             $8::text,$9::text,$10::text,$11::text,$12::text,$13::text,$14::text,$15::text,$16::text,$17::text
           WHERE NOT EXISTS (
             SELECT 1 FROM candidates
             WHERE period_id=$1
               AND LOWER(TRIM(name))=LOWER(TRIM($2::text))
               AND LOWER(TRIM(institution))=LOWER(TRIM($3::text))
               AND LOWER(TRIM(major))=LOWER(TRIM($5::text))
               AND LOWER(TRIM(interest))=LOWER(TRIM($6::text))
               AND business_unit=$7::text
           )
           RETURNING id`,
          candidateValues,
        );
        if (insertResult.rowCount) {
          insertedCount += 1;
        } else {
          duplicateCount += 1;
          await client.query(
            `UPDATE candidates
             SET cover_letter_file=$8::text,
               cv_file=$9::text,
               transcript_file=$10::text,
               portfolio_file=$11::text,
               photo_file=$12::text,
               document_status=$13::text,
               document_note=$14::text,
               interview_video_url=$16::text,
               presentation_video_url=$17::text,
               selection_status=CASE
                 WHEN $15::text='rejected' THEN 'rejected'
                 WHEN document_status='failed' AND selection_status='rejected' THEN 'pending'
                 ELSE selection_status
               END
             WHERE period_id=$1
               AND LOWER(TRIM(name))=LOWER(TRIM($2::text))
               AND LOWER(TRIM(institution))=LOWER(TRIM($3::text))
               AND LOWER(TRIM(major))=LOWER(TRIM($5::text))
               AND LOWER(TRIM(interest))=LOWER(TRIM($6::text))
               AND business_unit=$7::text`,
            candidateValues,
          );
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    flash(req, `Import selesai. ${insertedCount} kandidat baru berhasil dimasukkan${duplicateCount ? `, ${duplicateCount} data duplikat diperbarui` : ''}${failedDocumentCount ? `, ${failedDocumentCount} kandidat otomatis gugur berkas` : ''}${result.skipped ? `, ${result.skipped} baris dilewati karena data belum lengkap` : ''}.`);
    res.redirect('/candidates');
  } finally {
    await fs.rm(req.file.path, { force: true });
  }
});
app.post('/candidates/:id/delete', requireAuth, superAdminOnly, requireCsrf, async (req, res) => {
  const candidateId = Number(req.params.id);
  const { rows: [candidate] } = await pool.query('SELECT * FROM candidates WHERE id=$1', [candidateId]);
  if (!candidate) {
    flash(req, 'Kandidat tidak ditemukan atau sudah dihapus.', 'error');
    return res.redirect('/candidates');
  }

  const deleteResult = await pool.query(
    `DELETE FROM candidates
     WHERE period_id=$1
       AND business_unit=$2
       AND LOWER(TRIM(name))=LOWER(TRIM($3::text))
       AND LOWER(TRIM(institution))=LOWER(TRIM($4::text))
       AND LOWER(TRIM(major))=LOWER(TRIM($5::text))
       AND LOWER(TRIM(interest))=LOWER(TRIM($6::text))`,
    [candidate.period_id, candidate.business_unit, candidate.name, candidate.institution, candidate.major, candidate.interest],
  );

  flash(req, deleteResult.rowCount > 1
    ? `Kandidat berhasil dihapus bersama ${deleteResult.rowCount - 1} data duplikat.`
    : 'Kandidat berhasil dihapus.');
  res.redirect('/candidates');
});
app.get('/candidates/:id/scores', requireAuth, requireRecruitmentAccess, async (req, res) => {
  const candidateId = Number(req.params.id);
  const [{ rows: [candidate] }, { rows: criteria }, { rows: scoreRows }] = await Promise.all([
    pool.query(`SELECT c.*,p.name AS period_name,p.year FROM candidates c
      JOIN periods p ON p.id=c.period_id WHERE c.id=$1`, [candidateId]),
    pool.query("SELECT * FROM criteria ORDER BY CAST(SUBSTRING(code FROM 2) AS INTEGER)"),
    pool.query('SELECT * FROM candidate_scores WHERE candidate_id=$1', [candidateId]),
  ]);
  if (!candidate) return res.status(404).send('Kandidat tidak ditemukan.');
  if (req.session.user.role === 'recruiter' && candidate.business_unit !== req.session.user.business_unit) {
    flash(req, 'Kandidat ini berada di luar unit bisnis akun Anda.', 'error');
    return res.redirect('/candidates');
  }
  if (candidate.document_status === 'failed') {
    flash(req, `Kandidat ${candidate.name} otomatis gugur berkas dan tidak dapat dinilai.`, 'error');
    return res.redirect('/candidates');
  }

  const scores = {};
  for (const row of scoreRows) scores[row.criterion_id] = Number(row.score);
  res.render('candidate-score', {
    title: 'Penilaian Kandidat',
    page: 'candidates',
    candidate,
    criteria,
    scores,
    criteriaDetails,
  });
});
app.post('/candidates/:id/scores', requireAuth, requireRecruitmentAccess, requireCsrf, async (req, res) => {
  const candidateId = Number(req.params.id);
  const { rows: criteria } = await pool.query("SELECT * FROM criteria ORDER BY CAST(SUBSTRING(code FROM 2) AS INTEGER)");
  const { rows: [candidate] } = await pool.query('SELECT name,document_status,business_unit FROM candidates WHERE id=$1', [candidateId]);
  if (!candidate) return res.status(404).send('Kandidat tidak ditemukan.');
  if (req.session.user.role === 'recruiter' && candidate.business_unit !== req.session.user.business_unit) {
    flash(req, 'Kandidat ini berada di luar unit bisnis akun Anda.', 'error');
    return res.redirect('/candidates');
  }
  if (candidate.document_status === 'failed') {
    flash(req, `Kandidat ${candidate.name} otomatis gugur berkas dan tidak dapat dinilai.`, 'error');
    return res.redirect('/candidates');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const criterion of criteria) {
      const rawScore = Number(req.body.scores?.[criterion.id] ?? 3);
      const score = Math.max(1, Math.min(5, rawScore));
      await client.query(`INSERT INTO candidate_scores (candidate_id,criterion_id,score,scored_by_user_id,scored_at)
        VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)
        ON CONFLICT(candidate_id,criterion_id)
        DO UPDATE SET score=EXCLUDED.score,
          scored_by_user_id=EXCLUDED.scored_by_user_id,
          scored_at=CURRENT_TIMESTAMP`,
      [candidateId, criterion.id, score, req.session.user.id]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  flash(req, `Penilaian ${candidate.name} berhasil disimpan.`);
  res.redirect('/candidates');
});
app.post('/candidates/:id/status', requireAuth, requireRecruitmentAccess, requireCsrf, async (req, res) => {
  const allowed = ['pending', 'accepted', 'rejected'];
  const status = allowed.includes(req.body.status) ? req.body.status : 'pending';
  const { rows: [candidate] } = await pool.query('SELECT document_status,business_unit FROM candidates WHERE id=$1', [Number(req.params.id)]);
  if (req.session.user.role === 'recruiter' && candidate?.business_unit !== req.session.user.business_unit) {
    flash(req, 'Kandidat ini berada di luar unit bisnis akun Anda.', 'error');
    return res.redirect('/ranking');
  }
  if (candidate?.document_status === 'failed' && status !== 'rejected') {
    flash(req, 'Kandidat gugur berkas tidak dapat diterima.', 'error');
    return res.redirect(`/ranking?period_id=${Number(req.body.period_id)}&business_unit=${encodeURIComponent(scopedBusinessUnit(req, req.body.business_unit))}`);
  }
  await pool.query('UPDATE candidates SET selection_status=$1 WHERE id=$2', [status, Number(req.params.id)]);
  flash(req, 'Status keputusan kandidat berhasil diperbarui.');
  const unit = encodeURIComponent(scopedBusinessUnit(req, req.body.business_unit));
  res.redirect(`/ranking?period_id=${Number(req.body.period_id)}&business_unit=${unit}`);
});

app.get('/criteria', requireAuth, async (req, res) => {
  const [{ rows: criteria }, { rows: subcriteria }] = await Promise.all([
    pool.query("SELECT * FROM criteria ORDER BY CAST(SUBSTRING(code FROM 2) AS INTEGER)"),
    pool.query('SELECT * FROM subcriteria ORDER BY criterion_id,score DESC'),
  ]);
  const grouped = {};
  for (const row of subcriteria) (grouped[row.criterion_id] ??= []).push(row);
  res.render('criteria', { title: 'Kriteria dan Subkriteria', page: 'criteria', criteria, grouped, criteriaDetails });
});

app.get('/swara', requireAuth, superAdminOnly, async (req, res) => {
  const [{ rows: criteria }, { rows: [state] }] = await Promise.all([
    pool.query("SELECT * FROM criteria ORDER BY CAST(SUBSTRING(code FROM 2) AS INTEGER)"),
    pool.query('SELECT * FROM swara_process_state WHERE id=1'),
  ]);
  const totalWeight = criteria.reduce((sum, criterion) => sum + Number(criterion.weight), 0);
  res.render('swara', {
    title: 'Bobot Kriteria',
    page: 'swara',
    criteria,
    state,
    totalWeight,
    recommendedWeights: RECOMMENDED_SWARA_WEIGHTS,
  });
});

app.post('/swara/weights', requireAuth, superAdminOnly, requireCsrf, async (req, res) => {
  const { rows: criteria } = await pool.query(
    "SELECT * FROM criteria ORDER BY CAST(SUBSTRING(code FROM 2) AS INTEGER)",
  );
  const bulkWeights = parseBulkWeights(req.body.bulkWeights);
  const values = req.body.useRecommendedWeights === '1'
    ? criteria.map((criterion) => RECOMMENDED_SWARA_WEIGHTS[criterion.code])
    : criteria.map((criterion) => firstValidWeight(
      req.body.weights?.[criterion.id],
      req.body.weights?.[String(criterion.id)],
      req.body[`weights[${criterion.id}]`],
      bulkWeights[criterion.code],
      bulkWeights[criterion.code?.replace(/^C/, 'K')],
    ));
  const validation = validateWeights(values, criteria.length);
  if (!validation.valid) {
    const invalidCriteria = validation.invalidIndexes
      .map((index) => criteria[index]?.code)
      .filter(Boolean);
    const totalText = Number.isFinite(validation.total) ? validation.total.toFixed(6) : 'tidak dapat dihitung';
    const invalidText = invalidCriteria.length ? ` Periksa bobot: ${invalidCriteria.join(', ')}.` : '';
    flash(req, `Bobot harus berisi angka 0-1 dan totalnya mendekati 1. Total saat ini: ${totalText}.${invalidText}`, 'error');
    return res.redirect('/swara');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [index, criterion] of criteria.entries()) {
      await client.query('UPDATE criteria SET weight=$1 WHERE id=$2', [validation.weights[index], criterion.id]);
    }
    await client.query(`UPDATE swara_process_state SET weights_ready=TRUE,
      updated_at=CURRENT_TIMESTAMP WHERE id=1`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  flash(req, 'Bobot final SWARA berhasil disimpan dan siap digunakan pada MABAC.');
  res.redirect('/swara');
});

app.get('/scores', requireAuth, requireRecruitmentAccess, async (req, res) => {
  const { rows: periods } = await pool.query('SELECT * FROM periods ORDER BY year DESC,id DESC');
  const periodId = Number(req.query.period_id || periods[0]?.id || 0);
  const businessUnit = scopedBusinessUnit(req, req.query.business_unit);
  const [{ rows: candidates }, { rows: criteria }, { rows: scoreRows }] = await Promise.all([
    pool.query("SELECT * FROM candidates WHERE period_id=$1 AND business_unit=$2 AND document_status<>'failed' ORDER BY name", [periodId, businessUnit]),
    pool.query("SELECT * FROM criteria ORDER BY CAST(SUBSTRING(code FROM 2) AS INTEGER)"),
    pool.query(`SELECT cs.* FROM candidate_scores cs JOIN candidates c ON c.id=cs.candidate_id
      WHERE c.period_id=$1 AND c.business_unit=$2 AND c.document_status<>'failed'`, [periodId, businessUnit]),
  ]);
  const scores = {};
  for (const row of scoreRows) (scores[row.candidate_id] ??= {})[row.criterion_id] = row.score;
  res.render('scores', { title: 'Penilaian Kandidat', page: 'scores', periods, periodId, businessUnit, candidates, criteria, scores });
});
app.post('/scores', requireAuth, requireRecruitmentAccess, requireCsrf, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [candidateId, values] of Object.entries(req.body.scores || {})) {
      for (const [criterionId, value] of Object.entries(values)) {
        const score = Math.max(1, Math.min(5, Number(value)));
        const { rows: [candidate] } = await client.query('SELECT business_unit,document_status FROM candidates WHERE id=$1', [Number(candidateId)]);
        if (!candidate || candidate.document_status === 'failed') continue;
        if (req.session.user.role === 'recruiter' && candidate.business_unit !== req.session.user.business_unit) continue;
        await client.query(`INSERT INTO candidate_scores (candidate_id,criterion_id,score,scored_by_user_id,scored_at)
          VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)
          ON CONFLICT(candidate_id,criterion_id)
          DO UPDATE SET score=EXCLUDED.score,
            scored_by_user_id=EXCLUDED.scored_by_user_id,
            scored_at=CURRENT_TIMESTAMP`,
        [Number(candidateId), Number(criterionId), score, req.session.user.id]);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  flash(req, 'Penilaian kandidat berhasil disimpan.');
  const unit = encodeURIComponent(scopedBusinessUnit(req, req.body.business_unit));
  res.redirect(`/scores?period_id=${Number(req.body.period_id)}&business_unit=${unit}`);
});

app.post('/ranking/quota', requireAuth, requireRecruitmentAccess, requireCsrf, async (req, res) => {
  const periodId = Number(req.body.period_id);
  const businessUnit = scopedBusinessUnit(req, req.body.business_unit);
  const quota = Math.max(0, Number(req.body.quota || 0));

  await pool.query(
    `INSERT INTO recruitment_quotas (period_id,business_unit,quota,updated_at)
     VALUES ($1,$2,$3,CURRENT_TIMESTAMP)
     ON CONFLICT (period_id,business_unit)
     DO UPDATE SET quota=EXCLUDED.quota, updated_at=CURRENT_TIMESTAMP`,
    [periodId, businessUnit, quota],
  );

  flash(req, 'Kuota penerimaan berhasil disimpan.');
  res.redirect(`/ranking?period_id=${periodId}&business_unit=${encodeURIComponent(businessUnit)}`);
});

app.get('/ranking', requireAuth, async (req, res) => {
  const { rows: periods } = await pool.query('SELECT * FROM periods ORDER BY year DESC,id DESC');
  const periodId = Number(req.query.period_id || periods[0]?.id || 0);
  const businessUnit = scopedBusinessUnit(req, req.query.business_unit);
  const [{ rows: candidates }, { rows: criteria }, { rows: scoreRows }, { rows: [swaraState] }, { rows: [quotaRow] }] = await Promise.all([
    pool.query("SELECT * FROM candidates WHERE period_id=$1 AND business_unit=$2 AND document_status<>'failed' ORDER BY name", [periodId, businessUnit]),
    pool.query("SELECT * FROM criteria ORDER BY CAST(SUBSTRING(code FROM 2) AS INTEGER)"),
    pool.query(`SELECT cs.*,u.name AS scorer_name,u.username AS scorer_username
      FROM candidate_scores cs JOIN candidates c ON c.id=cs.candidate_id
      LEFT JOIN users u ON u.id=cs.scored_by_user_id
      WHERE c.period_id=$1 AND c.business_unit=$2 AND c.document_status<>'failed'
      ORDER BY cs.candidate_id, cs.scored_at NULLS FIRST`, [periodId, businessUnit]),
    pool.query('SELECT * FROM swara_process_state WHERE id=1'),
    pool.query('SELECT * FROM recruitment_quotas WHERE period_id=$1 AND business_unit=$2', [periodId, businessUnit]),
  ]);
  const scores = {};
  const scorers = {};
  for (const row of scoreRows) {
    (scores[row.candidate_id] ??= {})[row.criterion_id] = row.score;
    if (row.scorer_name) {
      scorers[row.candidate_id] = {
        name: row.scorer_name,
        username: row.scorer_username,
        scoredAt: row.scored_at,
      };
    }
  }
  const swaraReady = Boolean(swaraState?.weights_ready);
  const result = swaraReady ? calculateMabac(candidates, criteria, scores) : { rows: [], details: {} };
  const quota = Number(quotaRow?.quota || 0);
  const pagination = makePagination(result.rows.length, req.query.page, 20);
  const pagedResult = {
    ...result,
    rows: result.rows.slice(pagination.offset, pagination.offset + pagination.perPage),
  };
  const rankingPageQuery = { period_id: periodId, business_unit: businessUnit };
  res.render('ranking', {
    title: 'Rangking Penilaian',
    page: 'ranking',
    periods,
    periodId,
    businessUnit,
    criteria,
    result: pagedResult,
    swaraReady,
    quota,
    scorers,
    pagination,
    rankingPageQuery,
  });
});

app.use((req, res) => res.status(404).send('Halaman tidak ditemukan.'));
app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).send('Terjadi kesalahan pada server. Periksa koneksi database dan log aplikasi.');
});

if (!process.env.VERCEL) {
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, () => console.log(`SPK Sarastya berjalan di http://localhost:${port}`));

  async function shutdown() {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export default app;
