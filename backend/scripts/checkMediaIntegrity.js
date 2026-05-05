require('dotenv').config();

const fs = require('fs');
const path = require('path');
const pool = require('../src/database');
const mediaCleanupService = require('../src/services/mediaCleanupService');

function parseArgs(argv) {
  const args = {
    includeDeleted: false,
    jsonPath: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--include-deleted') {
      args.includeDeleted = true;
    } else if (arg === '--json' && next) {
      args.jsonPath = next;
      index += 1;
    }
  }

  return args;
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

function printReport(report) {
  const orphanBytes = report.orphanObjects.reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0);
  console.log('\nMedia integrity check');
  console.log('=====================');
  console.log(`Storage provider: ${report.storageProvider}`);
  console.log(`Storage root: ${report.storageRoot || 'n/a'}`);
  console.log(`Media files: ${report.totals.mediaFiles}`);
  console.log(`Variants: ${report.totals.variants}`);
  console.log(`Storage objects: ${report.totals.objects}`);
  console.log(`Missing DB objects: ${report.totals.missingObjects}`);
  console.log(`Orphan storage objects: ${report.totals.orphanObjects} (${formatBytes(orphanBytes)})`);
  console.log(`Missing required variants: ${report.totals.missingVariants}`);

  if (report.missingObjects.length > 0) {
    console.log('\nMissing object sample');
    console.table(report.missingObjects.slice(0, 25));
  }

  if (report.orphanObjects.length > 0) {
    console.log('\nOrphan object sample');
    console.table(report.orphanObjects.slice(0, 25).map((item) => ({
      objectKey: item.objectKey,
      size: formatBytes(item.sizeBytes),
    })));
  }

  if (report.missingVariants.length > 0) {
    console.log('\nMissing variant sample');
    console.table(report.missingVariants.slice(0, 25));
  }
}

async function writeJsonReport(jsonPath, report) {
  const outputPath = path.resolve(process.cwd(), jsonPath);
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nJSON report written to ${outputPath}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await mediaCleanupService.checkMediaIntegrity({
    includeDeleted: args.includeDeleted,
  });
  printReport(report);

  if (args.jsonPath) {
    await writeJsonReport(args.jsonPath, report);
  }
}

main()
  .catch((error) => {
    console.error(`Media integrity check failed: ${error.message || error}`);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
