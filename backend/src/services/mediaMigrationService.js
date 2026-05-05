const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pool = require('../database');
const mediaConfig = require('../config/media');
const mediaService = require('./mediaService');
const mediaVariantService = require('./mediaVariantService');
const { processImageVariants } = require('../media/variantProcessor');
const { createStorageProvider } = require('../storage');
const { buildMediaObjectKey } = require('../utils/mediaObjectKey');
const {
  detectImageMime,
  isAllowedImageMime,
  sanitizeFilename,
  validateFileSize,
} = require('../utils/mediaValidation');
const { assertPathInsideRoot } = require('../utils/pathSafety');

const legacyStorageRoot = mediaConfig.galleryStorageRoot;
const legacyPublicPrefix = `${mediaConfig.galleryPublicPath}/`;

function createLegacyMediaId(imageId) {
  return `legacy_${String(imageId || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function normalizeExtension(filename, mimeType) {
  const fromName = path.extname(filename || '').replace(/^\./, '').toLowerCase();
  if (fromName) {
    return `.${fromName}`;
  }

  switch (mimeType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    default:
      return '.bin';
  }
}

function resolveLegacyImagePath(url) {
  const raw = String(url || '').trim();
  if (!raw) {
    return { filePath: null, relativePath: null, error: 'empty legacy url' };
  }

  let pathname = raw;
  try {
    if (/^https?:\/\//i.test(raw)) {
      pathname = new URL(raw).pathname;
    }
  } catch {
    return { filePath: null, relativePath: null, error: 'invalid legacy url' };
  }

  if (pathname.startsWith(legacyPublicPrefix)) {
    pathname = pathname.slice(legacyPublicPrefix.length);
  } else if (pathname.startsWith('/')) {
    return { filePath: null, relativePath: null, error: `legacy url does not start with ${legacyPublicPrefix}` };
  }

  const relativePath = decodeURIComponent(pathname).replace(/\\/g, '/').replace(/^\/+/, '');
  const filePath = path.resolve(legacyStorageRoot, relativePath);
  try {
    assertPathInsideRoot(legacyStorageRoot, filePath);
  } catch (err) {
    return { filePath: null, relativePath, error: err.message };
  }

  return { filePath, relativePath, error: null };
}

async function ensureMigrationColumns(client = pool) {
  await client.query('ALTER TABLE "Images" ADD COLUMN IF NOT EXISTS "mediaFileId" VARCHAR(255)');
}

async function hasImagesMediaFileIdColumn(client = pool) {
  const result = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_name = 'Images'
       AND column_name = 'mediaFileId'
     LIMIT 1`
  );
  return result.rowCount > 0;
}

async function listLegacyImagesForMigration({ limit = 50, includeMigrated = false } = {}) {
  const hasMediaFileId = await hasImagesMediaFileIdColumn();
  const values = [];
  const where = [];

  if (!includeMigrated && hasMediaFileId) {
    where.push('("mediaFileId" IS NULL OR "mediaFileId" = \'\')');
  }

  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50;
  values.push(safeLimit);

  const result = await pool.query(
    `SELECT "id", "url", "companyId", "departmentId", "source", "uploaderId", "createdAt", "productModel", "prefix",
            ${hasMediaFileId ? '"mediaFileId"' : 'NULL::VARCHAR AS "mediaFileId"'}
     FROM "Images"
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY "createdAt" ASC NULLS LAST, "id" ASC
     LIMIT $${values.length}`,
    values
  );
  return result.rows;
}

function validateLegacyFile(buffer, filePath) {
  const stat = fs.statSync(filePath);
  const maxBytes = mediaConfig.maxUploadSizeMb * 1024 * 1024;
  if (!validateFileSize(stat.size, maxBytes)) {
    throw new Error(`File too large. Max upload size is ${mediaConfig.maxUploadSizeMb} MB`);
  }

  const mimeType = detectImageMime(buffer);
  if (!mimeType || !isAllowedImageMime(mimeType, mediaConfig.allowedImageMime)) {
    throw new Error('Legacy file is not a supported image');
  }

  return { mimeType, sizeBytes: stat.size };
}

