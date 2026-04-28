const path = require('path');

const backendRoot = path.resolve(__dirname, '../../');
const repoRoot = path.resolve(backendRoot, '..');

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parsePositiveInteger(value, defaultValue) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function parseCsv(value, defaultValue) {
  const raw = value === undefined || value === null || value === '' ? defaultValue : value;
  return String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveFromRepoRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

const mediaConfig = {
  // Storage driver is local today; future PRs can switch based on this value.
  storageDriver: process.env.MEDIA_STORAGE_DRIVER || 'local',
  enableObjectStorage: parseBoolean(process.env.MEDIA_ENABLE_OBJECT_STORAGE, false),
  enableVariants: parseBoolean(process.env.MEDIA_ENABLE_VARIANTS, false),
  // Public base is used only for public media URLs; private/internal media stay behind read routes.
  publicBaseUrl: normalizeBaseUrl(process.env.MEDIA_PUBLIC_BASE_URL),
  privateUrlTtlSeconds: parsePositiveInteger(process.env.MEDIA_PRIVATE_URL_TTL_SECONDS, 300),
  maxUploadSizeMb: parsePositiveInteger(process.env.MEDIA_MAX_UPLOAD_SIZE_MB, 10),
  allowedImageMime: parseCsv(
    process.env.MEDIA_ALLOWED_IMAGE_MIME,
    'image/jpeg,image/png,image/webp,image/gif',
  ),
  localRoot: resolveFromRepoRoot(process.env.MEDIA_LOCAL_ROOT || 'backend/storage_runtime/media'),
  // CDN wins over public base when set, so public media can move without DB changes.
  cdnBaseUrl: normalizeBaseUrl(process.env.MEDIA_CDN_BASE_URL),

  // Keep current gallery filesystem behavior until storage migration PRs change it.
  galleryStorageRoot: path.join(backendRoot, 'storage/images'),
  galleryPublicPath: '/storage/images',
};

module.exports = mediaConfig;
