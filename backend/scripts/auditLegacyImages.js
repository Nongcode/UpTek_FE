require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const backendRoot = path.resolve(__dirname, '..');
const storageRoot = path.resolve(backendRoot, 'storage/images');
const legacyPublicPrefix = '/storage/images/';

function toPosixPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function parseArgs(argv) {
  const args = {
    jsonPath: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) {
        args.jsonPath = next;
        index += 1;
      } else {
        args.jsonPath = path.resolve(backendRoot, `legacy-images-audit-${Date.now()}.json`);
      }
    }
  }

  return args;
}

function resolveStorageRelativePath(url) {
  const raw = String(url || '').trim();
  if (!raw) {
    return { relativePath: null, error: 'empty url' };
  }

  let pathname = raw;
  try {
    if (/^https?:\/\//i.test(raw)) {
      pathname = new URL(raw).pathname;
    }
  } catch {
    return { relativePath: null, error: 'invalid url' };
  }

  if (pathname.startsWith(legacyPublicPrefix)) {
    pathname = pathname.slice(legacyPublicPrefix.length);
  } else if (pathname.startsWith('/')) {
    return { relativePath: null, error: `url does not start with ${legacyPublicPrefix}` };
  }

  const relativePath = toPosixPath(decodeURIComponent(pathname));
  const absolutePath = path.resolve(storageRoot, relativePath);
  const rootWithSeparator = `${storageRoot}${path.sep}`;
  if (absolutePath !== storageRoot && !absolutePath.startsWith(rootWithSeparator)) {
    return { relativePath: null, error: 'path traversal outside storage root' };
  }

  return { relativePath, error: null };
}

function getScopeKey(companyId, departmentId) {
  return `${companyId || 'unknown'} / ${departmentId || 'unknown'}`;
}

function createScopeStats(companyId, departmentId) {
  return {
    companyId: companyId || 'unknown',
    departmentId: departmentId || 'unknown',
    records: 0,
    validRecords: 0,
    missingFiles: 0,
    orphanFiles: 0,
    referencedBytes: 0,
    scannedBytes: 0,
  };
}

function ensureScope(distribution, companyId, departmentId) {
  const key = getScopeKey(companyId, departmentId);
  if (!distribution.has(key)) {
    distribution.set(key, createScopeStats(companyId, departmentId));
  }
  return distribution.get(key);
}

async function scanFiles(dir, root = dir, files = new Map()) {
  if (!fs.existsSync(dir)) {
    return files;
  }

  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanFiles(absolutePath, root, files);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const stat = await fs.promises.stat(absolutePath);
    const relativePath = toPosixPath(path.relative(root, absolutePath));
    files.set(relativePath, {
      absolutePath,
      relativePath,
      sizeBytes: stat.size,
    });
  }

  return files;
}

async function loadImageRecords(pool) {
  const result = await pool.query(`
    SELECT "id", "url", "companyId", "departmentId", "source", "uploaderId", "createdAt", "productModel", "prefix", "mediaFileId"
    FROM "Images"
    ORDER BY "createdAt" DESC NULLS LAST
  `);
  return result.rows;
}

