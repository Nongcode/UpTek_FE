const pool = require("./database");

/** ID instance mặc định — toàn bộ luồng cũ map vào đây */
const DEFAULT_MANAGER_INSTANCE_ID = "mgr_pho_phong_A";

/**
 * Map từ baseAgentKey → managerInstanceId active mặc định.
 * Dùng để resolve khi runtime nhận agentId = "pho_phong" mà không có instanceId.
 */
const BASE_AGENT_DEFAULT_INSTANCE = {
  pho_phong: DEFAULT_MANAGER_INSTANCE_ID,
};

/**
 * Lấy thông tin một manager instance theo ID.
 * @param {string} instanceId
 * @returns {Promise<object|null>}
 */
async function getManagerInstance(instanceId) {
  if (!instanceId) return null;
  const result = await pool.query(
    `SELECT * FROM "manager_instances" WHERE "id" = $1 LIMIT 1`,
    [instanceId],
  );
  return result.rows[0] || null;
}

/**
 * Lấy danh sách tất cả manager instances.
 * @returns {Promise<object[]>}
 */
async function listManagerInstances() {
  const result = await pool.query(
    `SELECT * FROM "manager_instances" ORDER BY "status" ASC, "id" ASC`,
  );
  return result.rows;
}

/**
 * Lấy danh sách worker agent IDs được bind với một manager instance.
 * Đây là lõi của GP3: thay vì callWorker("nv_content") hardcode,
 * manager lấy workers từ binding table.
 *
 * @param {string} managerInstanceId
 * @returns {Promise<string[]>} Danh sách workerAgentId
 */
async function getWorkersForManager(managerInstanceId) {
  const id = managerInstanceId || DEFAULT_MANAGER_INSTANCE_ID;
  const result = await pool.query(
    `SELECT "workerAgentId"
     FROM "manager_worker_bindings"
     WHERE "managerInstanceId" = $1
     ORDER BY "workerAgentId" ASC`,
    [id],
  );
  return result.rows.map((row) => row.workerAgentId);
}

/**
 * Resolve managerInstanceId từ baseAgentKey (agentId cũ như "pho_phong").
 * Trả về instance active đầu tiên tương ứng với baseAgentKey đó.
 *
 * Dùng để gỡ hardcode: thay vì `if (agent === "pho_phong")`,
 * runtime gọi `resolveManagerInstanceId("pho_phong")` → "mgr_pho_phong_A"
 *
 * @param {string} agentId  — ví dụ: "pho_phong"
 * @returns {Promise<string>} managerInstanceId
 */
async function resolveManagerInstanceId(agentId) {
  // Nếu agentId đã là instanceId hợp lệ (bắt đầu bằng "mgr_"), trả về luôn
  if (typeof agentId === "string" && agentId.startsWith("mgr_")) {
    return agentId;
  }

  // Thử lookup từ DB theo baseAgentKey
  if (agentId) {
    const result = await pool.query(
      `SELECT "id" FROM "manager_instances"
       WHERE "baseAgentKey" = $1 AND "status" = 'active'
       ORDER BY "id" ASC
       LIMIT 1`,
      [String(agentId).toLowerCase().trim()],
    );
    if (result.rows[0]) {
      return result.rows[0].id;
    }
  }

  // Fallback: dùng hardmap rồi default
  return BASE_AGENT_DEFAULT_INSTANCE[agentId] || DEFAULT_MANAGER_INSTANCE_ID;
}

/**
 * Kiểm tra một agentId có phải là manager agent không.
 * Dùng để thay thế `if (agent === "pho_phong")` trong runtime.
 *
 * @param {string} agentId
 * @returns {Promise<boolean>}
 */
async function isManagerAgent(agentId) {
  if (!agentId) return false;
  const normalized = String(agentId).toLowerCase().trim();

  // Nếu là instanceId thì check trực tiếp
  if (normalized.startsWith("mgr_")) {
    const row = await getManagerInstance(normalized);
    return row !== null;
  }

  // Nếu là baseAgentKey thì check xem có instance nào không
  const result = await pool.query(
    `SELECT 1 FROM "manager_instances" WHERE "baseAgentKey" = $1 LIMIT 1`,
    [normalized],
  );
  return result.rows.length > 0;
}

/**
 * Validate managerInstanceId: tồn tại + status cho phép (active hoặc experimental).
 * experimental được phép dùng cho test conversations.
 *
 * @param {string} instanceId
 * @returns {Promise<{valid: boolean, instance: object|null, reason: string|null}>}
 */
async function validateManagerInstanceId(instanceId) {
  if (!instanceId) {
    return { valid: false, instance: null, reason: "managerInstanceId is required" };
  }
  const instance = await getManagerInstance(instanceId);
  if (!instance) {
    return { valid: false, instance: null, reason: `Manager instance "${instanceId}" not found` };
  }
  if (instance.status === "disabled") {
    return { valid: false, instance, reason: `Manager instance "${instanceId}" is disabled` };
  }
  return { valid: true, instance, reason: null };
}

module.exports = {
  DEFAULT_MANAGER_INSTANCE_ID,
  getManagerInstance,
  getWorkersForManager,
  isManagerAgent,
  listManagerInstances,
  resolveManagerInstanceId,
  validateManagerInstanceId,
};
