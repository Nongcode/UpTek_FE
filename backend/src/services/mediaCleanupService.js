const fs = require('fs');
const path = require('path');
const pool = require('../database');
const mediaService = require('./mediaService');
const { createStorageProvider } = require('../storage');

const REQUIRED_VARIANTS = ['thumb', 'small', 'medium'];

function toObjectKey(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

async function scanLocalObjects(storageProvider) {
  const rootDir = storageProvider.rootDir;
  const objects = new Map();
  if (!rootDir || !fs.existsSync(rootDir)) {
    return objects;
  }

  async function walk(dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const stat = await fs.promises.stat(absolutePath);
      const objectKey = toObjectKey(path.relative(rootDir, absolutePath));
      objects.set(objectKey, {
        objectKey,
        absolutePath,
        sizeBytes: stat.size,
      });
    }
  }

  await walk(rootDir);
  return objects;
}

async function listMediaRows(includeDeleted = false) {
  const result = await pool.query(
    `SELECT *
     FROM "media_files"
     ${includeDeleted ? '' : 'WHERE "deleted_at" IS NULL'}
     ORDER BY "created_at" DESC`
  );
  return result.rows;
}

async function listVariantRows() {
  const result = await pool.query(
    `SELECT *
     FROM "media_variants"
     ORDER BY "created_at" DESC`
  );
  return result.rows;
}

function addReference(referenceMap, objectKey, reference) {
  const key = toObjectKey(objectKey);
  if (!key) {
    return;
  }
  const references = referenceMap.get(key) || [];
  references.push(reference);
  referenceMap.set(key, references);
}

async function checkMediaIntegrity(options = {}) {
  const includeDeleted = options.includeDeleted === true;
  const storageProvider = createStorageProvider();
  const [mediaRows, variantRows, objects] = await Promise.all([
    listMediaRows(includeDeleted),
    listVariantRows(),
    scanLocalObjects(storageProvider),
  ]);

  const references = new Map();
  const missingObjects = [];
  const variantsByMediaId = new Map();

  for (const variant of variantRows) {
    const list = variantsByMediaId.get(variant.media_file_id) || [];
    list.push(variant);
    variantsByMediaId.set(variant.media_file_id, list);
  }

  for (const mediaFile of mediaRows) {
    const objectKey = toObjectKey(mediaFile.object_key);
    addReference(references, objectKey, {
      type: 'original',
      mediaFileId: mediaFile.id,
    });
    if (!objects.has(objectKey)) {
      missingObjects.push({
        type: 'original',
        mediaFileId: mediaFile.id,
        objectKey,
      });
    }

    for (const variant of variantsByMediaId.get(mediaFile.id) || []) {
      const variantObjectKey = toObjectKey(variant.object_key);
      addReference(references, variantObjectKey, {
        type: 'variant',
        mediaFileId: mediaFile.id,
        variantId: variant.id,
        variantType: variant.variant_type,
      });
      if (!objects.has(variantObjectKey)) {
        missingObjects.push({
          type: 'variant',
          mediaFileId: mediaFile.id,
          variantId: variant.id,
          variantType: variant.variant_type,
          objectKey: variantObjectKey,
        });
      }
    }
  }

  const missingVariants = [];
  for (const mediaFile of mediaRows) {
    const existingTypes = new Set((variantsByMediaId.get(mediaFile.id) || []).map((variant) => variant.variant_type));
    for (const requiredType of REQUIRED_VARIANTS) {
      if (!existingTypes.has(requiredType)) {
        missingVariants.push({
          mediaFileId: mediaFile.id,
          variantType: requiredType,
        });
      }
    }
  }

  const orphanObjects = [];
  for (const object of objects.values()) {
    if (!references.has(object.objectKey)) {
      orphanObjects.push(object);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    storageProvider: storageProvider.constructor.name,
    storageRoot: storageProvider.rootDir || null,
    totals: {
      mediaFiles: mediaRows.length,
      variants: variantRows.length,
      objects: objects.size,
      missingObjects: missingObjects.length,
      orphanObjects: orphanObjects.length,
      missingVariants: missingVariants.length,
    },
    missingObjects,
    orphanObjects,
    missingVariants,
  };
}

async function softDeleteMediaFiles(mediaFileIds, options = {}) {
  const dryRun = options.dryRun !== false;
  const results = [];

  for (const mediaFileId of mediaFileIds) {
    const mediaFile = await mediaService.findMediaFileById(mediaFileId);
    if (!mediaFile) {
      results.push({ mediaFileId, status: 'missing_record' });
      continue;
    }
    if (mediaFile.deleted_at) {
      results.push({ mediaFileId, status: 'already_deleted' });
      continue;
    }
    if (dryRun) {
      results.push({ mediaFileId, status: 'would_soft_delete' });
      continue;
    }

    const deleted = await mediaService.softDeleteMediaFile(mediaFileId);
    results.push({ mediaFileId, status: 'soft_deleted', deletedAt: deleted?.deleted_at || null });
  }

  return {
    dryRun,
    results,
  };
}

function planPhysicalDelete(orphanObjects) {
  return orphanObjects.map((object) => ({
    objectKey: object.objectKey,
    sizeBytes: object.sizeBytes,
    action: 'delete_after_review',
  }));
}

module.exports = {
  REQUIRED_VARIANTS,
  checkMediaIntegrity,
  planPhysicalDelete,
  softDeleteMediaFiles,
};
