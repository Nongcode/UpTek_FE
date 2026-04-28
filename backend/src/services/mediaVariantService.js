const crypto = require('crypto');
const mediaRepository = require('../repositories/mediaRepository');

function createVariantId() {
  return `variant_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function normalizeVariantInput(input) {
  return {
    id: input.id || createVariantId(),
    media_file_id: input.mediaFileId,
    variant_type: input.variantType,
    bucket: input.bucket || null,
    object_key: input.objectKey,
    mime_type: input.mimeType || null,
    size_bytes: input.sizeBytes || null,
    width: input.width || null,
    height: input.height || null,
    created_at: input.createdAt || new Date(),
  };
}

function assertRequiredVariantFields(input) {
  if (!input.mediaFileId) {
    throw new Error('mediaFileId is required');
  }
  if (!input.variantType) {
    throw new Error('variantType is required');
  }
  if (!input.objectKey) {
    throw new Error('objectKey is required');
  }
}

// Stores derived media metadata such as thumbnails or optimized images.
async function createMediaVariant(input) {
  assertRequiredVariantFields(input);
  return mediaRepository.createMediaVariant(normalizeVariantInput(input));
}

async function findVariantsByMediaFileId(mediaFileId) {
  return mediaRepository.findVariantsByMediaFileId(mediaFileId);
}

module.exports = {
  createMediaVariant,
  findVariantsByMediaFileId,
};
