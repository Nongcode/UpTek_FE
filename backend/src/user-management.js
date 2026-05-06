const pool = require("./database");
const { initializeAssistantAccessStore } = require("./assistant-access");
const { deepClone, loadOpenClawConfig, saveOpenClawConfig } = require("./openclaw-config");

const MANAGER_ROLES = new Set(["admin", "giam_doc"]);
const DISABLED_STATUS = "disabled";
const ACTIVE_STATUS = "active";
const PHO_PHONG_REQUIRED_VISIBLE_AGENTS = ["nv_content", "nv_media", "nv_prompt"];
const PHO_PHONG_C_EMPLOYEE_ID = "pho_phong_c";
const CSKH_MANAGER_AGENT_ID = "pho_phong_cskh";
const CSKH_MANAGER_REQUIRED_VISIBLE_AGENTS = ["nv_consultant"];
const DEFAULT_ASSISTANT_USER = {
  id: "nv_assistant",
  email: "nv_assistant@uptek.ai",
  password: "100904",
  employeeId: "nv_assistant",
  employeeName: "Trợ lý kinh doanh AI",
  role: "nv_assistant",
  lockedAgentId: "nv_assistant",
  visibleAgentIds: ["nv_assistant"],
};

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
  const normalizedAlias = normalized === "nv_promt" ? "nv_prompt" : normalized;
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(normalizedAlias) ? normalizedAlias : undefined;
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

function dedupeAgentIds(value) {
  return Array.from(new Set((Array.isArray(value) ? value : []).map(normalizeAgentId).filter(Boolean)));
}

function isPhoPhongManager(user) {
  return normalizeAgentId(user?.lockedAgentId) === "pho_phong" || normalizeAgentId(user?.employeeId) === "pho_phong";
}

function isCskhManager(user) {
  return (
    normalizeAgentId(user?.lockedAgentId) === CSKH_MANAGER_AGENT_ID ||
    normalizeAgentId(user?.employeeId) === CSKH_MANAGER_AGENT_ID
  );
}

function getRequiredVisibleAgentIdsForUser(user) {
  if (isCskhManager(user)) {
    return CSKH_MANAGER_REQUIRED_VISIBLE_AGENTS;
  }
  return isPhoPhongManager(user) ? PHO_PHONG_REQUIRED_VISIBLE_AGENTS : [];
}

function resolveVisibleAgentIdsForUser(user, visibleAgentIds) {
  return dedupeAgentIds([
    user?.lockedAgentId,
    ...getRequiredVisibleAgentIdsForUser(user),
    ...(Array.isArray(visibleAgentIds) ? visibleAgentIds : []),
  ]);
}

function resolveUserDepartment(employeeId) {
  if (employeeId === "admin") return "All";
  if (employeeId === "giam_doc" || employeeId === "truong_phong") return "BanGiamDoc";
  if (employeeId === "pho_phong_cskh" || employeeId === "nv_consultant") return "PhongCSKH";
  return "PhongMarketing";
}

function resolveUserManagerInstanceId(employeeId) {
  if (employeeId === "pho_phong_a") return "mgr_pho_phong_A";
  if (employeeId === "pho_phong_b") return "mgr_pho_phong_B";
  if (employeeId === "pho_phong_c") return "mgr_pho_phong_C";
  return undefined;
}

