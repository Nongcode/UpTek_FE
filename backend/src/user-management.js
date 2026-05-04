const pool = require("./database");
const { deepClone, loadOpenClawConfig, saveOpenClawConfig } = require("./openclaw-config");

const MANAGER_ROLES = new Set(["admin", "giam_doc"]);
const DISABLED_STATUS = "disabled";
const ACTIVE_STATUS = "active";

function normalizeText(value) {
  const normalized = String(value || "").trim();
  return normalized || undefined;
}

function normalizeEmail(value) {
  return normalizeText(value)?.toLowerCase();
}

function normalizeAgentId(value) {
  const normalized = normalizeText(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(normalized) ? normalized : undefined;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function serializeJsonArray(value) {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

function resolveUserDepartment(employeeId) {
  if (employeeId === "admin") return "All";
  if (employeeId === "giam_doc" || employeeId === "truong_phong") return "BanGiamDoc";
  if (employeeId === "pho_phong_cskh" || employeeId === "nv_consultant") return "PhongCSKH";
  return "PhongMarketing";
}

function buildUserAccessPolicy(user) {
  const employeeId = normalizeText(user.employeeId);
  const employeeName = normalizeText(user.employeeName);
  const lockedAgentId = normalizeAgentId(user.lockedAgentId) || normalizeAgentId(employeeId) || "main";
  const visibleAgentIds = Array.from(
    new Set([lockedAgentId, ...parseJsonArray(user.visibleAgentIds)].map(normalizeAgentId).filter(Boolean)),
  );
  const canViewAllSessions = user.canViewAllSessions === true;

  return {
    employeeId,
    employeeName,
    companyId: "UpTek",
    departmentId: resolveUserDepartment(employeeId),
    lockedAgentId,
    lockedSessionKey: `agent:${lockedAgentId}:main`,
    canViewAllSessions,
    visibleAgentIds: canViewAllSessions ? [] : visibleAgentIds,
    lockAgent: user.lockAgent !== false,
    lockSession: user.lockSession === true,
    autoConnect: user.autoConnect === true,
    enforcedByServer: true,
    role: normalizeText(user.role),
    status: normalizeText(user.status) || ACTIVE_STATUS,
  };
}

function mapDbUser(row) {
  return {
    id: row.id,
    email: row.email,
    password: row.password,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    role: row.role,
    status: row.status,
    lockedAgentId: row.locked_agent_id,
    canViewAllSessions: row.can_view_all_sessions === true,
    visibleAgentIds: parseJsonArray(row.visible_agent_ids),
    lockAgent: row.lock_agent !== false,
    lockSession: row.lock_session === true,
    autoConnect: row.auto_connect === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    disabledAt: row.disabled_at,
  };
}

async function ensureSystemUsersTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "system_users" (
      "id" VARCHAR(64) PRIMARY KEY,
      "email" VARCHAR(255) NOT NULL UNIQUE,
      "password" VARCHAR(255) NOT NULL,
      "employee_id" VARCHAR(64) NOT NULL UNIQUE,
      "employee_name" VARCHAR(255),
      "role" VARCHAR(64) NOT NULL,
      "status" VARCHAR(32) NOT NULL DEFAULT 'active',
      "locked_agent_id" VARCHAR(64) NOT NULL,
      "can_view_all_sessions" BOOLEAN NOT NULL DEFAULT false,
      "visible_agent_ids" TEXT NOT NULL DEFAULT '[]',
      "lock_agent" BOOLEAN NOT NULL DEFAULT true,
      "lock_session" BOOLEAN NOT NULL DEFAULT false,
      "auto_connect" BOOLEAN NOT NULL DEFAULT false,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "disabled_at" TIMESTAMPTZ
    );
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS "idx_system_users_role_status" ON "system_users" ("role", "status")`,
  );
}

async function seedUsersFromConfigIfNeeded() {
  const existing = await pool.query(`SELECT COUNT(*)::int AS count FROM "system_users"`);
  if ((existing.rows[0]?.count || 0) > 0) {
    return;
  }

  const config = loadOpenClawConfig();
  const directory = Array.isArray(config?.gateway?.controlUi?.employeeDirectory)
    ? config.gateway.controlUi.employeeDirectory
    : [];
  const demoAccounts = Array.isArray(config?.gateway?.controlUi?.demoLogin?.accounts)
    ? config.gateway.controlUi.demoLogin.accounts
    : [];
  const demoMap = new Map(
    demoAccounts
      .filter((account) => normalizeText(account.employeeId))
      .map((account) => [normalizeText(account.employeeId), account]),
  );

  for (const entry of directory) {
    const employeeId = normalizeText(entry.employeeId);
    if (!employeeId) continue;

    const matchedAccount = demoMap.get(employeeId);
    const canViewAllSessions = entry.canViewAllSessions === true;
    const visibleAgentIds = Array.from(
      new Set(
        [entry.lockedAgentId, ...(Array.isArray(entry.visibleAgentIds) ? entry.visibleAgentIds : [])]
          .map(normalizeAgentId)
          .filter(Boolean),
      ),
    );

    await pool.query(
      `INSERT INTO "system_users"
        ("id", "email", "password", "employee_id", "employee_name", "role", "status",
         "locked_agent_id", "can_view_all_sessions", "visible_agent_ids", "lock_agent",
         "lock_session", "auto_connect")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT ("id") DO NOTHING`,
      [
        employeeId,
        normalizeEmail(matchedAccount?.email) || `${employeeId}@uptek.ai`,
        normalizeText(matchedAccount?.password) || "1",
        employeeId,
        normalizeText(entry.employeeName) || employeeId,
        employeeId,
        ACTIVE_STATUS,
        normalizeAgentId(entry.lockedAgentId) || employeeId,
        canViewAllSessions,
        serializeJsonArray(canViewAllSessions ? [] : visibleAgentIds),
        entry.lockAgent !== false,
        entry.lockSession === true,
        entry.autoConnect === true,
      ],
    );
  }
}

async function initializeUserStore() {
  await ensureSystemUsersTable();
  await seedUsersFromConfigIfNeeded();
}

async function findUserByCredentials(email, password) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPassword = normalizeText(password);
  if (!normalizedEmail || !normalizedPassword) {
    return null;
  }

  const result = await pool.query(
    `SELECT * FROM "system_users"
     WHERE "email" = $1
       AND "password" = $2
     LIMIT 1`,
    [normalizedEmail, normalizedPassword],
  );

  const user = result.rows[0] ? mapDbUser(result.rows[0]) : null;
  if (!user || user.status === DISABLED_STATUS) {
    return null;
  }
  return user;
}

async function getLoginAttemptResult(email, password) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPassword = normalizeText(password);
  if (!normalizedEmail || !normalizedPassword) {
    return { ok: false, reason: "invalid_credentials" };
  }

  const result = await pool.query(
    `SELECT * FROM "system_users"
     WHERE "email" = $1
       AND "password" = $2
     LIMIT 1`,
    [normalizedEmail, normalizedPassword],
  );

  const user = result.rows[0] ? mapDbUser(result.rows[0]) : null;
  if (!user) {
    return { ok: false, reason: "invalid_credentials" };
  }
  if (user.status === DISABLED_STATUS) {
    return { ok: false, reason: "blocked", user };
  }
  return { ok: true, user };
}

async function listUsers() {
  const result = await pool.query(
    `SELECT * FROM "system_users"
     ORDER BY CASE WHEN "role" IN ('admin', 'giam_doc') THEN 0 ELSE 1 END, "employee_name" ASC, "email" ASC`,
  );
  return result.rows.map(mapDbUser);
}

async function findUserById(userId) {
  const result = await pool.query(`SELECT * FROM "system_users" WHERE "id" = $1 LIMIT 1`, [userId]);
  return result.rows[0] ? mapDbUser(result.rows[0]) : null;
}

function canManageUsers(auth) {
  return MANAGER_ROLES.has(normalizeText(auth?.employeeId) || "");
}

function assertManagerCanMutate(auth, targetUser, action) {
  const actorId = normalizeText(auth?.employeeId);
  const targetRole = normalizeText(targetUser?.role);
  const targetId = normalizeText(targetUser?.employeeId);

  if (!canManageUsers(auth)) {
    const error = new Error("Forbidden");
    error.statusCode = 403;
    throw error;
  }

  if (!targetUser) {
    const error = new Error("User not found");
    error.statusCode = 404;
    throw error;
  }

  if (actorId === targetId) {
    const error = new Error(`Không được ${action} tài khoản đang đăng nhập`);
    error.statusCode = 400;
    throw error;
  }

  if (actorId === "giam_doc" && targetRole === "admin") {
    const error = new Error("Giám đốc không được thao tác tài khoản admin");
    error.statusCode = 403;
    throw error;
  }
}

function syncConfigUsers(users) {
  const config = deepClone(loadOpenClawConfig() || {}) || {};
  const nextUsers = users.filter((user) => user.status !== DISABLED_STATUS);

  const employeeDirectory = nextUsers.map((user) => ({
    employeeId: user.employeeId,
    employeeName: user.employeeName,
    canViewAllSessions: user.canViewAllSessions === true,
    lockedAgentId: user.lockedAgentId,
    visibleAgentIds: user.canViewAllSessions ? [] : user.visibleAgentIds,
    lockAgent: user.lockAgent !== false,
    lockSession: user.lockSession === true,
    autoConnect: user.autoConnect === true,
  }));

  const demoAccounts = nextUsers.map((user) => ({
    email: user.email,
    label: user.employeeName,
    password: user.password,
    employeeId: user.employeeId,
  }));

  config.gateway = config.gateway || {};
  config.gateway.controlUi = config.gateway.controlUi || {};
  config.gateway.controlUi.employeeDirectory = employeeDirectory;
  config.gateway.controlUi.demoLogin = {
    ...(config.gateway.controlUi.demoLogin || {}),
    enabled: true,
    accounts: demoAccounts,
  };

  saveOpenClawConfig(config);
}

async function syncUsersToConfig() {
  const users = await listUsers();
  syncConfigUsers(users);
}

async function updateUserStatus(userId, status, auth) {
  const target = await findUserById(userId);
  assertManagerCanMutate(auth, target, status === DISABLED_STATUS ? "tat" : "mo lai");

  const nextStatus = status === DISABLED_STATUS ? DISABLED_STATUS : ACTIVE_STATUS;
  const disabledAt = nextStatus === DISABLED_STATUS ? new Date() : null;
  const result = await pool.query(
    `UPDATE "system_users"
     SET "status" = $1,
         "disabled_at" = $2,
         "updated_at" = NOW()
     WHERE "id" = $3
     RETURNING *`,
    [nextStatus, disabledAt, userId],
  );
  await syncUsersToConfig();
  return mapDbUser(result.rows[0]);
}

async function deleteUser(userId, auth) {
  const target = await findUserById(userId);
  assertManagerCanMutate(auth, target, "xoa");

  await pool.query(`DELETE FROM "system_users" WHERE "id" = $1`, [userId]);
  await syncUsersToConfig();
}

module.exports = {
  ACTIVE_STATUS,
  DISABLED_STATUS,
  buildUserAccessPolicy,
  canManageUsers,
  deleteUser,
  findUserByCredentials,
  findUserById,
  getLoginAttemptResult,
  initializeUserStore,
  listUsers,
  syncUsersToConfig,
  updateUserStatus,
};

