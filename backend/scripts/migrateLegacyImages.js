require('dotenv').config();

const fs = require('fs');
const path = require('path');
const pool = require('../src/database');
const migrationService = require('../src/services/mediaMigrationService');

function parseArgs(argv) {
  const args = {
    batchSize: 50,
    dryRun: true,
    includeMigrated: false,
    jsonPath: null,
    maxBatches: 1,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--execute') {
      args.dryRun = false;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--include-migrated') {
      args.includeMigrated = true;
    } else if (arg === '--batch-size' && next) {
      args.batchSize = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--max-batches' && next) {
      args.maxBatches = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--json' && next) {
      args.jsonPath = next;
      index += 1;
    }
  }

  if (!Number.isFinite(args.batchSize) || args.batchSize <= 0) {
    args.batchSize = 50;
  }
  if (!Number.isFinite(args.maxBatches) || args.maxBatches <= 0) {
    args.maxBatches = 1;
  }

  args.batchSize = Math.min(args.batchSize, 500);
  args.maxBatches = Math.min(args.maxBatches, 1000);
  return args;
}

function emptySummary(options) {
  return {
    generatedAt: new Date().toISOString(),
    dryRun: options.dryRun,
    batchSize: options.batchSize,
    maxBatches: options.maxBatches,
    scanned: 0,
    planned: 0,
    migrated: 0,
    mappedExisting: 0,
    skipped: 0,
    errors: 0,
    results: [],
  };
}

function applyResult(summary, result) {
  summary.results.push(result);
  if (result.status === 'migrated' || result.status === 'migrated_without_variants') {
    summary.migrated += 1;
  } else if (result.status === 'dry_run') {
    summary.planned += 1;
  } else if (result.status === 'mapped_existing') {
    summary.mappedExisting += 1;
  } else if (result.status === 'error') {
    summary.errors += 1;
  } else {
    summary.skipped += 1;
  }
}

function printSummary(summary) {
  console.log('\nLegacy image migration');
  console.log('======================');
  console.log(`Mode: ${summary.dryRun ? 'dry-run' : 'execute'}`);
  console.log(`Scanned: ${summary.scanned}`);
  console.log(`Would migrate: ${summary.planned}`);
  console.log(`Migrated: ${summary.migrated}`);
  console.log(`Mapped existing: ${summary.mappedExisting}`);
  console.log(`Skipped: ${summary.skipped}`);
  console.log(`Errors: ${summary.errors}`);

  const notable = summary.results.filter((item) => item.status !== 'migrated' && item.status !== 'dry_run');
  if (notable.length > 0) {
    console.log('\nNon-migrated rows');
    console.table(notable.slice(0, 30));
  }
}

async function writeJsonReport(jsonPath, summary) {
  const outputPath = path.resolve(process.cwd(), jsonPath);
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`\nJSON report written to ${outputPath}`);
}

async function runMigration(options) {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  if (!options.dryRun) {
    await migrationService.ensureMigrationColumns();
  }
  const summary = emptySummary(options);

  for (let batchIndex = 0; batchIndex < options.maxBatches; batchIndex += 1) {
    const rows = await migrationService.listLegacyImagesForMigration({
      limit: options.batchSize,
      includeMigrated: options.includeMigrated,
    });

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      summary.scanned += 1;
      try {
        const result = await migrationService.migrateLegacyImageRecord(row, {
          dryRun: options.dryRun,
        });
        applyResult(summary, result);
      } catch (error) {
        applyResult(summary, {
          status: 'error',
          imageId: row.id,
          error: error.message || String(error),
        });
      }
    }

    if (options.dryRun || rows.length < options.batchSize) {
      break;
    }
  }

  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.dryRun) {
    console.log('Dry-run mode. Pass --execute to write media_files and Images.mediaFileId mappings.');
  }

  const summary = await runMigration(options);
  printSummary(summary);

  if (options.jsonPath) {
    await writeJsonReport(options.jsonPath, summary);
  }
}

main()
  .catch((error) => {
    console.error(`Legacy image migration failed: ${error.message || error}`);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
