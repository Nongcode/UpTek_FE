const fs = require('fs');
const mediaConfig = require('../config/media');
const mediaService = require('./mediaService');
const mediaVariantService = require('./mediaVariantService');
const { createStorageProvider } = require('../storage');

const MEDIA_VISIBILITY = {
  PUBLIC: 'public',
  PRIVATE: 'private',
  INTERNAL: 'internal',
};

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function canReadMediaFile(mediaFile, auth = {}) {
  const visibility = mediaFile?.visibility || MEDIA_VISIBILITY.PRIVATE;
  if (visibility === MEDIA_VISIBILITY.PUBLIC) {
    return true;
  }

  if (!auth?.employeeId) {
    return false;
  }

  if (auth.canViewAllSessions) {
    return true;
  }

  if (mediaFile.company_id && mediaFile.company_id !== auth.companyId) {
    return false;
  }

  if (
    visibility === MEDIA_VISIBILITY.INTERNAL
    && mediaFile.department_id
    && mediaFile.department_id !== auth.departmentId
  ) {
    return false;
  }

  return true;
}

function encodeQueryToken(token) {
  return token ? `?token=${encodeURIComponent(token)}` : '';
}

function normalizeObjectKey(objectKey) {
  return String(objectKey || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function buildAbsoluteObjectUrl(objectKey) {
  const baseUrl = mediaConfig.cdnBaseUrl || mediaConfig.publicBaseUrl;
  if (!baseUrl) {
    return null;
  }
  return `${baseUrl}/${encodeURI(normalizeObjectKey(objectKey))}`;
}

function isPublicMedia(mediaFile) {
  return (mediaFile?.visibility || MEDIA_VISIBILITY.PRIVATE) === MEDIA_VISIBILITY.PUBLIC;
}

function buildOriginalReadUrl(mediaFileId, token, mediaFile) {
  if (isPublicMedia(mediaFile)) {
    const publicUrl = buildAbsoluteObjectUrl(mediaFile.object_key);
    if (publicUrl) {
      return publicUrl;
    }
  }
  return `/api/media/${encodeURIComponent(mediaFileId)}/read${encodeQueryToken(token)}`;
}

function buildVariantReadUrl(mediaFileId, variantType, token, mediaFile, variant) {
  if (isPublicMedia(mediaFile)) {
    const publicUrl = buildAbsoluteObjectUrl(variant?.object_key);
    if (publicUrl) {
      return publicUrl;
    }
  }
  const safeVariant = encodeURIComponent(String(variantType || ''));
  return `/api/media/${encodeURIComponent(mediaFileId)}/variants/${safeVariant}/read${encodeQueryToken(token)}`;
}

async function getMediaFileForRead(mediaFileId, auth) {
  const mediaFile = await mediaService.findMediaFileById(mediaFileId);
  if (!mediaFile || mediaFile.deleted_at || mediaFile.status === 'deleted') {
    return null;
  }

  if (!canReadMediaFile(mediaFile, auth)) {
    throw createHttpError(403, 'Forbidden');
  }

  return mediaFile;
}

async function getMediaMetadata(mediaFileId, auth, token) {
  const mediaFile = await getMediaFileForRead(mediaFileId, auth);
  if (!mediaFile) {
    return null;
  }

  const variants = await mediaVariantService.findVariantsByMediaFileId(mediaFileId);
  return {
    ...mediaFile,
    readUrl: buildOriginalReadUrl(mediaFile.id, token, mediaFile),
    variants: variants.map((variant) => ({
      ...variant,
      readUrl: buildVariantReadUrl(mediaFile.id, variant.variant_type, token, mediaFile, variant),
    })),
  };
}

async function getReadTarget({ mediaFileId, variantType = 'original', auth }) {
  const mediaFile = await getMediaFileForRead(mediaFileId, auth);
  if (!mediaFile) {
    return null;
  }

  let objectKey = mediaFile.object_key;
  let mimeType = mediaFile.mime_type;

  if (variantType && variantType !== 'original') {
    const variants = await mediaVariantService.findVariantsByMediaFileId(mediaFile.id);
    const variant = variants.find((item) => item.variant_type === variantType);
    if (!variant) {
      return null;
    }
    objectKey = variant.object_key;
    mimeType = variant.mime_type || mimeType;
  }

  const storageProvider = createStorageProvider();
  const publicUrl = storageProvider.getPublicUrl?.({ objectKey });
  if (publicUrl) {
    return { mode: 'redirect', url: publicUrl };
  }

  if (typeof storageProvider.resolveObjectPath === 'function') {
    const filePath = storageProvider.resolveObjectPath(objectKey);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return {
      mode: 'file',
      filePath,
      mimeType: mimeType || 'application/octet-stream',
    };
  }

  const signedUrl = await storageProvider.getSignedReadUrl({ objectKey });
  return { mode: 'redirect', url: signedUrl };
}

module.exports = {
  MEDIA_VISIBILITY,
  buildAbsoluteObjectUrl,
  buildOriginalReadUrl,
  buildVariantReadUrl,
  canReadMediaFile,
  getMediaMetadata,
  getReadTarget,
};
