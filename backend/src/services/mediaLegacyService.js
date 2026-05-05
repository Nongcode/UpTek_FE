const fs = require('fs');
const path = require('path');
const pool = require('../database');
const mediaConfig = require('../config/media');
const mediaUploadService = require('./mediaUploadService');
const mediaReadService = require('./mediaReadService');
const {
  getMaxUploadSizeBytes,
  isAllowedImageMime,
  isValidImageBuffer,
  sanitizeFilename,
  validateFileSize,
} = require('../utils/mediaValidation');
const {
  assertPathInsideRoot,
  sanitizePathSegment,
} = require('../utils/pathSafety');

const storageDir = mediaConfig.galleryStorageRoot;
const maxUploadSizeBytes = getMaxUploadSizeBytes(mediaConfig);

function createBadRequestError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function ensureStorageRoot() {
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }
}

async function ensureImagesTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "Images" (
        "id" VARCHAR(255) PRIMARY KEY,
        "url" TEXT NOT NULL,
        "companyId" VARCHAR(255),
        "departmentId" VARCHAR(255),
        "source" VARCHAR(50),
        "uploaderId" VARCHAR(255),
        "createdAt" BIGINT,
        "productModel" VARCHAR(255),
        "prefix" VARCHAR(255)
      );
    `);
    await pool.query('ALTER TABLE "Images" ADD COLUMN IF NOT EXISTS "mediaFileId" VARCHAR(255)');
    console.log('Ensure Images table exists.');
  } catch (err) {
    console.error('Failed to create Images table:', err.message);
  }
}

function buildGalleryImageUrl(companyId, departmentId, filename) {
  return `${mediaConfig.galleryPublicPath}/${companyId}/${departmentId}/${filename}`;
}

function resolveGalleryScope(auth, body = {}) {
  let companyId = auth?.companyId || 'default_company';
  let departmentId = auth?.departmentId || 'default_dept';

  // Allow high-level roles to override storage destination via request body.
  const canOverride = auth?.employeeId === 'admin' || auth?.employeeId === 'Admin' || auth?.employeeId === 'main' || auth?.employeeId === 'giam_doc';
  if (canOverride) {
    if (body.companyId) companyId = body.companyId;
    if (body.departmentId) departmentId = body.departmentId;
  }

  return {
    companyId: sanitizePathSegment(companyId, 'default_company'),
    departmentId: sanitizePathSegment(departmentId, 'default_dept'),
  };
}

function ensureGalleryDirectory(companyId, departmentId) {
  const dir = path.join(storageDir, companyId, departmentId);
  assertPathInsideRoot(storageDir, dir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function createStoredFilename(originalName) {
  return `${Date.now()}_${sanitizeFilename(originalName)}`;
}

function isAllowedUploadMime(mimeType) {
  return isAllowedImageMime(mimeType, mediaConfig.allowedImageMime);
}

function removeUploadedFiles(files) {
  for (const file of files || []) {
    if (file?.path && fs.existsSync(file.path)) {
      try {
        fs.unlinkSync(file.path);
      } catch {
        // Best-effort cleanup for rejected uploads.
      }
    }
  }
}

function validateUploadedFiles(files) {
  for (const file of files) {
    if (!validateFileSize(file.size, maxUploadSizeBytes)) {
      removeUploadedFiles(files);
      throw createBadRequestError(`File too large. Max upload size is ${mediaConfig.maxUploadSizeMb} MB`);
    }

    const fileBuffer = fs.readFileSync(file.path);
    if (!isValidImageBuffer(fileBuffer, mediaConfig.allowedImageMime)) {
      removeUploadedFiles(files);
      throw createBadRequestError('Uploaded file must be a valid supported image');
    }
  }
}

function emptyVariants() {
  return {
    thumb: null,
    small: null,
    medium: null,
  };
}

async function buildVariantMap(mediaRows, readToken) {
  const mediaById = new Map(mediaRows.map((row) => [row.media_file_id, row]).filter(([id]) => Boolean(id)));
  const mediaFileIds = Array.from(mediaById.keys());
  if (mediaFileIds.length === 0) {
    return new Map();
  }

  const result = await pool.query(
    `SELECT *
     FROM "media_variants"
     WHERE "media_file_id" = ANY($1::text[])
     ORDER BY "created_at" ASC`,
    [mediaFileIds]
  );

  const byMediaFileId = new Map();
  for (const variant of result.rows) {
    const variants = byMediaFileId.get(variant.media_file_id) || emptyVariants();
    const mediaFile = mediaById.get(variant.media_file_id);
    variants[variant.variant_type] = {
      url: mediaReadService.buildVariantReadUrl(variant.media_file_id, variant.variant_type, readToken, mediaFile, variant),
      mimeType: variant.mime_type,
      width: variant.width,
      height: variant.height,
      sizeBytes: variant.size_bytes,
    };
    byMediaFileId.set(variant.media_file_id, variants);
  }
  return byMediaFileId;
}

async function normalizeGalleryRows(rows, readToken) {
  const variantMap = await buildVariantMap(rows, readToken);

  return Promise.all(rows.map(async (row) => {
    const originalUrl = row.media_file_id
      ? mediaReadService.buildOriginalReadUrl(row.media_file_id, readToken, row)
      : row.legacy_url;

    return {
      id: row.id,
      url: originalUrl,
      legacyUrl: row.legacy_url || null,
      mediaFileId: row.media_file_id || null,
      source: row.source,
      productModel: row.productModel,
      prefix: row.prefix,
      createdAt: row.createdAt,
      companyId: row.companyId,
      departmentId: row.departmentId,
      uploaderId: row.uploaderId,
      mimeType: row.mime_type || null,
      width: row.width || null,
      height: row.height || null,
      originalUrl,
      variants: row.media_file_id ? (variantMap.get(row.media_file_id) || emptyVariants()) : emptyVariants(),
    };
  }));
}

async function listGalleryMediaRows(auth) {
  const conditions = [
    'mf."deleted_at" IS NULL',
    'mf."category" = $1',
    'mf."status" <> $2',
  ];
  const values = ['gallery', 'deleted'];

  if (!(auth?.employeeId === 'admin' || auth?.employeeId === 'giam_doc')) {
    values.push(auth?.companyId || 'UpTek');
    conditions.push(`mf."company_id" = $${values.length}`);
  }

  const result = await pool.query(
    `SELECT COALESCE(i."id", mf."id") AS "id",
            i."url" AS "legacy_url",
            mf."id" AS "media_file_id",
            COALESCE(mf."source", i."source") AS "source",
            COALESCE(mf."product_model", i."productModel") AS "productModel",
            i."prefix" AS "prefix",
            COALESCE((EXTRACT(EPOCH FROM mf."created_at") * 1000)::BIGINT, i."createdAt") AS "createdAt",
            COALESCE(mf."company_id", i."companyId") AS "companyId",
            COALESCE(mf."department_id", i."departmentId") AS "departmentId",
            COALESCE(mf."created_by", i."uploaderId") AS "uploaderId",
            mf."mime_type",
            mf."width",
            mf."height",
            mf."visibility",
            mf."object_key"
     FROM "media_files" mf
     LEFT JOIN "Images" i ON i."mediaFileId" = mf."id"
     WHERE ${conditions.join(' AND ')}
     ORDER BY mf."created_at" DESC`,
    values
  );
  return result.rows;
}

async function listLegacyFallbackRows(auth) {
  // Temporary compatibility path: only rows without a usable media_files mapping come from Images.
  let result;
  if (auth?.employeeId === 'admin' || auth?.employeeId === 'giam_doc') {
    result = await pool.query(`
      SELECT i."id",
             i."url" AS "legacy_url",
             NULL::VARCHAR AS "media_file_id",
             i."source",
             i."productModel",
             i."prefix",
             i."createdAt",
             i."companyId",
             i."departmentId",
             i."uploaderId",
             NULL::VARCHAR AS "mime_type",
             NULL::INTEGER AS "width",
             NULL::INTEGER AS "height",
             NULL::VARCHAR AS "visibility",
             NULL::TEXT AS "object_key"
      FROM "Images" i
      LEFT JOIN "media_files" mf ON mf."id" = i."mediaFileId"
      WHERE i."mediaFileId" IS NULL OR mf."id" IS NULL
      ORDER BY i."createdAt" DESC
    `);
  } else {
    const companyId = auth?.companyId || 'UpTek';
    result = await pool.query(
      `SELECT i."id",
              i."url" AS "legacy_url",
              NULL::VARCHAR AS "media_file_id",
              i."source",
              i."productModel",
              i."prefix",
              i."createdAt",
              i."companyId",
              i."departmentId",
              i."uploaderId",
              NULL::VARCHAR AS "mime_type",
              NULL::INTEGER AS "width",
              NULL::INTEGER AS "height",
              NULL::VARCHAR AS "visibility",
              NULL::TEXT AS "object_key"
       FROM "Images" i
       LEFT JOIN "media_files" mf ON mf."id" = i."mediaFileId"
       WHERE i."companyId" = $1
         AND (i."mediaFileId" IS NULL OR mf."id" IS NULL)
       ORDER BY i."createdAt" DESC`,
      [companyId]
    );
  }
  return result.rows;
}

async function listGalleryImages(auth, readToken) {
  const mediaRows = await listGalleryMediaRows(auth);
  const legacyRows = await listLegacyFallbackRows(auth);
  const normalized = await normalizeGalleryRows([...mediaRows, ...legacyRows], readToken);
  return normalized.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

async function saveUploadedGalleryImages({ files, auth, body }) {
  validateUploadedFiles(files);

  const { companyId, departmentId } = resolveGalleryScope(auth, body);
  const uploaderId = auth.employeeId || 'unknown';
  const createdAt = Date.now();
  const source = 'User';
  const prefix = null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uploadedImages = [];

    for (const file of files) {
      const url = buildGalleryImageUrl(companyId, departmentId, file.filename);
      const id = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const mediaFile = await mediaUploadService.uploadMediaFileFromPath({
        file,
        auth,
        body: {
          ...body,
          category: 'gallery',
          companyId,
          departmentId,
          productModel: body.productModel,
          source,
        },
      });

      await client.query(
        `INSERT INTO "Images" ("id", "url", "companyId", "departmentId", "source", "uploaderId", "createdAt", "productModel", "prefix", "mediaFileId")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, url, companyId, departmentId, source, uploaderId, createdAt, body.productModel, prefix, mediaFile.id]
      );
      uploadedImages.push({ id, url, mediaFileId: mediaFile.id });
    }

    await client.query('COMMIT');
    return { success: true, count: uploadedImages.length, images: uploadedImages };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  createStoredFilename,
  ensureGalleryDirectory,
  ensureImagesTable,
  ensureStorageRoot,
  getMaxUploadSizeBytes: () => maxUploadSizeBytes,
  getStorageDir: () => storageDir,
  isAllowedUploadMime,
  listGalleryImages,
  removeUploadedFiles,
  resolveGalleryScope,
  saveUploadedGalleryImages,
};
