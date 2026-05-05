const crypto = require('crypto');
const mediaRepository = require('../repositories/mediaRepository');

function createMediaId() {
  return `media_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function now() {
  return new Date();
}

function normalizeMediaFileInput(input) {
  const timestamp = now();
  return {
    id: input.id || createMediaId(),
    owner_type: input.ownerType || null,
    owner_id: input.ownerId || null,
    category: input.category || null,
    storage_provider: input.storageProvider || 'local',
    bucket: input.bucket || null,
    object_key: input.objectKey,
    original_filename: input.originalFilename || null,
    mime_type: input.mimeType || null,
    extension: input.extension || null,
    size_bytes: input.sizeBytes || null,
    width: input.width || null,
    height: input.height || null,
    checksum_sha256: input.checksumSha256 || null,
    visibility: input.visibility || 'private',
    status: input.status || 'active',
    company_id: input.companyId || null,
    department_id: input.departmentId || null,
    product_model: input.productModel || null,
    source: input.source || null,
    created_by: input.createdBy || null,
    created_at: input.createdAt || timestamp,
    updated_at: input.updatedAt || timestamp,
    deleted_at: input.deletedAt || null,
  };
}

function normalizeMediaFileUpdates(updates) {
  const normalized = {};
  const fieldMap = {
    ownerType: 'owner_type',
    ownerId: 'owner_id',
    category: 'category',
    storageProvider: 'storage_provider',
    bucket: 'bucket',
    objectKey: 'object_key',
    originalFilename: 'original_filename',
    mimeType: 'mime_type',
    extension: 'extension',
    sizeBytes: 'size_bytes',
    width: 'width',
    height: 'height',
    checksumSha256: 'checksum_sha256',
    visibility: 'visibility',
    status: 'status',
    companyId: 'company_id',
    departmentId: 'department_id',
    productModel: 'product_model',
    source: 'source',
    createdBy: 'created_by',
    deletedAt: 'deleted_at',
  };

  for (const [externalField, dbField] of Object.entries(fieldMap)) {
    if (updates[externalField] !== undefined) {
      normalized[dbField] = updates[externalField];
    }
  }

  normalized.updated_at = updates.updatedAt || now();
  return normalized;
}

function normalizeScope(scope = {}) {
  return {
    category: scope.category,
    companyId: scope.companyId,
    departmentId: scope.departmentId,
    limit: scope.limit,
    ownerId: scope.ownerId,
    ownerType: scope.ownerType,
    status: scope.status,
    visibility: scope.visibility,
  };
}

function assertRequiredMediaFileFields(input) {
  if (!input.objectKey) {
    throw new Error('objectKey is required');
  }
}

// Creates a canonical media_files record; upload flows should call this instead of writing SQL.
async function createMediaFile(input) {
  assertRequiredMediaFileFields(input);
  return mediaRepository.createMediaFile(normalizeMediaFileInput(input));
}

async function updateMediaFile(id, updates) {
  return mediaRepository.updateMediaFile(id, normalizeMediaFileUpdates(updates || {}));
}

async function findMediaFileById(id) {
  return mediaRepository.findMediaFileById(id);
}

async function findMediaFilesByScope(scope) {
  return mediaRepository.findMediaFilesByScope(normalizeScope(scope));
}

// Soft delete keeps file metadata for audit/migration while hiding it from scoped lists.
async function softDeleteMediaFile(id) {
  return mediaRepository.softDeleteMediaFile(id, now());
}

module.exports = {
  createMediaFile,
  findMediaFileById,
  findMediaFilesByScope,
  softDeleteMediaFile,
  updateMediaFile,
};
