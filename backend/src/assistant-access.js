const pool = require("./database");

const ASSISTANT_AGENT_ID = "nv_assistant";

const DEFAULT_CAPABILITIES = [
  {
    capability: "assistant.schedule.plan",
    description: "Lap ke hoach lich trinh trong ngay tu noi dung nhap tay.",
    defaultEnabled: true,
  },
  {
    capability: "assistant.reminder.email",
    description: "Tao nhac lich bang email den email dang nhap cua user.",
    defaultEnabled: true,
  },
  {
    capability: "assistant.travel.mock_eta",
    description: "Mo phong thoi gian di chuyen khi chua cau hinh Google Maps API.",
    defaultEnabled: true,
  },
  {
    capability: "assistant.calendar.write",
    description: "Tao hoac sua lich that tren he thong lich ngoai.",
    defaultEnabled: false,
  },
];

async function ensureAssistantTables() {
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

  await pool.query(
    `CREATE INDEX IF NOT EXISTS "idx_user_agent_access_employee" ON "UserAgentAccess" ("employeeId")`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS "idx_user_agent_access_agent_enabled" ON "UserAgentAccess" ("agentId", "enabled")`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS "idx_agent_capabilities_agent" ON "AgentCapabilities" ("agentId")`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS "idx_user_capability_overrides_employee_agent" ON "UserCapabilityOverrides" ("employeeId", "agentId")`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS "idx_assistant_schedules_owner_date" ON "AssistantSchedules" ("ownerEmployeeId", "planDate")`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS "idx_assistant_reminder_jobs_due" ON "AssistantReminderJobs" ("status", "remindAt")`,
  );
}

async function seedAssistantAccessDefaults() {
  for (const item of DEFAULT_CAPABILITIES) {
    await pool.query(
      `INSERT INTO "AgentCapabilities" ("agentId", "capability", "description", "defaultEnabled")
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ("agentId", "capability")
       DO UPDATE SET
         "description" = EXCLUDED."description",
         "defaultEnabled" = EXCLUDED."defaultEnabled"`,
      [ASSISTANT_AGENT_ID, item.capability, item.description, item.defaultEnabled],
    );
  }

  for (const employeeId of ["admin", "giam_doc"]) {
    await pool.query(
      `INSERT INTO "UserAgentAccess" ("employeeId", "agentId", "enabled", "grantedBy")
       VALUES ($1, $2, true, 'system')
       ON CONFLICT ("employeeId", "agentId")
       DO UPDATE SET
         "enabled" = true,
         "grantedBy" = COALESCE("UserAgentAccess"."grantedBy", EXCLUDED."grantedBy"),
         "updatedAt" = NOW()`,
      [employeeId, ASSISTANT_AGENT_ID],
    );
  }

  for (const employeeId of ["pho_phong_a", "pho_phong_b"]) {
    await pool.query(
      `INSERT INTO "UserAgentAccess" ("employeeId", "agentId", "enabled", "grantedBy")
       VALUES ($1, $2, false, 'system')
       ON CONFLICT ("employeeId", "agentId") DO NOTHING`,
      [employeeId, ASSISTANT_AGENT_ID],
    );
  }
}

async function initializeAssistantAccessStore() {
  await ensureAssistantTables();
  await seedAssistantAccessDefaults();
}

function mapAccessRow(row) {
  return {
    employeeId: row.employeeId,
    employeeName: row.employeeName || null,
    email: row.email || null,
    role: row.role || null,
    status: row.status || null,
    agentId: row.agentId || ASSISTANT_AGENT_ID,
    enabled: row.enabled === true,
    grantedBy: row.grantedBy || null,
    updatedAt: row.updatedAt || null,
  };
}

async function getEnabledAgentIdsForEmployee(employeeId) {
  const result = await pool.query(
    `SELECT "agentId"
     FROM "UserAgentAccess"
     WHERE "employeeId" = $1
       AND "enabled" = true`,
    [employeeId],
  );
  return result.rows.map((row) => row.agentId).filter(Boolean);
}

async function listAssistantAccess() {
  await ensureAssistantTables();
  const result = await pool.query(
    `SELECT
       users."employee_id" AS "employeeId",
       users."employee_name" AS "employeeName",
       users."email",
       users."role",
       users."status",
       COALESCE(access."agentId", $1) AS "agentId",
       COALESCE(access."enabled", false) AS "enabled",
       access."grantedBy",
       access."updatedAt"
     FROM "system_users" users
     LEFT JOIN "UserAgentAccess" access
       ON access."employeeId" = users."employee_id"
      AND access."agentId" = $1
     ORDER BY
       CASE WHEN users."role" IN ('admin', 'giam_doc') THEN 0 ELSE 1 END,
       users."employee_name" ASC,
       users."email" ASC`,
    [ASSISTANT_AGENT_ID],
  );
  return result.rows.map(mapAccessRow);
}

async function setAssistantAccess(employeeId, enabled, grantedBy) {
  await ensureAssistantTables();
  const userResult = await pool.query(
    `SELECT "employee_id", "employee_name", "email", "role", "status"
     FROM "system_users"
     WHERE "employee_id" = $1
     LIMIT 1`,
    [employeeId],
  );
  const user = userResult.rows[0];
  if (!user) {
    const error = new Error("User not found");
    error.statusCode = 404;
    throw error;
  }

  const accessResult = await pool.query(
    `INSERT INTO "UserAgentAccess" ("employeeId", "agentId", "enabled", "grantedBy")
     VALUES ($1, $2, $3, $4)
     ON CONFLICT ("employeeId", "agentId")
     DO UPDATE SET
       "enabled" = EXCLUDED."enabled",
       "grantedBy" = EXCLUDED."grantedBy",
       "updatedAt" = NOW()
     RETURNING "agentId", "enabled", "grantedBy", "updatedAt"`,
    [employeeId, ASSISTANT_AGENT_ID, enabled === true, grantedBy || "system"],
  );
  return mapAccessRow({
    employeeId: user.employee_id,
    employeeName: user.employee_name,
    email: user.email,
    role: user.role,
    status: user.status,
    ...accessResult.rows[0],
  });
}

function normalizeReminder(reminder) {
  const remindAt = new Date(reminder?.remindAt || "");
  if (Number.isNaN(remindAt.getTime())) {
    return null;
  }

  const subject = String(reminder?.subject || "").trim();
  const body = String(reminder?.body || "").trim();
  if (!subject || !body) {
    return null;
  }

  return {
    subject: subject.slice(0, 255),
    body,
    remindAt,
  };
}

async function createAssistantSchedule(payload) {
  await ensureAssistantTables();

  const ownerEmployeeId = String(payload?.ownerEmployeeId || "").trim();
  const createdByEmployeeId = String(payload?.createdByEmployeeId || ownerEmployeeId).trim();
  const title = String(payload?.title || "").trim();
  const planDate = String(payload?.planDate || "").trim();
  const rawRequest = String(payload?.rawRequest || "").trim();
  const planJson = payload?.planJson && typeof payload.planJson === "object" ? payload.planJson : {};
  const reminders = Array.isArray(payload?.reminders)
    ? payload.reminders.map(normalizeReminder).filter(Boolean)
    : [];

  if (!ownerEmployeeId || !createdByEmployeeId || !title || !planDate || !rawRequest) {
    const error = new Error("ownerEmployeeId, createdByEmployeeId, title, planDate, and rawRequest are required");
    error.statusCode = 400;
    throw error;
  }

  const userResult = await pool.query(
    `SELECT users."employee_id", users."email", COALESCE(access."enabled", false) AS "assistantEnabled"
     FROM "system_users" users
     LEFT JOIN "UserAgentAccess" access
       ON access."employeeId" = users."employee_id"
      AND access."agentId" = $2
     WHERE users."employee_id" = $1
     LIMIT 1`,
    [ownerEmployeeId, ASSISTANT_AGENT_ID],
  );
  const owner = userResult.rows[0];
  if (!owner) {
    const error = new Error("Schedule owner not found");
    error.statusCode = 404;
    throw error;
  }
  if (owner.assistantEnabled !== true) {
    const error = new Error("nv_assistant is not enabled for this user");
    error.statusCode = 403;
    throw error;
  }
  if (!owner.email) {
    const error = new Error("Schedule owner does not have an email in system_users.email");
    error.statusCode = 400;
    throw error;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const scheduleResult = await client.query(
      `INSERT INTO "AssistantSchedules"
        ("ownerEmployeeId", "createdByEmployeeId", "title", "planDate", "rawRequest", "planJson", "status", "approvedAt")
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'approved', NOW())
       RETURNING *`,
      [
        ownerEmployeeId,
        createdByEmployeeId,
        title.slice(0, 255),
        planDate,
        rawRequest,
        JSON.stringify(planJson),
      ],
    );
    const schedule = scheduleResult.rows[0];
    const reminderRows = [];

    for (const reminder of reminders) {
      const reminderResult = await client.query(
        `INSERT INTO "AssistantReminderJobs"
          ("scheduleId", "ownerEmployeeId", "emailTo", "subject", "body", "remindAt")
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          schedule.id,
          ownerEmployeeId,
          owner.email,
          reminder.subject,
          reminder.body,
          reminder.remindAt.toISOString(),
        ],
      );
      reminderRows.push(reminderResult.rows[0]);
    }

    await client.query("COMMIT");
    return { schedule, reminders: reminderRows };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  ASSISTANT_AGENT_ID,
  DEFAULT_CAPABILITIES,
  createAssistantSchedule,
  ensureAssistantTables,
  getEnabledAgentIdsForEmployee,
  initializeAssistantAccessStore,
  listAssistantAccess,
  seedAssistantAccessDefaults,
  setAssistantAccess,
};
