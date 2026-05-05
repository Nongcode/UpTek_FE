import React, { useEffect, useMemo, useState } from "react";
import { loadAllConversationsGlobally } from "@/lib/storage";
import { deleteUser, fetchUsers, updateUserStatus } from "@/lib/api";
import { SystemUser, UserStatsSummary } from "@/lib/types";

const EMPTY_USER_STATS: UserStatsSummary = {
  total: 0,
  active: 0,
  disabled: 0,
  byRole: {},
};

type UserGroup = {
  id: string;
  label: string;
  description: string;
  users: SystemUser[];
};

type ManagerDetail = {
  manager: SystemUser;
  subordinates: SystemUser[];
};

const USER_GROUP_ORDER = [
  "system-admin",
  "back-office",
  "sales-1",
  "sales-2",
  "customer-service",
  "other",
] as const;

function normalizeKeyword(value: string | null | undefined) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function resolveSalesDepartment(normalizedText: string) {
  if (
    /\bkd[\s_-]*1\b/.test(normalizedText)
    || /\bkinh doanh[\s_-]*1\b/.test(normalizedText)
    || /\btruong[_\s-]*phong\b/.test(normalizedText)
    || /\bpho[_\s-]*phong\b/.test(normalizedText)
    || /\btruong[_\s-]*phong[_\s-]*kd[\s_-]*1\b/.test(normalizedText)
    || /\bpho[_\s-]*phong[_\s-]*1\b/.test(normalizedText)
    || /\bpho[_\s-]*phong[_\s-]*2\b/.test(normalizedText)
  ) {
    return "sales-1";
  }

  if (
    /\bkd[\s_-]*2\b/.test(normalizedText)
    || /\bkinh doanh[\s_-]*2\b/.test(normalizedText)
    || /\btruong[_\s-]*phong[_\s-]*kd[\s_-]*2\b/.test(normalizedText)
    || /\bpho[_\s-]*phong[_\s-]*3\b/.test(normalizedText)
    || /\bpho[_\s-]*phong[_\s-]*4\b/.test(normalizedText)
  ) {
    return "sales-2";
  }

  return "";
}

function resolveUserGroupMeta(user: SystemUser) {
  const joined = normalizeKeyword(
    [user.employeeId, user.employeeName, user.role, user.lockedAgentId].filter(Boolean).join(" "),
  );

  if (
    /\badmin\b/.test(joined)
    || /\bgiam[_\s-]*doc\b/.test(joined)
    || /\bmain\b/.test(joined)
  ) {
    return {
      id: "system-admin",
      label: "Quản trị hệ thống",
      description: "Tài khoản quản trị, giám đốc và vận hành cấp hệ thống.",
    };
  }

  if (
    /\bnv_/.test(joined)
    || /\bnv[\s_-]*(content|media|prompt)\b/.test(joined)
    || /\bmedia[_\s-]*video\b/.test(joined)
    || /\bback[\s_-]*office\b/.test(joined)
  ) {
    return {
      id: "back-office",
      label: "Back_office",
      description: "Nhóm tài khoản vận hành nội bộ như nv_content, nv_media, nv_prompt.",
    };
  }

  const salesDepartment = resolveSalesDepartment(joined);
  if (salesDepartment === "sales-1") {
    return {
      id: "sales-1",
      label: "Phòng Kinh doanh 1",
      description: "Trưởng phòng KD1, các phó phòng liên quan và tài khoản cùng cụm bán hàng 1.",
    };
  }
  if (salesDepartment === "sales-2") {
    return {
      id: "sales-2",
      label: "Phòng Kinh doanh 2",
      description: "Trưởng phòng KD2, các phó phòng liên quan và tài khoản cùng cụm bán hàng 2.",
    };
  }

  if (/\bcskh\b/.test(joined) || /\bnv[_\s-]*consultant\b/.test(joined)) {
    return {
      id: "customer-service",
      label: "Phòng CSKH",
      description: "Các tài khoản chăm sóc khách hàng và tư vấn.",
    };
  }

  return {
    id: "other",
    label: "Nhóm khác",
    description: "Các tài khoản chưa khớp quy tắc nhóm, cần kiểm tra hoặc gán bổ sung.",
  };
}

