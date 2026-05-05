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


    // ─── GP3: manager_instances ───────────────────────────────────────────────
    // Lưu danh sách manager instances (A, B, C...)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "manager_instances" (
        "id"             VARCHAR(64) PRIMARY KEY,
        "baseAgentKey"   VARCHAR(64) NOT NULL,
        "label"          VARCHAR(255),
        "status"         VARCHAR(32) NOT NULL DEFAULT 'active',
        "config"         JSONB,
        "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ─── GP3: manager_worker_bindings ─────────────────────────────────────────
    // Mapping manager instance → worker agent IDs
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "manager_worker_bindings" (
        "id"                VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
        "managerInstanceId" VARCHAR(64) NOT NULL REFERENCES "manager_instances"("id") ON DELETE CASCADE,
        "workerAgentId"     VARCHAR(64) NOT NULL,
        "role"              VARCHAR(64) NOT NULL DEFAULT 'worker',
        "createdAt"         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE ("managerInstanceId", "workerAgentId")
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS "idx_mwb_manager_instance"
        ON "manager_worker_bindings" ("managerInstanceId")
    `);

    // ─── GP3: thêm managerInstanceId vào Conversations ───────────────────────
    // DEFAULT 'mgr_pho_phong_A' → dữ liệu cũ tự nhận instance mặc định
    await pool.query(`
      ALTER TABLE "Conversations"
        ADD COLUMN IF NOT EXISTS "managerInstanceId" VARCHAR(64) DEFAULT 'mgr_pho_phong_A'
    `);

    // ─── GP3: thêm managerInstanceId vào Messages ────────────────────────────
    await pool.query(`
      ALTER TABLE "Messages"
        ADD COLUMN IF NOT EXISTS "managerInstanceId" VARCHAR(64) DEFAULT 'mgr_pho_phong_A'
    `);

    // ─── GP3: index để query nhanh theo managerInstanceId ────────────────────
    await pool.query(`
      CREATE INDEX IF NOT EXISTS "idx_conversations_manager_instance"
        ON "Conversations" ("managerInstanceId")
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS "idx_messages_manager_instance"
        ON "Messages" ("managerInstanceId")
    `);

    // ─── GP3: Seed manager instances ─────────────────────────────────────────
    // mgr_pho_phong_A: instance production mặc định
    await pool.query(`
      INSERT INTO "manager_instances" ("id", "baseAgentKey", "label", "status")
      VALUES ('mgr_pho_phong_A', 'pho_phong', 'Phó Phòng A (Production)', 'active')
      ON CONFLICT ("id") DO NOTHING
    `);
    // mgr_pho_phong_B: instance experimental dùng để test
    await pool.query(`
      INSERT INTO "manager_instances" ("id", "baseAgentKey", "label", "status")
      VALUES ('mgr_pho_phong_B', 'pho_phong', 'Phó Phòng B (Experimental)', 'experimental')
      ON CONFLICT ("id") DO NOTHING
    `);

    // ─── GP3: Seed worker bindings ────────────────────────────────────────────
    // Cả A và B cùng share 3 workers (shared workers, context được truyền qua payload)
    const workerAgents = ['nv_content', 'nv_media', 'nv_prompt'];
    const managerIds = ['mgr_pho_phong_A', 'mgr_pho_phong_B'];
    for (const mgrId of managerIds) {
      for (const workerId of workerAgents) {
        await pool.query(`
          INSERT INTO "manager_worker_bindings" ("managerInstanceId", "workerAgentId", "role")
          VALUES ($1, $2, 'worker')
          ON CONFLICT ("managerInstanceId", "workerAgentId") DO NOTHING
        `, [mgrId, workerId]);
      }
    }

    console.log('Migration completed successfully');
    console.log('GP3: manager_instances and manager_worker_bindings tables created.');
    console.log('GP3: managerInstanceId column added to Conversations and Messages.');
    console.log('GP3: Seeded mgr_pho_phong_A (active) and mgr_pho_phong_B (experimental).');

  } catch(e) {
    console.error('Migration error:', e.message);
    process.exit(1);
  }
  process.exit(0);
})();
