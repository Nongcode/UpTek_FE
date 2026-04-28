const path = require('path');
const { sanitizePathSegment } = require('./pathSafety');

function padDatePart(value) {
  return String(value).padStart(2, '0');
}

function sanitizeExtension(value) {
  const raw = String(value || '').trim().replace(/^\./, '');
  return raw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'bin';
}

function buildMediaObjectKey(options = {}) {
  const createdAt = options.createdAt ? new Date(options.createdAt) : new Date();
  const category = sanitizePathSegment(options.category, 'uncategorized');
  const companyId = sanitizePathSegment(options.companyId, 'global');
  const departmentId = sanitizePathSegment(options.departmentId, 'default');
  const mediaId = sanitizePathSegment(options.mediaId, 'media');
  const variant = sanitizePathSegment(options.variant || 'original', 'original');
  const ext = sanitizeExtension(options.extension || path.extname(options.originalFilename || ''));

  const yyyy = String(createdAt.getUTCFullYear());
  const mm = padDatePart(createdAt.getUTCMonth() + 1);
  const dd = padDatePart(createdAt.getUTCDate());

  return [
    category,
    companyId,
    departmentId,
    yyyy,
    mm,
    dd,
    mediaId,
    `${variant}.${ext}`,
  ].join('/');
}

module.exports = {
  buildMediaObjectKey,
  sanitizeExtension,
};
