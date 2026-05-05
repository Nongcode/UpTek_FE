const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mediaConfig = require('../config/media');
const mediaService = require('./mediaService');
const mediaVariantService = require('./mediaVariantService');
const { createStorageProvider } = require('../storage');
const { processImageVariants } = require('../media/variantProcessor');
const { buildMediaObjectKey } = require('../utils/mediaObjectKey');
const {
  detectImageMime,
  isAllowedImageMime,
  sanitizeFilename,
  validateFileSize,
} = require('../utils/mediaValidation');

function createBadRequestError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function createMediaId() {
  return `media_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function getMaxUploadSizeBytes() {
  return mediaConfig.maxUploadSizeMb * 1024 * 1024;
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

function normalizeScope(input, auth) {
  return {
    category: input.category || 'gallery',
    companyId: input.companyId || auth?.companyId || 'default_company',
    departmentId: input.departmentId || auth?.departmentId || 'default_dept',
    ownerType: input.ownerType || null,
    ownerId: input.ownerId || null,
    productModel: input.productModel || null,
    source: input.source || 'api',
    visibility: input.visibility || 'private',
  };
}

function toMediaResponse(mediaFile, variants = [], readUrl = null) {
  return {
    ...mediaFile,
    variants,
    readUrl,
  };
}

async function uploadMediaFile({ file, body = {}, auth = {} }) {
  if (!file) {
    throw createBadRequestError('file is required');
  }
  if (!Buffer.isBuffer(file.buffer)) {
    throw createBadRequestError('file upload must be buffered');
  }

  const maxBytes = getMaxUploadSizeBytes();
  if (!validateFileSize(file.size, maxBytes)) {
    throw createBadRequestError(`File too large. Max upload size is ${mediaConfig.maxUploadSizeMb} MB`);
  }

  if (!isAllowedImageMime(file.mimetype, mediaConfig.allowedImageMime)) {
    throw createBadRequestError(`Unsupported image mime type: ${file.mimetype || 'unknown'}`);
  }

  const detectedMime = detectImageMime(file.buffer);
  if (!detectedMime || !isAllowedImageMime(detectedMime, mediaConfig.allowedImageMime)) {
    throw createBadRequestError('Uploaded file must be a valid supported image');
  }

  const mediaId = createMediaId();
  const originalFilename = sanitizeFilename(file.originalname);
  const extension = normalizeExtension(originalFilename, detectedMime);
  const scope = normalizeScope(body, auth);
  const checksumSha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const objectKey = buildMediaObjectKey({
    category: scope.category,
    companyId: scope.companyId,
    departmentId: scope.departmentId,
    mediaId,
    variant: 'original',
    extension,
  });

  const storageProvider = createStorageProvider();
  const uploadResult = await storageProvider.upload({
    objectKey,
    buffer: file.buffer,
    mimeType: detectedMime,
  });

  let mediaFile = await mediaService.createMediaFile({
    id: mediaId,
    ownerType: scope.ownerType,
    ownerId: scope.ownerId,
    category: scope.category,
    storageProvider: uploadResult.storageProvider,
    bucket: body.bucket || null,
    objectKey,
    originalFilename,
    mimeType: detectedMime,
    extension,
    sizeBytes: uploadResult.sizeBytes,
    checksumSha256,
    visibility: scope.visibility,
    status: 'active',
    companyId: scope.companyId,
    departmentId: scope.departmentId,
    productModel: scope.productModel,
    source: scope.source,
    createdBy: auth?.employeeId || body.createdBy || null,
  });

  let variants = [];
  const variantResult = await processImageVariants({
    mediaFile,
    originalBuffer: file.buffer,
    storageProvider,
  });
  variants = variantResult.variants;
  if (variantResult.originalMetadata) {
    mediaFile = {
      ...mediaFile,
      width: variantResult.originalMetadata.width,
      height: variantResult.originalMetadata.height,
    };
  }

  const readUrl = await storageProvider.getSignedReadUrl({ objectKey: mediaFile.object_key });
  return toMediaResponse(mediaFile, variants, readUrl);
}

async function uploadMediaFileFromPath({ file, body = {}, auth = {} }) {
  if (!file?.path) {
    throw createBadRequestError('file path is required');
  }

  const buffer = fs.readFileSync(file.path);
  return uploadMediaFile({
    file: {
      buffer,
      size: file.size || buffer.length,
      mimetype: file.mimetype,
      originalname: file.originalname || file.filename,
    },
    body,
    auth,
  });
}

async function uploadDecodedMediaFile({ buffer, mimeType, originalname, size, body = {}, auth = {} }) {
  return uploadMediaFile({
    file: {
      buffer,
      size: size || buffer.length,
      mimetype: mimeType,
      originalname,
    },
    body,
    auth,
  });
}

async function getMediaFileWithReadUrl(id) {
  const mediaFile = await mediaService.findMediaFileById(id);
  if (!mediaFile || mediaFile.deleted_at) {
    return null;
  }

  const variants = await mediaVariantService.findVariantsByMediaFileId(id);
  const storageProvider = createStorageProvider();
  const readUrl = await storageProvider.getSignedReadUrl({ objectKey: mediaFile.object_key });
  return toMediaResponse(mediaFile, variants, readUrl);
}

async function listMediaFiles(scope) {
  const mediaFiles = await mediaService.findMediaFilesByScope(scope);
  return {
    items: mediaFiles,
    limit: Number(scope?.limit) || 100,
  };
}

module.exports = {
  getMediaFileWithReadUrl,
  listMediaFiles,
  uploadMediaFile,
  uploadDecodedMediaFile,
  uploadMediaFileFromPath,
};
