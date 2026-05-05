const pool = require('../database');
const mediaConfig = require('../config/media');
const mediaUploadService = require('./mediaUploadService');
const {
  decodeBase64ImagePayload,
  getMaxUploadSizeBytes,
  sanitizeFilename,
} = require('../utils/mediaValidation');
const { sanitizePathSegment } = require('../utils/pathSafety');

const maxUploadSizeBytes = getMaxUploadSizeBytes(mediaConfig);

function createBadRequestError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function buildLegacyUrl(companyId, departmentId, mediaFile) {
  return `${mediaConfig.galleryPublicPath}/${companyId}/${departmentId}/${mediaFile.id}${mediaFile.extension || ''}`;
}

async function saveAgentUploadedImage(body) {
  const { companyId = 'default_company', departmentId = 'default_dept', filename, base64Data, agentId, productModel, prefix } = body;

  let decodedImage;
  try {
    decodedImage = decodeBase64ImagePayload(base64Data, {
      allowedMimeTypes: mediaConfig.allowedImageMime,
      maxBytes: maxUploadSizeBytes,
    });
  } catch (err) {
    throw createBadRequestError(err.message);
  }

  const safeCompanyId = sanitizePathSegment(companyId, 'default_company');
  const safeDepartmentId = sanitizePathSegment(departmentId, 'default_dept');
  const source = 'AI';
  const uploaderId = agentId || 'agent';
  const originalFilename = sanitizeFilename(filename);

  const mediaFile = await mediaUploadService.uploadDecodedMediaFile({
    buffer: decodedImage.buffer,
    mimeType: decodedImage.mimeType,
    originalname: originalFilename,
    size: decodedImage.buffer.length,
    auth: {
      employeeId: uploaderId,
      companyId: safeCompanyId,
      departmentId: safeDepartmentId,
    },
    body: {
      category: 'gallery',
      companyId: safeCompanyId,
      departmentId: safeDepartmentId,
      productModel,
      source,
      createdBy: uploaderId,
    },
  });

  const id = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const url = buildLegacyUrl(safeCompanyId, safeDepartmentId, mediaFile);
  const timestamp = Date.now();

  await pool.query(
    `INSERT INTO "Images" ("id", "url", "companyId", "departmentId", "source", "uploaderId", "createdAt", "productModel", "prefix", "mediaFileId")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, url, safeCompanyId, safeDepartmentId, source, uploaderId, timestamp, productModel, prefix, mediaFile.id]
  );

  return {
    success: true,
    url,
    id,
    mediaFileId: mediaFile.id,
  };
}

module.exports = {
  saveAgentUploadedImage,
};
