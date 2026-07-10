import xlsx from 'xlsx';

export const BUSINESS_UNITS = [
  'Sarastya Insan Bertumbuh',
  'Sarastya Technology Innovations',
  'Sarastya Business Process',
  'Appslings',
];

const BUSINESS_UNIT_ALIASES = new Map([
  ['sib', 'Sarastya Insan Bertumbuh'],
  ['sti', 'Sarastya Technology Innovations'],
  ['sarastya technology', 'Sarastya Technology Innovations'],
  ['sbp', 'Sarastya Business Process'],
  ['sarastya business process khusus mahasiswa aktif d3s1', 'Sarastya Business Process'],
  ['appslings', 'Appslings'],
]);

const HEADER_ALIASES = {
  name: ['nama lengkap', 'nama', 'full name'],
  institution: ['nama sekolah/kampus', 'asal instansi', 'instansi', 'nama instansi', 'sekolah', 'perguruan tinggi', 'universitas'],
  major: ['jurusan/bidang studi', 'jurusan pendidikan', 'jurusan', 'program studi', 'prodi'],
  interest: [
    'minat bidang prakerin',
    'pilih bidang magang sesuai dengan minat kamu',
    'pilih bidang yang kamu minati',
    'peminatan bidang',
    'bidang peminatan',
    'peminatan',
    'minat bidang',
    'posisi',
  ],
  institutionType: ['jenis instansi', 'kategori instansi', 'tingkat pendidikan'],
  businessUnit: ['pilih unit bisnis sesuai minat', 'unit bisnis', 'business unit', 'unit tujuan', 'unit yang dipilih'],
  coverLetterFile: ['surat pengajuan pkl/prakerin', 'surat pengajuan pkl/magang', 'surat pengajuan pkl', 'surat pengajuan magang'],
  cvFile: ['curriculum vitae (cv) formal', 'curriculum vitae', 'cv formal', 'cv'],
  transcriptFile: ['raport/transkrip nilai semester terakhir', 'rapor/transkrip nilai semester terakhir', 'raport', 'rapor', 'transkrip nilai'],
  portfolioFile: ['portofolio', 'portfolio'],
  photoFile: ['foto 4x6 terbaru', 'foto 4x6', 'foto'],
  interviewVideoUrl: ['4 link pengumpulan', 'link pengumpulan video interview', 'link video interview', 'video interview', 'sesi interview'],
  presentationVideoUrl: ['link presentasi', 'video presentasi', 'presentasi tugas', 'presentasi', 'presentation', 'link pengumpulan video presentasi', 'link video presentasi'],
};

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim();
}

function findColumnIndices(headers, aliases) {
  const normalizedHeaders = headers.map((header, index) => ({
    index,
    normalized: normalizeText(header),
  }));

  const results = [];
  for (const alias of aliases) {
    const normalizedAlias = normalizeText(alias);
    for (const header of normalizedHeaders) {
      if (header.normalized === normalizedAlias && !results.includes(header.index)) {
        results.push(header.index);
      }
    }
  }

  for (const alias of aliases) {
    const normalizedAlias = normalizeText(alias);
    for (const header of normalizedHeaders) {
      if (header.normalized.includes(normalizedAlias) && !results.includes(header.index)) {
        results.push(header.index);
      }
    }
  }

  return results;
}

function readCell(row, index) {
  return String(row[index] ?? '').trim();
}

function readFirstFilledCell(row, indices) {
  for (const index of indices) {
    const value = readCell(row, index);
    if (value) return value;
  }
  return '';
}

