const path = require('path');

function sanitizePathSegment(value, fallback) {
  const raw = String(value || '').trim();
  const normalized = raw
    .replace(/[\\/]+/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80);

  return normalized || fallback;
}

function assertPathInsideRoot(rootDir, targetPath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return target;
  }
  throw new Error('Unsafe media storage path');
}

module.exports = {
  assertPathInsideRoot,
  sanitizePathSegment,
};
