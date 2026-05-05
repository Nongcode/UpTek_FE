const {
  DEFAULT_MANAGER_INSTANCE_ID,
  validateManagerInstanceId,
} = require("./manager-instances");

/**
 * GP3 Manager Router
 *
 * Chọn managerInstanceId phù hợp khi tạo conversation mới.
 * Một khi conversation đã được tạo với managerInstanceId nào,
 * instanceId đó phải giữ cố định suốt vòng đời conversation.
 *
 * Thứ tự ưu tiên:
 *  1. explicit managerInstanceId từ request (createConversation({ managerInstanceId: "..." }))
 *  2. feature flag theo workspaceId
 *  3. feature flag theo accountId / employeeId
 *  4. DEFAULT_MANAGER_INSTANCE_ID ("mgr_pho_phong_A")
 */

/**
 * Feature flag rules — dạng đơn giản, có thể mở rộng sang DB/config sau.
 * Mỗi entry: { workspaceId?, employeeId?, managerInstanceId }
 *
 * Ví dụ kích hoạt mgr_pho_phong_B cho một số account test:
 *   { employeeId: "test_user_01", managerInstanceId: "mgr_pho_phong_B" }
 */
const FEATURE_FLAG_RULES = [
  // Thêm rules ở đây khi cần route account/workspace sang instance cụ thể.
  // Ví dụ:
  // { employeeId: "pho_phong_test", managerInstanceId: "mgr_pho_phong_B" },
  // { workspaceId: "ws_test_001",   managerInstanceId: "mgr_pho_phong_B" },
];

/**
 * Resolve managerInstanceId cho một conversation mới.
 *
 * @param {object} params
 * @param {string} [params.managerInstanceId]  — explicit request từ client
 * @param {string} [params.employeeId]         — employeeId của user tạo conversation
 * @param {string} [params.workspaceId]        — workspaceId (nếu có)
 * @param {string} [params.agentId]            — agentId base (ví dụ: "pho_phong")
 * @returns {Promise<string>}  managerInstanceId đã resolve
 */
async function resolveManagerForConversation(params = {}) {
  const { managerInstanceId, employeeId, workspaceId } = params;

  // 1. Explicit instanceId từ request — ưu tiên cao nhất
  if (managerInstanceId) {
    const { valid, reason } = await validateManagerInstanceId(managerInstanceId);
    if (valid) {
      return managerInstanceId;
    }
    // Instance không hợp lệ → log và fallthrough
    console.warn(`[manager-router] Invalid managerInstanceId "${managerInstanceId}": ${reason}. Falling back to default.`);
  }

  // 2. Feature flag theo workspaceId
  if (workspaceId) {
    const wsRule = FEATURE_FLAG_RULES.find((rule) => rule.workspaceId === workspaceId);
    if (wsRule) {
      const { valid } = await validateManagerInstanceId(wsRule.managerInstanceId);
      if (valid) return wsRule.managerInstanceId;
    }
  }

  // 3. Feature flag theo employeeId
  if (employeeId) {
    const empRule = FEATURE_FLAG_RULES.find((rule) => rule.employeeId === employeeId);
    if (empRule) {
      const { valid } = await validateManagerInstanceId(empRule.managerInstanceId);
      if (valid) return empRule.managerInstanceId;
    }
  }

  // 4. Default instance
  return DEFAULT_MANAGER_INSTANCE_ID;
}

/**
 * Thêm một feature flag rule mới vào runtime (không persist).
 * Dùng cho testing hoặc hot-config.
 *
 * @param {{ workspaceId?: string, employeeId?: string, managerInstanceId: string }} rule
 */
function addFeatureFlagRule(rule) {
  if (!rule?.managerInstanceId) {
    throw new Error("managerInstanceId is required in feature flag rule");
  }
  FEATURE_FLAG_RULES.push(rule);
}

/**
 * Lấy danh sách feature flag rules hiện tại (readonly snapshot).
 * @returns {object[]}
 */
function getFeatureFlagRules() {
  return [...FEATURE_FLAG_RULES];
}

module.exports = {
  addFeatureFlagRule,
  getFeatureFlagRules,
  resolveManagerForConversation,
};
