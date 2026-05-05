const pool = require('../database');

const MEDIA_FILE_COLUMNS = [
  'id',
  'owner_type',
  'owner_id',
  'category',
  'storage_provider',
  'bucket',
  'object_key',
  'original_filename',
  'mime_type',
  'extension',
  'size_bytes',
  'width',
  'height',
  'checksum_sha256',
  'visibility',
  'status',
  'company_id',
  'department_id',
  'product_model',
  'source',
  'created_by',
  'created_at',
  'updated_at',
  'deleted_at',
];

const MEDIA_VARIANT_COLUMNS = [
  'id',
  'media_file_id',
  'variant_type',
  'bucket',
  'object_key',
  'mime_type',
  'size_bytes',
  'width',
  'height',
  'created_at',
];

function buildInsert(tableName, payload, allowedColumns) {
  const columns = allowedColumns.filter((column) => payload[column] !== undefined);
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  const values = columns.map((column) => payload[column]);
  return {
    sql: `INSERT INTO "${tableName}" (${columns.map((column) => `"${column}"`).join(', ')})
          VALUES (${placeholders.join(', ')})
          RETURNING *`,
    values,
  };
}

function buildUpdate(tableName, id, updates, allowedColumns) {
  const columns = allowedColumns.filter((column) => column !== 'id' && updates[column] !== undefined);
  const assignments = columns.map((column, index) => `"${column}" = $${index + 1}`);
  const values = columns.map((column) => updates[column]);
  values.push(id);
  return {
    sql: `UPDATE "${tableName}"
          SET ${assignments.join(', ')}
          WHERE "id" = $${values.length}
          RETURNING *`,
    values,
    hasUpdates: columns.length > 0,
  };
}

async function createMediaFile(payload) {
  const query = buildInsert('media_files', payload, MEDIA_FILE_COLUMNS);
  const result = await pool.query(query.sql, query.values);
  return result.rows[0];
}

async function updateMediaFile(id, updates) {
  const query = buildUpdate('media_files', id, updates, MEDIA_FILE_COLUMNS);
  if (!query.hasUpdates) {
    return findMediaFileById(id);
  }
  const result = await pool.query(query.sql, query.values);
  return result.rows[0] || null;
}

async function findMediaFileById(id) {
  const result = await pool.query('SELECT * FROM "media_files" WHERE "id" = $1 LIMIT 1', [id]);
  return result.rows[0] || null;
}

async function findMediaFilesByScope(scope = {}) {
  const conditions = ['"deleted_at" IS NULL'];
  const values = [];

  for (const [column, value] of [
    ['company_id', scope.companyId],
    ['department_id', scope.departmentId],
    ['owner_type', scope.ownerType],
    ['owner_id', scope.ownerId],
    ['category', scope.category],
    ['status', scope.status],
    ['visibility', scope.visibility],
  ]) {
    if (value !== undefined && value !== null && value !== '') {
      values.push(value);
      conditions.push(`"${column}" = $${values.length}`);
    }
  }

  const limit = Number.isFinite(scope.limit) && scope.limit > 0 ? Math.min(scope.limit, 200) : 100;
  values.push(limit);

  const result = await pool.query(
    `SELECT *
     FROM "media_files"
     WHERE ${conditions.join(' AND ')}
     ORDER BY "created_at" DESC
     LIMIT $${values.length}`,
    values
  );
  return result.rows;
}

async function softDeleteMediaFile(id, deletedAt) {
  const result = await pool.query(
    `UPDATE "media_files"
     SET "deleted_at" = $2,
         "status" = 'deleted',
         "updated_at" = $2
     WHERE "id" = $1
     RETURNING *`,
    [id, deletedAt]
  );
  return result.rows[0] || null;
}

async function createMediaVariant(payload) {
  const query = buildInsert('media_variants', payload, MEDIA_VARIANT_COLUMNS);
  const result = await pool.query(query.sql, query.values);
  return result.rows[0];
}

async function findVariantsByMediaFileId(mediaFileId) {
  const result = await pool.query(
    'SELECT * FROM "media_variants" WHERE "media_file_id" = $1 ORDER BY "created_at" ASC',
    [mediaFileId]
  );
  return result.rows;
}

module.exports = {
  createMediaFile,
  createMediaVariant,
  findMediaFileById,
  findMediaFilesByScope,
  findVariantsByMediaFileId,
  softDeleteMediaFile,
  updateMediaFile,
};
