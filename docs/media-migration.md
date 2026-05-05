# Media Migration

This document tracks the legacy image migration workflow. PR 3.1 only adds a dry-run audit; it does not upload files, update database rows, or delete anything.

## Legacy Image Audit

Run the audit from the backend folder so `.env` and `DATABASE_URL` resolve normally:

```bash
cd backend
node scripts/auditLegacyImages.js
```

Optional JSON report:

```bash
cd backend
node scripts/auditLegacyImages.js --json ../docs/legacy-images-audit.json
```

If `--json` is passed without a path, the script writes a timestamped JSON file in the backend folder.

## What The Audit Checks

The script reads the legacy `Images` table and scans `backend/storage/images`. It compares each `Images.url` path with the real file tree under the legacy storage root.

The report includes:

- total legacy DB records
- total scanned files
- valid records where DB and file both exist
- missing files or invalid legacy URLs
- orphan files that exist on disk but have no DB record
- duplicate DB references to the same file path
- referenced byte size and scanned storage byte size
- distribution by `companyId` and `departmentId`
- samples of missing records, invalid URLs, and orphan files

## Dry-Run Rules

The audit is read-only:

- no writes to `Images`
- no writes to `media_files` or `media_variants`
- no file deletion
- no upload to the new storage provider

Only the optional JSON report writes a report artifact to the path you provide.

## Interpreting Results

Before a real migration, review:

- `missingFiles`: DB rows that would not migrate without manual cleanup or fallback handling.
- `orphanFiles`: files that may need manual classification before import.
- `duplicateReferences`: multiple DB rows pointing at one file; decide whether to preserve duplicates as separate media records or deduplicate.
- per-company and per-department distribution: use this to estimate migration batches and verify access scopes.

## Next Migration Step

After the dry-run report is clean enough, a later PR can add an explicit migration script that creates `media_files` records for legacy rows and copies or references the actual files through the new storage abstraction.

## Legacy Image Migration

PR 3.2 adds a migration script that moves legacy `Images` records into the new media system while preserving the old files and rows.

Dry-run is the default:

```bash
cd backend
node scripts/migrateLegacyImages.js
```

Execute a real batch:

```bash
cd backend
node scripts/migrateLegacyImages.js --execute --batch-size 25 --max-batches 1
```

Write a JSON report:

```bash
cd backend
node scripts/migrateLegacyImages.js --execute --batch-size 25 --json ../docs/legacy-images-migration.json
```

Useful options:

- `--dry-run`: default mode; reads records and files but does not write storage or DB.
- `--execute`: uploads originals, creates `media_files`, creates variants, and writes `Images.mediaFileId`.
- `--batch-size <n>`: number of legacy rows to process per batch, capped at 500.
- `--max-batches <n>`: maximum batches per run.
- `--include-migrated`: include rows that already have `Images.mediaFileId`; normally this is omitted for resume behavior.
- `--json <path>`: write a machine-readable result report.

The script is designed to be resumable:

- `Images.mediaFileId` is the checkpoint for migrated rows.
- the media id is deterministic: `legacy_<Images.id>`.
- rerunning maps existing deterministic media records back to `Images.mediaFileId` instead of creating duplicates.
- missing files and invalid URLs are logged and skipped.

The script does not delete anything from `backend/storage/images`.

## Media Integrity And Cleanup

PR 3.4 adds report-first tools for checking the new media storage after migration.

Integrity check:

```bash
cd backend
node scripts/checkMediaIntegrity.js
```

Write a JSON integrity report:

```bash
cd backend
node scripts/checkMediaIntegrity.js --json ../docs/media-integrity-report.json
```

Cleanup planning:

```bash
cd backend
node scripts/cleanupOrphanMedia.js --dry-run --soft-delete-missing --plan-physical-delete
```

Execute only soft deletes for media files whose original object is missing:

```bash
cd backend
node scripts/cleanupOrphanMedia.js --execute --soft-delete-missing
```

The cleanup script never physically deletes storage objects in this PR. `--plan-physical-delete` only outputs a review list for orphan objects so a later PR can add delayed physical deletion safely.

Integrity checks include:

- `media_files` records whose original object is missing
- `media_variants` records whose object is missing
- storage objects that have no `media_files` or `media_variants` reference
- media files missing required variants: `thumb`, `small`, `medium`

Soft delete means setting `media_files.deleted_at` and `media_files.status = 'deleted'`; original files and variant files stay in storage.