function groupUsers(users: SystemUser[]): UserGroup[] {
  const grouped = new Map<string, UserGroup>();

  for (const user of users) {
    const meta = resolveUserGroupMeta(user);
    if (!grouped.has(meta.id)) {
      grouped.set(meta.id, {
        id: meta.id,
        label: meta.label,
        description: meta.description,
        users: [],
      });
    }
    grouped.get(meta.id)?.users.push(user);
  }

  return [...grouped.values()]
    .sort((left, right) => {
      const leftIndex = USER_GROUP_ORDER.indexOf(left.id as (typeof USER_GROUP_ORDER)[number]);
      const rightIndex = USER_GROUP_ORDER.indexOf(right.id as (typeof USER_GROUP_ORDER)[number]);
      const normalizedLeft = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
      const normalizedRight = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
      return normalizedLeft - normalizedRight || left.label.localeCompare(right.label, "vi");
    })
    .map((group) => ({
      ...group,
      users: [...group.users].sort((left, right) =>
        left.employeeName.localeCompare(right.employeeName, "vi")
        || left.email.localeCompare(right.email, "vi"),
      ),
    }));
}

function isElevatedManager(user: SystemUser) {
  const joined = normalizeKeyword(
    [user.employeeId, user.employeeName, user.role, user.lockedAgentId].filter(Boolean).join(" "),
  );

  return (
    /\badmin\b/.test(joined)
    || /\bgiam[_\s-]*doc\b/.test(joined)
    || /\btruong[_\s-]*phong\b/.test(joined)
    || /\bpho[_\s-]*phong\b/.test(joined)
    || /\bmain\b/.test(joined)
  );
}