function buildReport(records, files) {
  const referencedPaths = new Set();
  const duplicatePathCounts = new Map();
  const distribution = new Map();
  const missingRecords = [];
  const invalidUrlRecords = [];
  let validRecords = 0;
  let referencedBytes = 0;

  for (const record of records) {
    const parsed = resolveStorageRelativePath(record.url);
    const scope = ensureScope(distribution, record.companyId, record.departmentId);
    scope.records += 1;

    if (parsed.error) {
      invalidUrlRecords.push({
        id: record.id,
        url: record.url,
        error: parsed.error,
      });
      scope.missingFiles += 1;
      continue;
    }

    const currentCount = duplicatePathCounts.get(parsed.relativePath) || 0;
    duplicatePathCounts.set(parsed.relativePath, currentCount + 1);
    referencedPaths.add(parsed.relativePath);

    const file = files.get(parsed.relativePath);
    if (!file) {
      missingRecords.push({
        id: record.id,
        url: record.url,
        companyId: record.companyId,
        departmentId: record.departmentId,
        relativePath: parsed.relativePath,
      });
      scope.missingFiles += 1;
      continue;
    }

    validRecords += 1;
    referencedBytes += file.sizeBytes;
    scope.validRecords += 1;
    scope.referencedBytes += file.sizeBytes;
  }

  const orphanFiles = [];
  let scannedBytes = 0;
  for (const file of files.values()) {
    scannedBytes += file.sizeBytes;
    const [companyId = 'unknown', departmentId = 'unknown'] = file.relativePath.split('/');
    const scope = ensureScope(distribution, companyId, departmentId);
    scope.scannedBytes += file.sizeBytes;

    if (!referencedPaths.has(file.relativePath)) {
      orphanFiles.push(file);
      scope.orphanFiles += 1;
    }
  }

  const duplicateReferences = Array.from(duplicatePathCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([relativePath, count]) => ({ relativePath, count }));

  return {
    generatedAt: new Date().toISOString(),
    dryRun: true,
    storageRoot,
    totals: {
      dbRecords: records.length,
      scannedFiles: files.size,
      validRecords,
      missingFiles: missingRecords.length + invalidUrlRecords.length,
      orphanFiles: orphanFiles.length,
      duplicateReferences: duplicateReferences.length,
      referencedBytes,
      scannedBytes,
    },
    distribution: Array.from(distribution.values()).sort((a, b) => (
      `${a.companyId}/${a.departmentId}`.localeCompare(`${b.companyId}/${b.departmentId}`)
    )),
    missingRecords,
    invalidUrlRecords,
    orphanFiles: orphanFiles.map((file) => ({
      relativePath: file.relativePath,
      sizeBytes: file.sizeBytes,
    })),
    duplicateReferences,
  };
}

function printReport(report) {
  console.log('\nLegacy image audit dry-run');
  console.log('==========================');
  console.log(`Storage root: ${report.storageRoot}`);
  console.log(`DB records: ${report.totals.dbRecords}`);
  console.log(`Scanned files: ${report.totals.scannedFiles}`);
  console.log(`Valid records: ${report.totals.validRecords}`);
  console.log(`Missing files / invalid URLs: ${report.totals.missingFiles}`);
  console.log(`Orphan files: ${report.totals.orphanFiles}`);
  console.log(`Duplicate referenced paths: ${report.totals.duplicateReferences}`);
  console.log(`Referenced size: ${formatBytes(report.totals.referencedBytes)}`);
  console.log(`Scanned storage size: ${formatBytes(report.totals.scannedBytes)}`);

  console.log('\nBy company / department');
  console.table(report.distribution.map((item) => ({
    companyId: item.companyId,
    departmentId: item.departmentId,
    records: item.records,
    valid: item.validRecords,
    missing: item.missingFiles,
    orphanFiles: item.orphanFiles,
    referencedSize: formatBytes(item.referencedBytes),
    scannedSize: formatBytes(item.scannedBytes),
  })));

  if (report.missingRecords.length > 0) {
    console.log('\nMissing DB records sample');
    console.table(report.missingRecords.slice(0, 20));
  }

  if (report.invalidUrlRecords.length > 0) {
    console.log('\nInvalid URL records sample');
    console.table(report.invalidUrlRecords.slice(0, 20));
  }

  if (report.orphanFiles.length > 0) {
    console.log('\nOrphan files sample');
    console.table(report.orphanFiles.slice(0, 20));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const [records, files] = await Promise.all([
      loadImageRecords(pool),
      scanFiles(storageRoot),
    ]);
    const report = buildReport(records, files);
    printReport(report);

    if (args.jsonPath) {
      const outputPath = path.resolve(process.cwd(), args.jsonPath);
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.promises.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.log(`\nJSON report written to ${outputPath}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Legacy image audit failed: ${error.message || error}`);
  process.exit(1);
});
