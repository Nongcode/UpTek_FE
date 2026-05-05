/**
 * Migration v2 — Thêm fields nghiệp vụ cho Conversations + bảng Workflows.
 *
 * Chạy: node migrate-v2.js
 *
 * Thay đổi:
 * - Conversations: + workflowId, lane, role, parentConversationId
 * - Bảng Workflows mới
 * - Backfill lane='automation' cho data cũ
 * - Indexes cho performance
 */
const pool = require('./src/database');

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('[1/6] Adding columns to Conversations...');
    await client.query('ALTER TABLE "Conversations" ADD COLUMN IF NOT EXISTS "workflowId" VARCHAR(255)');
    await client.query('ALTER TABLE "Conversations" ADD COLUMN IF NOT EXISTS "lane" VARCHAR(20) NOT NULL DEFAULT \'user\'');
    await client.query('ALTER TABLE "Conversations" ADD COLUMN IF NOT EXISTS "role" VARCHAR(20) NOT NULL DEFAULT \'root\'');
    await client.query('ALTER TABLE "Conversations" ADD COLUMN IF NOT EXISTS "parentConversationId" VARCHAR(255)');

    console.log('[2/6] Creating indexes...');
    await client.query('CREATE INDEX IF NOT EXISTS "idx_conv_workflowId" ON "Conversations" ("workflowId")');
    await client.query('CREATE INDEX IF NOT EXISTS "idx_conv_lane" ON "Conversations" ("lane")');
    await client.query('CREATE INDEX IF NOT EXISTS "idx_conv_parent" ON "Conversations" ("parentConversationId")');
    await client.query('CREATE INDEX IF NOT EXISTS "idx_conv_agent_workflow" ON "Conversations" ("agentId", "workflowId")');

    console.log('[3/6] Creating Workflows table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS "Workflows" (
        "id" VARCHAR(255) PRIMARY KEY,
        "rootConversationId" VARCHAR(255),
        "initiatorAgentId" VARCHAR(255),
        "initiatorEmployeeId" VARCHAR(255),
        "status" VARCHAR(50) DEFAULT 'active',
        "title" TEXT,
        "inputPayload" TEXT,
        "createdAt" BIGINT,
        "updatedAt" BIGINT
      )
    `);

    console.log('[4/6] Backfilling lane for existing automation conversations...');
    const backfillResult = await client.query(`
      UPDATE "Conversations"
      SET "lane" = 'automation'
      WHERE "lane" = 'user'
        AND (
          "sessionKey" LIKE 'automation:%'
          OR "id" LIKE 'auto_%'
          OR "title" LIKE '[AUTO]%'
        )
    `);
    console.log(`  → Backfilled ${backfillResult.rowCount} automation conversations.`);

    console.log('[5/6] Backfilling workflowId from sessionKey for existing automation conversations...');
    // Pattern: automation:{agentId}:{workflowId} → extract workflowId phần cuối
    // Hoặc id = auto_{employeeId}_{workflowId} → extract workflowId
    const autoConvs = await client.query(`
      SELECT "id", "sessionKey"
      FROM "Conversations"
      WHERE "lane" = 'automation' AND "workflowId" IS NULL
    `);
    let wfBackfillCount = 0;
    for (const row of autoConvs.rows) {
      const sessionKey = String(row.sessionKey || '');
      // Try to extract workflowId from sessionKey patterns
      // automation:{agentId}:{wf_xxx} or automation:{agentId}:{employeeId}:{wf_xxx}
      const wfMatch = sessionKey.match(/(?:^automation:[^:]+:)(wf_[^:]+)$/i)
        || sessionKey.match(/(?:^automation:[^:]+:[^:]+:)(wf_[^:]+)$/i);
      if (wfMatch) {
        await client.query(
          'UPDATE "Conversations" SET "workflowId" = $1 WHERE "id" = $2',
          [wfMatch[1], row.id]
        );
        wfBackfillCount++;
      }
    }
    console.log(`  → Backfilled workflowId for ${wfBackfillCount} conversations.`);

    console.log('[6/6] Committing transaction...');
    await client.query('COMMIT');
    console.log('✅ Migration v2 completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration v2 failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
})();
