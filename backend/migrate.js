const pool = require('./src/database');
(async () => {
  try {
    await pool.query('ALTER TABLE "Images" ADD COLUMN IF NOT EXISTS "productModel" VARCHAR(255)');
    await pool.query('ALTER TABLE "Images" ADD COLUMN IF NOT EXISTS "prefix" VARCHAR(255)');
    await pool.query('ALTER TABLE "Images" ADD COLUMN IF NOT EXISTS "mediaFileId" VARCHAR(255)');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS "media_files" (
        "id" VARCHAR(255) PRIMARY KEY,
        "owner_type" VARCHAR(100),
        "owner_id" VARCHAR(255),
        "category" VARCHAR(100),
        "storage_provider" VARCHAR(50) NOT NULL DEFAULT 'local',
        "bucket" VARCHAR(255),
        "object_key" TEXT NOT NULL,
        "original_filename" TEXT,
        "mime_type" VARCHAR(255),
        "extension" VARCHAR(32),
        "size_bytes" BIGINT,
        "width" INTEGER,
        "height" INTEGER,
        "checksum_sha256" CHAR(64),
        "visibility" VARCHAR(50) NOT NULL DEFAULT 'private',
        "status" VARCHAR(50) NOT NULL DEFAULT 'active',
        "company_id" VARCHAR(255),
        "department_id" VARCHAR(255),
        "product_model" VARCHAR(255),
        "source" VARCHAR(50),
        "created_by" VARCHAR(255),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "deleted_at" TIMESTAMPTZ
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS "media_variants" (
        "id" VARCHAR(255) PRIMARY KEY,
        "media_file_id" VARCHAR(255) NOT NULL REFERENCES "media_files"("id") ON DELETE CASCADE,
        "variant_type" VARCHAR(100) NOT NULL,
        "bucket" VARCHAR(255),
        "object_key" TEXT NOT NULL,
        "mime_type" VARCHAR(255),
        "size_bytes" BIGINT,
        "width" INTEGER,
        "height" INTEGER,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query('CREATE INDEX IF NOT EXISTS "idx_media_files_company_id" ON "media_files" ("company_id")');
    await pool.query('CREATE INDEX IF NOT EXISTS "idx_media_files_department_id" ON "media_files" ("department_id")');
    await pool.query('CREATE INDEX IF NOT EXISTS "idx_media_files_owner" ON "media_files" ("owner_type", "owner_id")');
    await pool.query('CREATE INDEX IF NOT EXISTS "idx_media_files_category" ON "media_files" ("category")');
    await pool.query('CREATE INDEX IF NOT EXISTS "idx_media_files_checksum_sha256" ON "media_files" ("checksum_sha256")');
    await pool.query('CREATE INDEX IF NOT EXISTS "idx_media_files_deleted_at" ON "media_files" ("deleted_at")');

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'media_variants_media_file_id_variant_type_unique'
        ) THEN
          ALTER TABLE "media_variants"
            ADD CONSTRAINT "media_variants_media_file_id_variant_type_unique"
            UNIQUE ("media_file_id", "variant_type");
        END IF;
      END
      $$;
    `);

    console.log('Migration completed successfully');
  } catch(e) {
    console.error('Migration error:', e.message);
    process.exit(1);
  }
  process.exit(0);
})();
