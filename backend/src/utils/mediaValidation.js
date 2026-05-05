const path = require('path');

const FALLBACK_FILENAME = 'image';

function getMaxUploadSizeBytes(mediaConfig) {
  return mediaConfig.maxUploadSizeMb * 1024 * 1024;
}

function isAllowedImageMime(mimeType, allowedMimeTypes) {
  const normalizedMime = String(mimeType || '').toLowerCase();
  return allowedMimeTypes.map((item) => String(item).toLowerCase()).includes(normalizedMime);
}

function validateFileSize(size, maxBytes) {
  return Number.isFinite(size) && size > 0 && size <= maxBytes;
}

function sanitizeFilename(filename, fallback = FALLBACK_FILENAME) {
  const parsed = path.parse(String(filename || '').replace(/\\/g, '/'));
  const ext = parsed.ext.replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12);
  const base = parsed.name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 120);
  return `${base || fallback}${ext || ''}`;
}

function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return null;
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  const header = buffer.subarray(0, 12).toString('ascii');
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return 'image/gif';
  }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return 'image/webp';
  }

  return null;
}

function isValidImageBuffer(buffer, allowedMimeTypes) {
  const detectedMime = detectImageMime(buffer);
  return Boolean(detectedMime && isAllowedImageMime(detectedMime, allowedMimeTypes));
}

function decodeBase64ImagePayload(base64Data, options) {
  const { allowedMimeTypes, maxBytes } = options;
  const rawValue = String(base64Data || '').trim();
  if (!rawValue) {
    throw new Error('base64Data is required');
  }

  const dataUrlMatch = rawValue.match(/^data:([^;,]+);base64,(.+)$/i);
  const declaredMime = dataUrlMatch ? dataUrlMatch[1].toLowerCase() : null;
  const encoded = dataUrlMatch ? dataUrlMatch[2] : rawValue;

  if (declaredMime && !isAllowedImageMime(declaredMime, allowedMimeTypes)) {
    throw new Error(`Unsupported image mime type: ${declaredMime}`);
  }

  const compact = encoded.replace(/\s/g, '');
  if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new Error('base64Data must be valid base64 image data');
  }

  const padded = compact.padEnd(Math.ceil(compact.length / 4) * 4, '=');
  const estimatedBytes = Math.floor((padded.length * 3) / 4);
  if (estimatedBytes > maxBytes) {
    throw new Error(`Image is too large. Max upload size is ${maxBytes} bytes`);
  }

  const buffer = Buffer.from(padded, 'base64');
  if (!validateFileSize(buffer.length, maxBytes)) {
    throw new Error(`Image is too large. Max upload size is ${maxBytes} bytes`);
  }

  const detectedMime = detectImageMime(buffer);
  if (!detectedMime || !isAllowedImageMime(detectedMime, allowedMimeTypes)) {
    throw new Error('base64Data must decode to a supported image file');
  }

  return {
    buffer,
    mimeType: detectedMime,
    declaredMime,
  };
}

module.exports = {
  decodeBase64ImagePayload,
  detectImageMime,
  getMaxUploadSizeBytes,
  isAllowedImageMime,
  isValidImageBuffer,
  sanitizeFilename,
  validateFileSize,
};
