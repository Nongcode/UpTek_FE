const pool = require('./src/database');
(async () => {
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

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
    await pool.query(`
      INSERT INTO "manager_instances" ("id", "baseAgentKey", "label", "status")
      VALUES ('mgr_pho_phong_C', 'pho_phong', 'Pho Phong C (KD2)', 'active')
      ON CONFLICT ("id") DO NOTHING
    `);

    // ─── GP3: Seed worker bindings ────────────────────────────────────────────
    // A, B, and C share the same worker templates; payload context keeps each lane isolated.
    const workerAgents = ['nv_content', 'nv_media', 'nv_prompt'];
    const managerIds = ['mgr_pho_phong_A', 'mgr_pho_phong_B', 'mgr_pho_phong_C'];
    for (const mgrId of managerIds) {
      for (const workerId of workerAgents) {
        await pool.query(`
          INSERT INTO "manager_worker_bindings" ("managerInstanceId", "workerAgentId", "role")
          VALUES ($1, $2, 'worker')
          ON CONFLICT ("managerInstanceId", "workerAgentId") DO NOTHING
        `, [mgrId, workerId]);
      }
    }

    // Executive assistant access foundation. The reminder worker is not enabled by this migration.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "UserAgentAccess" (
        "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
        "employeeId" VARCHAR(64) NOT NULL,
        "agentId" VARCHAR(64) NOT NULL,
        "enabled" BOOLEAN NOT NULL DEFAULT false,
        "grantedBy" VARCHAR(64),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE ("employeeId", "agentId")
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS "AgentCapabilities" (
        "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
        "agentId" VARCHAR(64) NOT NULL,
        "capability" VARCHAR(100) NOT NULL,
        "description" TEXT,
        "defaultEnabled" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE ("agentId", "capability")
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS "UserCapabilityOverrides" (
        "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
        "employeeId" VARCHAR(64) NOT NULL,
        "agentId" VARCHAR(64) NOT NULL,
        "capability" VARCHAR(100) NOT NULL,
        "enabled" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE ("employeeId", "agentId", "capability")
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS "AssistantSchedules" (
        "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
        "ownerEmployeeId" VARCHAR(64) NOT NULL,
        "createdByEmployeeId" VARCHAR(64) NOT NULL,
        "title" VARCHAR(255) NOT NULL,
        "planDate" DATE NOT NULL,
        "rawRequest" TEXT NOT NULL,
        "planJson" JSONB NOT NULL DEFAULT '{}'::jsonb,
        "status" VARCHAR(50) NOT NULL DEFAULT 'draft',
        "approvedAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS "AssistantReminderJobs" (
        "id" VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
        "scheduleId" VARCHAR(255) REFERENCES "AssistantSchedules"("id") ON DELETE CASCADE,
        "ownerEmployeeId" VARCHAR(64) NOT NULL,
        "emailTo" VARCHAR(255) NOT NULL,
        "subject" VARCHAR(255) NOT NULL,
        "body" TEXT NOT NULL,
        "remindAt" TIMESTAMPTZ NOT NULL,
        "status" VARCHAR(50) NOT NULL DEFAULT 'pending',
        "retryCount" INTEGER NOT NULL DEFAULT 0,
        "lastError" TEXT,
        "sentAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query('CREATE INDEX IF NOT EXISTS "idx_user_agent_access_employee" ON "UserAgentAccess" ("employeeId")');
    await pool.query('CREATE INDEX IF NOT EXISTS "idx_user_agent_access_agent_enabled" ON "UserAgentAccess" ("agentId", "enabled")');
    await pool.query('CREATE INDEX IF NOT EXISTS "idx_agent_capabilities_agent" ON "AgentCapabilities" ("agentId")');
    await pool.query('CREATE INDEX IF NOT EXISTS "idx_user_capability_overrides_employee_agent" ON "UserCapabilityOverrides" ("employeeId", "agentId")');
    await pool.query('CREATE INDEX IF NOT EXISTS "idx_assistant_schedules_owner_date" ON "AssistantSchedules" ("ownerEmployeeId", "planDate")');
    await pool.query('CREATE INDEX IF NOT EXISTS "idx_assistant_reminder_jobs_due" ON "AssistantReminderJobs" ("status", "remindAt")');

    const assistantCapabilities = [
      ['assistant.schedule.plan', 'Lap ke hoach lich trinh trong ngay tu noi dung nhap tay.', true],
      ['assistant.reminder.email', 'Tao nhac lich bang email den email dang nhap cua user.', true],
      ['assistant.travel.mock_eta', 'Mo phong thoi gian di chuyen khi chua cau hinh Google Maps API.', true],
      ['assistant.calendar.write', 'Tao hoac sua lich that tren he thong lich ngoai.', false],
      ['assistant.product.analysis', 'Phan tich san pham, USP, diem manh, diem yeu va thong tin can xac minh.', true],
      ['assistant.market.analysis', 'Phan tich thi truong Viet Nam, phan khuc khach hang, B2B/B2C, mua vu va khu vuc.', true],
      ['assistant.competitor.analysis', 'Phan tich doi thu truc tiep, gian tiep va khoang trong thi truong.', true],
      ['assistant.sales.plan', 'Lap ke hoach ban hang chi tiet de user duyet.', true],
      ['assistant.facebook.promotion.plan', 'Lap ke hoach quang ba Facebook chi tiet cho san pham.', true],
      ['assistant.web.search', 'Tim kiem web de bo sung tin hieu thi truong va doi thu khi co cau hinh API key.', true],
    ];
    for (const [capability, description, defaultEnabled] of assistantCapabilities) {
      await pool.query(`
        INSERT INTO "AgentCapabilities" ("agentId", "capability", "description", "defaultEnabled")
        VALUES ('nv_assistant', $1, $2, $3)
        ON CONFLICT ("agentId", "capability")
        DO UPDATE SET
          "description" = EXCLUDED."description",
          "defaultEnabled" = EXCLUDED."defaultEnabled"
      `, [capability, description, defaultEnabled]);
    }

    for (const employeeId of ['admin', 'giam_doc']) {
      await pool.query(`
        INSERT INTO "UserAgentAccess" ("employeeId", "agentId", "enabled", "grantedBy")
        VALUES ($1, 'nv_assistant', true, 'system')
        ON CONFLICT ("employeeId", "agentId")
        DO UPDATE SET
          "enabled" = true,
          "grantedBy" = COALESCE("UserAgentAccess"."grantedBy", EXCLUDED."grantedBy"),
          "updatedAt" = NOW()
      `, [employeeId]);
    }

    for (const employeeId of ['pho_phong_a', 'pho_phong_b', 'pho_phong_c']) {
      await pool.query(`
        INSERT INTO "UserAgentAccess" ("employeeId", "agentId", "enabled", "grantedBy")
        VALUES ($1, 'nv_assistant', false, 'system')
        ON CONFLICT ("employeeId", "agentId") DO NOTHING
      `, [employeeId]);
    }

    console.log('Migration completed successfully');
    console.log('GP3: manager_instances and manager_worker_bindings tables created.');
    console.log('GP3: managerInstanceId column added to Conversations and Messages.');
    console.log('GP3: Seeded mgr_pho_phong_A (active), mgr_pho_phong_B (experimental), and mgr_pho_phong_C (KD2 active).');
    console.log('Assistant: nv_assistant access, capability, schedule, and reminder tables created.');
  } catch(e) {
    console.error('Migration error:', e.message);
    process.exit(1);
  }
  process.exit(0);
})();