async function ensureVariants(mediaFile, originalBuffer, storageProvider) {
  const existingVariants = await mediaVariantService.findVariantsByMediaFileId(mediaFile.id);
  if (existingVariants.length > 0) {
    return existingVariants;
  }

  const result = await processImageVariants({
    mediaFile,
    originalBuffer,
    storageProvider,
  });
  return result.variants;
}

async function migrateLegacyImageRecord(record, options = {}) {
  const dryRun = options.dryRun === true;
  const forceVariants = options.forceVariants === true;

  if (record.mediaFileId) {
    const existing = await mediaService.findMediaFileById(record.mediaFileId);
    if (existing) {
      return { status: 'skipped', reason: 'already_mapped', imageId: record.id, mediaFileId: record.mediaFileId };
    }
  }

  const mediaId = createLegacyMediaId(record.id);
  const existingById = await mediaService.findMediaFileById(mediaId);
  if (existingById) {
    if (!dryRun) {
      await pool.query('UPDATE "Images" SET "mediaFileId" = $1 WHERE "id" = $2', [existingById.id, record.id]);
    }
    return { status: 'mapped_existing', imageId: record.id, mediaFileId: existingById.id };
  }

  const legacyPath = resolveLegacyImagePath(record.url);
  if (legacyPath.error) {
    return { status: 'skipped', reason: 'invalid_url', imageId: record.id, error: legacyPath.error };
  }
  if (!fs.existsSync(legacyPath.filePath)) {
    return { status: 'skipped', reason: 'missing_file', imageId: record.id, path: legacyPath.relativePath };
  }

  const buffer = fs.readFileSync(legacyPath.filePath);
  const { mimeType, sizeBytes } = validateLegacyFile(buffer, legacyPath.filePath);
  const originalFilename = sanitizeFilename(path.basename(legacyPath.filePath));
  const extension = normalizeExtension(originalFilename, mimeType);
  const createdAt = record.createdAt ? new Date(Number(record.createdAt)) : new Date();
  const checksumSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const objectKey = buildMediaObjectKey({
    category: 'gallery',
    companyId: record.companyId || 'default_company',
    departmentId: record.departmentId || 'default_dept',
    mediaId,
    variant: 'original',
    extension,
    createdAt,
  });

  if (dryRun) {
    return {
      status: 'dry_run',
      imageId: record.id,
      mediaFileId: mediaId,
      objectKey,
      sizeBytes,
      mimeType,
    };
  }

  const storageProvider = createStorageProvider();
  const uploadResult = await storageProvider.upload({
    objectKey,
    buffer,
    mimeType,
  });

  let mediaFile = await mediaService.createMediaFile({
    id: mediaId,
    ownerType: 'legacy_image',
    ownerId: record.id,
    category: 'gallery',
    storageProvider: uploadResult.storageProvider,
    bucket: null,
    objectKey,
    originalFilename,
    mimeType,
    extension,
    sizeBytes: uploadResult.sizeBytes || sizeBytes,
    checksumSha256,
    visibility: 'private',
    status: 'active',
    companyId: record.companyId || null,
    departmentId: record.departmentId || null,
    productModel: record.productModel || null,
    source: record.source || 'legacy',
    createdBy: record.uploaderId || null,
    createdAt,
    updatedAt: new Date(),
  });

  const variants = await ensureVariants(mediaFile, buffer, storageProvider);
  mediaFile = await mediaService.findMediaFileById(mediaId) || mediaFile;
  await pool.query('UPDATE "Images" SET "mediaFileId" = $1 WHERE "id" = $2', [mediaFile.id, record.id]);

  if (forceVariants && variants.length === 0) {
    return { status: 'migrated_without_variants', imageId: record.id, mediaFileId: mediaFile.id };
  }

  return {
    status: 'migrated',
    imageId: record.id,
    mediaFileId: mediaFile.id,
    variants: variants.length,
  };
}

module.exports = {
  createLegacyMediaId,
  hasImagesMediaFileIdColumn,
  ensureMigrationColumns,
  listLegacyImagesForMigration,
  migrateLegacyImageRecord,
  resolveLegacyImagePath,
};