function resolveManagerSubordinates(manager: SystemUser, users: SystemUser[]) {
  const managerKey = normalizeKeyword(manager.employeeId);
  const managerRoleKey = normalizeKeyword(manager.role);
  const visibleIds = new Set(
    [manager.lockedAgentId, ...(manager.visibleAgentIds || [])]
      .map((item) => normalizeKeyword(item))
      .filter(Boolean),
  );

  return users.filter((user) => {
    if (user.id === manager.id) return false;

    const userEmployeeId = normalizeKeyword(user.employeeId);
    const userRole = normalizeKeyword(user.role);
    const userAgentId = normalizeKeyword(user.lockedAgentId);

    if (manager.canViewAllSessions) {
      if (managerKey === "admin" || managerRoleKey === "admin") {
        return true;
      }
      if (managerKey === "giam_doc" || managerRoleKey === "giam_doc") {
        return userEmployeeId !== "admin" && userRole !== "admin";
      }
    }

    return visibleIds.has(userEmployeeId) || visibleIds.has(userRole) || visibleIds.has(userAgentId);
  });
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="action-icon">
      <path
        d="M2 12C3.9 8.4 7.4 6 12 6C16.6 6 20.1 8.4 22 12C20.1 15.6 16.6 18 12 18C7.4 18 3.9 15.6 2 12Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

export default function DashboardArea({ backendToken }: { backendToken: string | null }) {
  const [conversationStats, setConversationStats] = useState({
    totalChats: 0,
    totalMessages: 0,
    activeAgents: 0,
    agentBreakdown: {} as Record<string, number>,
  });
  const [users, setUsers] = useState<SystemUser[]>([]);
  const [userStats, setUserStats] = useState<UserStatsSummary>(EMPTY_USER_STATS);
  const [isUsersLoading, setIsUsersLoading] = useState(false);
  const [userActionError, setUserActionError] = useState<string | null>(null);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [selectedManagerId, setSelectedManagerId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function loadData() {
      if (!backendToken) return;
      const allConvs = await loadAllConversationsGlobally({ backendToken });
      if (!mounted) return;

      let msgsCount = 0;
      const agentsCount: Record<string, number> = {};

      allConvs.forEach((conversation) => {
        msgsCount += conversation.messages?.length || 0;
        if (!agentsCount[conversation.agentId]) {
          agentsCount[conversation.agentId] = 0;
        }
        agentsCount[conversation.agentId]++;
      });

      setConversationStats({
        totalChats: allConvs.length,
        totalMessages: msgsCount,
        activeAgents: Object.keys(agentsCount).length,
        agentBreakdown: agentsCount,
      });
    }

    void loadData();

    return () => {
      mounted = false;
    };
  }, [backendToken]);

  useEffect(() => {
    let mounted = true;

    async function loadUsers() {
      if (!backendToken) return;
      setIsUsersLoading(true);
      setUserActionError(null);
      try {
        const result = await fetchUsers(backendToken);
        if (!mounted) return;
        setUsers(result.users);
        setUserStats(result.stats);
      } catch (error) {
        if (!mounted) return;
        setUserActionError(error instanceof Error ? error.message : "Không thể tải danh sách tài khoản");
      } finally {
        if (mounted) {
          setIsUsersLoading(false);
        }
      }
    }

    void loadUsers();

    return () => {
      mounted = false;
    };
  }, [backendToken]);

  const maxAgentCount = useMemo(
    () => Math.max(1, ...Object.values(conversationStats.agentBreakdown)),
    [conversationStats.agentBreakdown],
  );

  const groupedUsers = useMemo(() => groupUsers(users), [users]);
  const selectedManagerDetail = useMemo<ManagerDetail | null>(() => {
    if (!selectedManagerId) return null;
    const manager = users.find((user) => user.id === selectedManagerId);
    if (!manager) return null;
    return {
      manager,
      subordinates: resolveManagerSubordinates(manager, users),
    };
  }, [selectedManagerId, users]);
  const subordinateGroups = useMemo(
    () => groupUsers(selectedManagerDetail?.subordinates || []),
    [selectedManagerDetail],
  );

  async function refreshUsers() {
    if (!backendToken) return;
    const result = await fetchUsers(backendToken);
    setUsers(result.users);
    setUserStats(result.stats);
  }

  async function handleToggleUser(user: SystemUser) {
    if (!backendToken) return;
    const nextStatus = user.status === "active" ? "disabled" : "active";
    const actionLabel = nextStatus === "disabled" ? "Khóa" : "Mở khóa";
    const confirmed = window.confirm(`Xác nhận ${actionLabel} tài khoản ${user.employeeName} (${user.email})?`);
    if (!confirmed) return;

    setPendingUserId(user.id);
    setUserActionError(null);
    try {
      await updateUserStatus(backendToken, user.id, nextStatus);
      await refreshUsers();
    } catch (error) {
      setUserActionError(error instanceof Error ? error.message : "Cập nhật tài khoản thất bại");
    } finally {
      setPendingUserId(null);
    }
  }

  async function handleDeleteUser(user: SystemUser) {
    if (!backendToken) return;
    const confirmed = window.confirm(
      `Xác nhận xóa tài khoản ${user.employeeName} (${user.email})? Hành động này không thể hoàn tác.`,
    );
    if (!confirmed) return;

    setPendingUserId(user.id);
    setUserActionError(null);
    try {
      await deleteUser(backendToken, user.id);
      await refreshUsers();
    } catch (error) {
      setUserActionError(error instanceof Error ? error.message : "Xóa tài khoản thất bại");
    } finally {
      setPendingUserId(null);
    }
  }

  const listView = (
    <>
      <div className="stats-grid">
        <div className="stat-card glass-panel">
          <div className="stat-icon">??</div>
          <div className="stat-info">
            <span className="stat-value">{conversationStats.totalChats}</span>
            <span className="stat-label">Tổng cuộc hội thoại</span>
          </div>
        </div>

        <div className="stat-card glass-panel">
          <div className="stat-icon">??</div>
          <div className="stat-info">
            <span className="stat-value">{conversationStats.totalMessages}</span>
            <span className="stat-label">Tổng tin nhắn xử lý</span>
          </div>
        </div>

        <div className="stat-card glass-panel">
          <div className="stat-icon">??</div>
          <div className="stat-info">
            <span className="stat-value">{conversationStats.activeAgents}</span>
            <span className="stat-label">Agents hoạt động</span>
          </div>
        </div>

        <div className="stat-card glass-panel">
          <div className="stat-icon">??</div>
          <div className="stat-info">
            <span className="stat-value">{userStats.total}</span>
            <span className="stat-label">Tài khoản hệ thống</span>
          </div>
        </div>
      </div>

      <div className="dashboard-sections">
        <div className="glass-panel section-card">
          <h3>Hiệu suất theo Agent</h3>
          <div className="bar-chart">
            {Object.entries(conversationStats.agentBreakdown).map(([agentId, count]) => {
              const percentage = (count / maxAgentCount) * 100;
              return (
                <div key={agentId} className="bar-row">
                  <div className="bar-label">{agentId}</div>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${percentage}%` }} />
                  </div>
                  <div className="bar-value">{count} chat</div>
                </div>
              );
            })}
            {Object.keys(conversationStats.agentBreakdown).length === 0 && (
              <p className="empty-text">Chưa có dữ liệu hoạt động</p>
            )}
          </div>
        </div>

        <div className="glass-panel section-card">
          <h3>Tổng quan tài khoản</h3>
          <div className="account-overview-grid">
            <div className="account-overview-item">
              <span className="account-overview-label">Đang hoạt động</span>
              <strong>{userStats.active}</strong>
            </div>
            <div className="account-overview-item">
              <span className="account-overview-label">Đã tắt</span>
              <strong>{userStats.disabled}</strong>
            </div>
            <div className="account-overview-item full-width">
              <span className="account-overview-label">Phân bổ theo role</span>
              <div className="role-chip-list">
                {Object.entries(userStats.byRole).map(([role, count]) => (
                  <span key={role} className="role-chip">{role}: {count}</span>
                ))}
                {Object.keys(userStats.byRole).length === 0 && <span className="empty-text">Chưa có tài khoản</span>}
              </div>
            </div>
            <div className="account-overview-item full-width">
              <span className="account-overview-label">Phân bổ theo nhóm tài khoản</span>
              <div className="group-chip-list">
                {groupedUsers.map((group) => (
                  <span key={group.id} className="group-chip">
                    {group.label}: {group.users.length}
                  </span>
                ))}
                {groupedUsers.length === 0 && <span className="empty-text">Chưa có tài khoản</span>}
              </div>
            </div>
          </div>
        </div>

        <div className="glass-panel section-card dashboard-full-span">
          <div className="section-header-row">
            <h3>Quản lý tài khoản người dùng</h3>
            {isUsersLoading && <span className="table-status-note">Đang tải...</span>}
          </div>
          {userActionError && <div className="dashboard-inline-error">{userActionError}</div>}
          <div className="user-groups-stack">
            {groupedUsers.map((group) => (
              <section key={group.id} className="user-group-card">
                <div className="user-group-header">
                  <div>
                    <h4>{group.label}</h4>
                    <p>{group.description}</p>
                  </div>
                  <div className="user-group-metrics">
                    <span className="group-metric-pill">{group.users.length} tài khoản</span>
                    <span className="group-metric-pill subtle">
                      {group.users.filter((user) => user.status === "active").length} đang hoạt động
                    </span>
                  </div>
                </div>
                <div className="user-table-wrapper">
                  <table className="user-table">
                    <thead>
                      <tr>
                        <th>Họ tên</th>
                        <th>Email</th>
                        <th>Role</th>
                        <th>Agent</th>
                        <th>Trạng thái</th>
                        <th>Cập nhật</th>
                        <th>Hành động</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.users.map((user) => {
                        const isPending = pendingUserId === user.id;
                        const canViewDetail = isElevatedManager(user);

                        return (
                          <tr key={user.id}>
                            <td>
                              <div className="user-table-name">{user.employeeName}</div>
                              <div className="user-table-sub">{user.employeeId}</div>
                            </td>
                            <td>{user.email}</td>
                            <td><span className="role-chip">{user.role}</span></td>
                            <td>{user.lockedAgentId}</td>
                            <td>
                              <span className={`status-badge ${user.status}`}>
                                {user.status === "active" ? "Đang hoạt động" : "Đã tắt"}
                              </span>
                            </td>
                            <td>{new Date(user.updatedAt).toLocaleString("vi-VN")}</td>
                            <td>
                              <div className="user-actions-cell">
                                {canViewDetail && (
                                  <button
                                    className="dashboard-icon-btn"
                                    onClick={() => setSelectedManagerId(user.id)}
                                    disabled={isPending}
                                    title="Xem chi tiết tài khoản cấp dưới"
                                    aria-label={`Xem chi tiết ${user.employeeName}`}
                                  >
                                    <EyeIcon />
                                  </button>
                                )}
                                <button
                                  className="dashboard-action-btn"
                                  onClick={() => void handleToggleUser(user)}
                                  disabled={isPending}
                                >
                                  {user.status === "active" ? "Tắt" : "Mở lại"}
                                </button>
                                <button
                                  className="dashboard-action-btn danger"
                                  onClick={() => void handleDeleteUser(user)}
                                  disabled={isPending}
                                >
                                  Xóa
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
            {!isUsersLoading && groupedUsers.length === 0 && (
              <div className="user-table-empty standalone">Chưa có tài khoản nào.</div>
            )}
          </div>
        </div>
      </div>
    </>
  );

  const detailView = selectedManagerDetail && (
    <div className="dashboard-sections">
      <div className="glass-panel section-card dashboard-full-span">
        <div className="detail-page-header">
          <button className="dashboard-action-btn detail-back-btn" onClick={() => setSelectedManagerId(null)}>
            Quay lại danh sách
          </button>
          <div className="detail-manager-meta">
            <h3>{selectedManagerDetail.manager.employeeName}</h3>
            <div className="detail-manager-sub">
              <span>{selectedManagerDetail.manager.employeeId}</span>
              <span>•</span>
              <span>{selectedManagerDetail.manager.email}</span>
            </div>
          </div>
        </div>

        <div className="manager-detail-grid">
          <div className="account-overview-item">
            <span className="account-overview-label">Role quản lý</span>
            <strong>{selectedManagerDetail.manager.role}</strong>
          </div>
          <div className="account-overview-item">
            <span className="account-overview-label">Agent chính</span>
            <strong>{selectedManagerDetail.manager.lockedAgentId}</strong>
          </div>
          <div className="account-overview-item">
            <span className="account-overview-label">Tài khoản cấp dưới</span>
            <strong>{selectedManagerDetail.subordinates.length}</strong>
          </div>
          <div className="account-overview-item">
            <span className="account-overview-label">Đang hoạt động</span>
            <strong>{selectedManagerDetail.subordinates.filter((user) => user.status === "active").length}</strong>
          </div>
          <div className="account-overview-item full-width">
            <span className="account-overview-label">Phạm vi agent được quản lý</span>
            <div className="role-chip-list">
              {(selectedManagerDetail.manager.canViewAllSessions
                ? ["Tất cả phiên làm việc"]
                : selectedManagerDetail.manager.visibleAgentIds.length > 0
                  ? selectedManagerDetail.manager.visibleAgentIds
                  : [selectedManagerDetail.manager.lockedAgentId]
              ).map((item) => (
                <span key={item} className="role-chip">{item}</span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="glass-panel section-card dashboard-full-span">
        <div className="section-header-row">
          <h3>Tài khoản nhân viên cấp dưới</h3>
          <span className="table-status-note">{selectedManagerDetail.subordinates.length} tài khoản</span>
        </div>

        <div className="user-groups-stack">
          {subordinateGroups.map((group) => (
            <section key={group.id} className="user-group-card">
              <div className="user-group-header">
                <div>
                  <h4>{group.label}</h4>
                  <p>{group.description}</p>
                </div>
                <div className="user-group-metrics">
                  <span className="group-metric-pill">{group.users.length} tài khoản</span>
                </div>
              </div>
              <div className="user-table-wrapper">
                <table className="user-table">
                  <thead>
                    <tr>
                      <th>Họ tên</th>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Agent</th>
                      <th>Trạng thái</th>
                      <th>Cập nhật</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.users.map((user) => (
                      <tr key={user.id}>
                        <td>
                          <div className="user-table-name">{user.employeeName}</div>
                          <div className="user-table-sub">{user.employeeId}</div>
                        </td>
                        <td>{user.email}</td>
                        <td><span className="role-chip">{user.role}</span></td>
                        <td>{user.lockedAgentId}</td>
                        <td>
                          <span className={`status-badge ${user.status}`}>
                            {user.status === "active" ? "Đang hoạt động" : "Đã tắt"}
                          </span>
                        </td>
                        <td>{new Date(user.updatedAt).toLocaleString("vi-VN")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
          {selectedManagerDetail.subordinates.length === 0 && (
            <div className="user-table-empty standalone">
              Tài khoản này hiện chưa có nhân viên cấp dưới nào trong phạm vi quản lý.
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="dashboard-container">
      <div className="dashboard-header">
        <h1>{selectedManagerDetail ? "Chi tiết quản lý tài khoản" : "Trung tâm Điều hành"}</h1>
        <p>
          {selectedManagerDetail
            ? `Xem các tài khoản cấp dưới thuộc phạm vi quản lý của ${selectedManagerDetail.manager.employeeName}.`
            : "Tổng quan hoạt động và quản lý tài khoản người dùng trên hệ thống"}
        </p>
      </div>
      {selectedManagerDetail ? detailView : listView}
    </div>
  );
}
