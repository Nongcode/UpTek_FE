require('dotenv').config();

const fs = require('fs');
const path = require('path');
const pool = require('../src/database');
const mediaCleanupService = require('../src/services/mediaCleanupService');
const { createStorageProvider } = require('../src/storage');

function parseArgs(argv) {
  const args = {
    dryRun: true,
    jsonPath: null,
    softDeleteMissing: false,
    planPhysicalDelete: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--execute') {
      args.dryRun = false;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--soft-delete-missing') {
      args.softDeleteMissing = true;
    } else if (arg === '--plan-physical-delete') {
      args.planPhysicalDelete = true;
    } else if (arg === '--json' && next) {
      args.jsonPath = next;
      index += 1;
    }
  }

  return args;
}

async function writeJsonReport(jsonPath, report) {
  const outputPath = path.resolve(process.cwd(), jsonPath);
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nJSON report written to ${outputPath}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const integrity = await mediaCleanupService.checkMediaIntegrity();
  const mediaIdsWithMissingOriginals = [
    ...new Set(
      integrity.missingObjects
        .filter((item) => item.type === 'original')
        .map((item) => item.mediaFileId)
    ),
  ];

  const softDelete = args.softDeleteMissing
    ? await mediaCleanupService.softDeleteMediaFiles(mediaIdsWithMissingOriginals, { dryRun: args.dryRun })
    : { dryRun: args.dryRun, results: [] };

  const physicalDeletePlan = args.planPhysicalDelete
    ? mediaCleanupService.planPhysicalDelete(integrity.orphanObjects)
    : [];

  const report = {
    generatedAt: new Date().toISOString(),
    dryRun: args.dryRun,
    storageProvider: createStorageProvider().constructor.name,
    integrityTotals: integrity.totals,
    softDelete,
    physicalDeletePlan,
  };

  console.log('\nMedia cleanup dry-run');
  console.log('=====================');
  console.log(`Mode: ${args.dryRun ? 'dry-run' : 'execute'}`);
  console.log(`Missing originals eligible for soft delete: ${mediaIdsWithMissingOriginals.length}`);
  console.log(`Soft delete actions: ${softDelete.results.length}`);
  console.log(`Physical delete plan only: ${physicalDeletePlan.length}`);
  if (!args.dryRun && physicalDeletePlan.length > 0) {
    console.log('Physical object deletion is intentionally not implemented yet.');
  }

  if (softDelete.results.length > 0) {
    console.table(softDelete.results.slice(0, 25));
  }

  if (args.jsonPath) {
    await writeJsonReport(args.jsonPath, report);
  }
}

main()
  .catch((error) => {
    console.error(`Media cleanup failed: ${error.message || error}`);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