function readFirstUrlCell(row, indices) {
  for (const index of indices) {
    const value = readCell(row, index);
    if (/https?:\/\//i.test(value)) return value;
  }
  return '';
}

export function detectInstitutionType(value, fallback = 'university') {
  const normalized = normalizeText(value);
  if (normalized.includes('smk') || normalized.includes('smkn') || normalized.includes('sekolah menengah kejuruan')) {
    return 'smk';
  }
  if (normalized.includes('sma') || normalized.includes('ma ') || normalized.includes('sekolah')) return 'smk';
  return fallback;
}

export function normalizeBusinessUnit(value, fallback = BUSINESS_UNITS[0]) {
  const normalized = normalizeText(value);
  if (BUSINESS_UNIT_ALIASES.has(normalized)) return BUSINESS_UNIT_ALIASES.get(normalized);
  return BUSINESS_UNITS.find((unit) => normalizeText(unit) === normalized)
    || BUSINESS_UNITS.find((unit) => normalized.includes(normalizeText(unit)))
    || fallback;
}

function evaluateDocumentStatus(candidate) {
  const missingRequired = [];
  if (!candidate.cvFile) missingRequired.push('CV');
  if (!candidate.transcriptFile) missingRequired.push('Transkrip Nilai/Rapor');

  return {
    documentStatus: missingRequired.length ? 'failed' : 'complete',
    documentNote: missingRequired.length
      ? `Gugur berkas: ${missingRequired.join(' dan ')} belum ada.`
      : 'Berkas wajib lengkap.',
    selectionStatus: missingRequired.length ? 'rejected' : 'pending',
  };
}

export function parseCandidateSpreadsheet(filePath, options = {}) {
  const workbook = xlsx.readFile(filePath, { cellDates: false });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const sheetRows = xlsx.utils.sheet_to_json(firstSheet, { header: 1, defval: '', blankrows: false });
  const headerIndex = sheetRows.findIndex((row) => row.some((value) => normalizeText(value)));
  const headers = headerIndex >= 0 ? sheetRows[headerIndex] : [];
  const dataRows = headerIndex >= 0 ? sheetRows.slice(headerIndex + 1) : [];
  const mapping = Object.fromEntries(
    Object.entries(HEADER_ALIASES).map(([field, aliases]) => [field, findColumnIndices(headers, aliases)]),
  );

  const required = ['name', 'institution', 'major'];
  const missing = required.filter((field) => !mapping[field].length);
  if (!mapping.interest.length) missing.push('interest');
  if (missing.length) {
    return {
      candidates: [],
      skipped: dataRows.length,
      missing,
      headers,
    };
  }

  const defaultBusinessUnit = normalizeBusinessUnit(options.defaultBusinessUnit);
  const candidates = [];
  let skipped = 0;

  for (const row of dataRows) {
    if (!row.some((value) => String(value ?? '').trim())) continue;

    const businessUnitChoice = readFirstFilledCell(row, mapping.businessUnit);
    const candidate = {
      name: readFirstFilledCell(row, mapping.name),
      institution: readFirstFilledCell(row, mapping.institution),
      institutionType: detectInstitutionType(
        readFirstFilledCell(row, mapping.institutionType) || readFirstFilledCell(row, mapping.institution),
        options.defaultInstitutionType || 'university',
      ),
      major: readFirstFilledCell(row, mapping.major),
      interest: readFirstFilledCell(row, mapping.interest) || businessUnitChoice || defaultBusinessUnit,
      businessUnit: normalizeBusinessUnit(businessUnitChoice, defaultBusinessUnit),
      coverLetterFile: readFirstFilledCell(row, mapping.coverLetterFile),
      cvFile: readFirstFilledCell(row, mapping.cvFile),
      transcriptFile: readFirstFilledCell(row, mapping.transcriptFile),
      portfolioFile: readFirstFilledCell(row, mapping.portfolioFile),
      photoFile: readFirstFilledCell(row, mapping.photoFile),
      interviewVideoUrl: readFirstUrlCell(row, mapping.interviewVideoUrl),
      presentationVideoUrl: readFirstUrlCell(row, mapping.presentationVideoUrl),
    };
    Object.assign(candidate, evaluateDocumentStatus(candidate));

    if (!candidate.name || !candidate.institution || !candidate.major || !candidate.interest) {
      skipped += 1;
      continue;
    }

    candidates.push(candidate);
  }

  return { candidates, skipped, missing: [], headers };
}