function buildUserAccessPolicy(user) {
  const employeeId = normalizeText(user.employeeId);
  const employeeName = normalizeText(user.employeeName);
  const lockedAgentId = normalizeAgentId(user.lockedAgentId) || normalizeAgentId(employeeId) || "main";
  const visibleAgentIds = resolveVisibleAgentIdsForUser(
    { ...user, lockedAgentId, employeeId },
    parseJsonArray(user.visibleAgentIds),
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
    const visibleAgentIds = resolveVisibleAgentIdsForUser(
      { lockedAgentId: entry.lockedAgentId, employeeId },
      Array.isArray(entry.visibleAgentIds) ? entry.visibleAgentIds : [],
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

async function ensureDefaultAssistantUser() {
  await pool.query(
    `INSERT INTO "system_users"
      ("id", "email", "password", "employee_id", "employee_name", "role", "status",
       "locked_agent_id", "can_view_all_sessions", "visible_agent_ids", "lock_agent",
       "lock_session", "auto_connect")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, true, false, false)
     ON CONFLICT ("id") DO UPDATE SET
       "email" = EXCLUDED."email",
       "employee_name" = EXCLUDED."employee_name",
       "role" = EXCLUDED."role",
       "locked_agent_id" = EXCLUDED."locked_agent_id",
       "visible_agent_ids" = EXCLUDED."visible_agent_ids",
       "updated_at" = NOW()`,
    [
      DEFAULT_ASSISTANT_USER.id,
      DEFAULT_ASSISTANT_USER.email,
      DEFAULT_ASSISTANT_USER.password,
      DEFAULT_ASSISTANT_USER.employeeId,
      DEFAULT_ASSISTANT_USER.employeeName,
      DEFAULT_ASSISTANT_USER.role,
      ACTIVE_STATUS,
      DEFAULT_ASSISTANT_USER.lockedAgentId,
      serializeJsonArray(resolveVisibleAgentIdsForUser(DEFAULT_ASSISTANT_USER, DEFAULT_ASSISTANT_USER.visibleAgentIds)),
    ],
  );
}

async function ensureCskhManagerUser() {
  const existing = await findUserByEmployeeId(CSKH_MANAGER_AGENT_ID);
  if (!existing) {
    await pool.query(
      `INSERT INTO "system_users"
        ("id", "email", "password", "employee_id", "employee_name", "role", "status",
         "locked_agent_id", "can_view_all_sessions", "visible_agent_ids", "lock_agent",
         "lock_session", "auto_connect")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, true, false, false)
       ON CONFLICT ("id") DO NOTHING`,
      [
        CSKH_MANAGER_AGENT_ID,
        "pho_phong_cskh@uptek.ai",
        "100904",
        CSKH_MANAGER_AGENT_ID,
        "Phó phòng CSKH",
        CSKH_MANAGER_AGENT_ID,
        ACTIVE_STATUS,
        CSKH_MANAGER_AGENT_ID,
        serializeJsonArray(resolveVisibleAgentIdsForUser(
          { employeeId: CSKH_MANAGER_AGENT_ID, lockedAgentId: CSKH_MANAGER_AGENT_ID },
          CSKH_MANAGER_REQUIRED_VISIBLE_AGENTS,
        )),
      ],
    );
    return;
  }

  const inheritedPhoPhongAgents = new Set(["pho_phong", ...PHO_PHONG_REQUIRED_VISIBLE_AGENTS]);
  const preservedExtraAgentIds = (existing.visibleAgentIds || []).filter(
    (agentId) => !inheritedPhoPhongAgents.has(normalizeAgentId(agentId)),
  );
  const nextVisibleAgentIds = resolveVisibleAgentIdsForUser(
    { ...existing, employeeId: CSKH_MANAGER_AGENT_ID, lockedAgentId: CSKH_MANAGER_AGENT_ID },
    preservedExtraAgentIds,
  );

  await pool.query(
    `UPDATE "system_users"
     SET "locked_agent_id" = $1,
         "visible_agent_ids" = $2,
         "updated_at" = NOW()
     WHERE "employee_id" = $3`,
    [CSKH_MANAGER_AGENT_ID, serializeJsonArray(nextVisibleAgentIds), CSKH_MANAGER_AGENT_ID],
  );
}

async function ensurePhoPhongCUser() {
  const existing = await findUserByEmployeeId(PHO_PHONG_C_EMPLOYEE_ID);
  const defaultVisibleAgentIds = resolveVisibleAgentIdsForUser(
    { employeeId: PHO_PHONG_C_EMPLOYEE_ID, lockedAgentId: "pho_phong" },
    [],
  );

  if (!existing) {
    await pool.query(
      `INSERT INTO "system_users"
        ("id", "email", "password", "employee_id", "employee_name", "role", "status",
         "locked_agent_id", "can_view_all_sessions", "visible_agent_ids", "lock_agent",
         "lock_session", "auto_connect")
       VALUES ($1, $2, $3, $1, $4, $1, 'active', 'pho_phong', false, $5, true, false, true)
       ON CONFLICT ("id") DO NOTHING`,
      [
        PHO_PHONG_C_EMPLOYEE_ID,
        "pho_phong_c@uptek.ai",
        "1",
        "Phó Phòng C KD2",
        serializeJsonArray(defaultVisibleAgentIds),
      ],
    );
    return;
  }

  await pool.query(
    `UPDATE "system_users"
     SET "employee_name" = $1,
         "locked_agent_id" = 'pho_phong',
         "visible_agent_ids" = $2,
         "auto_connect" = true,
         "updated_at" = NOW()
     WHERE "employee_id" = $3`,
    [
      "Phó Phòng C KD2",
      serializeJsonArray(resolveVisibleAgentIdsForUser(
        { ...existing, employeeId: PHO_PHONG_C_EMPLOYEE_ID, lockedAgentId: "pho_phong" },
        existing.visibleAgentIds || [],
      )),
      PHO_PHONG_C_EMPLOYEE_ID,
    ],
  );
}

async function initializeUserStore() {
  await ensureSystemUsersTable();
  await seedUsersFromConfigIfNeeded();
  await ensurePhoPhongCUser();
  await ensureCskhManagerUser();
  await ensureDefaultAssistantUser();
  await initializeAssistantAccessStore();
  await syncUsersToConfig();
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

async function findUserByEmployeeId(employeeId) {
  const normalizedEmployeeId = normalizeText(employeeId);
  if (!normalizedEmployeeId) {
    return null;
  }

  const result = await pool.query(
    `SELECT * FROM "system_users" WHERE "employee_id" = $1 LIMIT 1`,
    [normalizedEmployeeId],
  );
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
    ...(resolveUserManagerInstanceId(user.employeeId) ? { managerInstanceId: resolveUserManagerInstanceId(user.employeeId) } : {}),
    canViewAllSessions: user.canViewAllSessions === true,
    lockedAgentId: user.lockedAgentId,
    visibleAgentIds: user.canViewAllSessions ? [] : resolveVisibleAgentIdsForUser(user, user.visibleAgentIds),
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

  ensureCskhManagerAgentConfig(config);

  saveOpenClawConfig(config);
}

function resolveSiblingWorkspace(config, sourceWorkspace, targetName) {
  const normalizedSource = normalizeText(sourceWorkspace);
  if (normalizedSource) {
    return normalizedSource.replace(/workspace_phophong$/i, targetName).replace(/workspace$/i, targetName);
  }

  const defaultWorkspace = normalizeText(config?.agents?.defaults?.workspace);
  if (defaultWorkspace) {
    return defaultWorkspace.replace(/workspace$/i, targetName);
  }

  return `C:\\Users\\PHAMDUCLONG\\.openclaw\\${targetName}`;
}

function ensureCskhManagerAgentConfig(config) {
  config.agents = config.agents || {};
  config.agents.list = Array.isArray(config.agents.list) ? config.agents.list : [];

  const agentList = config.agents.list;
  const existingAgent = agentList.find((agent) => normalizeAgentId(agent?.id) === CSKH_MANAGER_AGENT_ID);
  const phoPhongAgent = agentList.find((agent) => normalizeAgentId(agent?.id) === "pho_phong");
  const baseAgent = existingAgent || {};
  const allowAgents = Array.from(new Set([
    ...((Array.isArray(baseAgent.subagents?.allowAgents) ? baseAgent.subagents.allowAgents : [])),
    ...CSKH_MANAGER_REQUIRED_VISIBLE_AGENTS,
  ].map(normalizeAgentId).filter(Boolean)));

  const nextAgent = {
    ...baseAgent,
    id: CSKH_MANAGER_AGENT_ID,
    name: baseAgent.name || "Phó phòng CSKH",
    workspace: baseAgent.workspace || resolveSiblingWorkspace(config, phoPhongAgent?.workspace, "workspace_phophong_cskh"),
    model: baseAgent.model || phoPhongAgent?.model || config.agents.defaults?.model?.primary || "openai-codex/gpt-5.4",
    skills: Array.isArray(baseAgent.skills) && baseAgent.skills.length > 0
      ? baseAgent.skills
      : ["agent-orchestrator", "search-product-text"],
    identity: {
      ...(baseAgent.identity || {}),
      name: baseAgent.identity?.name || "Phó phòng CSKH UpTek",
    },
    subagents: {
      ...(baseAgent.subagents || {}),
      allowAgents,
    },
    tools: {
      profile: "full",
      ...(baseAgent.tools || {}),
    },
  };

  if (existingAgent) {
    Object.assign(existingAgent, nextAgent);
    return;
  }

  const phoPhongIndex = agentList.findIndex((agent) => normalizeAgentId(agent?.id) === "pho_phong");
  if (phoPhongIndex >= 0) {
    agentList.splice(phoPhongIndex + 1, 0, nextAgent);
  } else {
    agentList.push(nextAgent);
  }
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

async function addVisibleAgentToUser(userId, agentId, auth) {
  const target = await findUserById(userId);
  assertManagerCanMutate(auth, target, "cap quyen agent cho");

  const normalizedAgentId = normalizeAgentId(agentId);
  if (!normalizedAgentId) {
    const error = new Error("Invalid agentId");
    error.statusCode = 400;
    throw error;
  }

  const agentResult = await pool.query(
    `SELECT "employee_id"
     FROM "system_users"
     WHERE "employee_id" = $1
        OR "locked_agent_id" = $1
     LIMIT 1`,
    [normalizedAgentId],
  );
  if (!agentResult.rows[0]) {
    const error = new Error("Agent not found");
    error.statusCode = 404;
    throw error;
  }

  const nextVisibleAgentIds = resolveVisibleAgentIdsForUser(target, [
    ...(target.visibleAgentIds || []),
    normalizedAgentId,
  ]);

  const result = await pool.query(
    `UPDATE "system_users"
     SET "visible_agent_ids" = $1,
         "updated_at" = NOW()
     WHERE "id" = $2
     RETURNING *`,
    [serializeJsonArray(nextVisibleAgentIds), userId],
  );
  await syncUsersToConfig();
  return mapDbUser(result.rows[0]);
}

async function removeVisibleAgentFromUser(userId, agentId, auth) {
  const target = await findUserById(userId);
  assertManagerCanMutate(auth, target, "go quyen agent cua");

  const normalizedAgentId = normalizeAgentId(agentId);
  if (!normalizedAgentId) {
    const error = new Error("Invalid agentId");
    error.statusCode = 400;
    throw error;
  }

  const lockedAgentId = normalizeAgentId(target.lockedAgentId);
  if (normalizedAgentId === lockedAgentId) {
    const error = new Error("Cannot remove the manager's primary agent");
    error.statusCode = 400;
    throw error;
  }

  if (getRequiredVisibleAgentIdsForUser(target).includes(normalizedAgentId)) {
    const error = new Error("Cannot remove default manager workers");
    error.statusCode = 400;
    throw error;
  }

  const nextVisibleAgentIds = resolveVisibleAgentIdsForUser(
    target,
    (target.visibleAgentIds || []).filter((item) => normalizeAgentId(item) !== normalizedAgentId),
  );

  const result = await pool.query(
    `UPDATE "system_users"
     SET "visible_agent_ids" = $1,
         "updated_at" = NOW()
     WHERE "id" = $2
     RETURNING *`,
    [serializeJsonArray(nextVisibleAgentIds), userId],
  );
  await syncUsersToConfig();
  return mapDbUser(result.rows[0]);
}

module.exports = {
  ACTIVE_STATUS,
  DISABLED_STATUS,
  addVisibleAgentToUser,
  buildUserAccessPolicy,
  canManageUsers,
  deleteUser,
  findUserByCredentials,
  findUserByEmployeeId,
  findUserById,
  getLoginAttemptResult,
  initializeUserStore,
  listUsers,
  removeVisibleAgentFromUser,
  syncUsersToConfig,
  updateUserStatus,
};
