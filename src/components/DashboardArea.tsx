import React, { useEffect, useMemo, useState } from "react";
import { loadAllConversationsGlobally } from "@/lib/storage";
import {
  addVisibleAgentToUser,
  deleteUser,
  fetchUsers,
  removeVisibleAgentFromUser,
  updateUserStatus,
} from "@/lib/api";
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

const AGENT_FUNCTION_SUMMARIES: Record<string, string> = {
  nv_content: "Sản xuất nội dung, phân tích xu hướng và tối ưu hóa bài viết marketing.",
  nv_media: "Sáng tạo hình ảnh và video chuyên nghiệp bằng trí tuệ nhân tạo (AI).",
  nv_prompt: "Thiết kế và tinh chỉnh cấu trúc câu lệnh tối ưu cho các mô hình ngôn ngữ.",
  nv_consultant: "Tư vấn khách hàng, giải đáp thắc mắc và tra cứu thông tin sản phẩm.",
  nv_assistant: "Quản lý lịch trình làm việc, gửi email tự động và hỗ trợ điều phối.",
  pho_phong: "Điều hành nhóm nhân viên, phê duyệt yêu cầu và quản lý luồng công việc.",
  main: "Agent đa nhiệm xử lý các tác vụ tổng quát trên toàn hệ thống.",
  giam_doc: "Giám sát toàn bộ hoạt động hệ thống và đưa ra các quyết định chiến lược.",
};

const PHO_PHONG_REQUIRED_AGENTS = ["nv_content", "nv_media", "nv_prompt"];

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

function isPeerManagerForDeputy(user: SystemUser) {
  const joined = normalizeKeyword(
    [user.employeeId, user.employeeName, user.role, user.lockedAgentId].filter(Boolean).join(" "),
  );

  return (
    /\badmin\b/.test(joined)
    || /\bgiam[_\s-]*doc\b/.test(joined)
    || /\btruong[_\s-]*phong\b/.test(joined)
    || /\bpho[_\s-]*phong\b/.test(joined)
  );
}

function normalizeAgentId(value: string | null | undefined) {
  const normalized = normalizeKeyword(value).replace(/\s+/g, "_");
  const normalizedAlias = normalized === "nv_promt" ? "nv_prompt" : normalized;
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(normalizedAlias) ? normalizedAlias : "";
}

function isPhoPhongManager(user: SystemUser) {
  return normalizeAgentId(user.lockedAgentId) === "pho_phong" || normalizeAgentId(user.employeeId) === "pho_phong";
}

function resolveRequiredManagerAgents(manager: SystemUser) {
  return isPhoPhongManager(manager) ? PHO_PHONG_REQUIRED_AGENTS : [];
}

function canRemoveManagedAgent(manager: SystemUser, agentId: string) {
  const normalizedAgentId = normalizeAgentId(agentId);
  if (!normalizedAgentId || normalizedAgentId === normalizeAgentId(manager.lockedAgentId)) {
    return false;
  }
  return !resolveRequiredManagerAgents(manager).includes(normalizedAgentId);
}

function resolveManagerSubordinates(manager: SystemUser, users: SystemUser[]) {
  const managerKey = normalizeKeyword(manager.employeeId);
  const managerRoleKey = normalizeKeyword(manager.role);
  const isDeputyManager =
    /\bpho[_\s-]*phong\b/.test(managerKey)
    || /\bpho[_\s-]*phong\b/.test(managerRoleKey);
  const visibleIds = new Set(
    [manager.lockedAgentId, ...resolveRequiredManagerAgents(manager), ...(manager.visibleAgentIds || [])]
      .map((item) => normalizeKeyword(item))
      .filter(Boolean),
  );

  return users.filter((user) => {
    if (user.id === manager.id) return false;
    if (isDeputyManager && isPeerManagerForDeputy(user)) return false;

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

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="action-icon">
      <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="action-icon">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function ZapIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="action-icon">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function BotIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="action-icon">
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <circle cx="12" cy="5" r="2" />
      <path d="M12 7v4" />
      <line x1="8" y1="16" x2="8" y2="16" />
      <line x1="16" y1="16" x2="16" y2="16" />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="action-icon">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="action-icon">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="action-icon">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
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
  const [showAddSubordinateAgents, setShowAddSubordinateAgents] = useState(false);
  const [pendingVisibleAgentId, setPendingVisibleAgentId] = useState<string | null>(null);
  const [pendingRemoveVisibleAgentId, setPendingRemoveVisibleAgentId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [filterRole, setFilterRole] = useState<string | null>(null);
  const [filterGroup, setFilterGroup] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string | null>(null);

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

  const filteredUsers = useMemo(() => {
    return users.filter((user) => {
      const matchesSearch = !searchTerm
        || user.employeeName.toLowerCase().includes(searchTerm.toLowerCase())
        || user.email.toLowerCase().includes(searchTerm.toLowerCase())
        || user.employeeId.toLowerCase().includes(searchTerm.toLowerCase())
        || user.lockedAgentId?.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesRole = !filterRole || user.role === filterRole;
      const matchesGroup = !filterGroup || resolveUserGroupMeta(user).id === filterGroup;
      const matchesStatus = !filterStatus || user.status === filterStatus;

      return matchesSearch && matchesRole && matchesGroup && matchesStatus;
    });
  }, [users, searchTerm, filterRole, filterGroup, filterStatus]);

  const groupedUsers = useMemo(() => groupUsers(filteredUsers), [filteredUsers]);
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
  const assignableAgents = useMemo(() => {
    if (!selectedManagerDetail || selectedManagerDetail.manager.canViewAllSessions) return [];

    const manager = selectedManagerDetail.manager;
    const ownedAgentIds = new Set(
      [manager.lockedAgentId, ...resolveRequiredManagerAgents(manager), ...(manager.visibleAgentIds || [])]
        .map(normalizeKeyword)
        .filter(Boolean),
    );
    const seen = new Set<string>();

    return users
      .filter((user) => {
        if (user.id === manager.id || user.status !== "active") return false;
        if (resolveUserGroupMeta(user).id !== "back-office") return false;

        const agentId = user.lockedAgentId || user.employeeId;
        const normalizedAgentId = normalizeKeyword(agentId);
        if (!normalizedAgentId || ownedAgentIds.has(normalizedAgentId) || seen.has(normalizedAgentId)) {
          return false;
        }
        seen.add(normalizedAgentId);
        return true;
      })
      .sort((left, right) => left.employeeName.localeCompare(right.employeeName, "vi"));
  }, [selectedManagerDetail, users]);

  async function refreshUsers() {
    if (!backendToken) return;
    const result = await fetchUsers(backendToken);
    setUsers(result.users);
    setUserStats(result.stats);
  }

  async function handleAddVisibleAgent(agentUser: SystemUser) {
    if (!backendToken || !selectedManagerDetail) return;
    const agentId = agentUser.lockedAgentId || agentUser.employeeId;
    const confirmed = window.confirm(
      `Thêm ${agentUser.employeeName} (${agentId}) vào danh sách agent cấp dưới của ${selectedManagerDetail.manager.employeeName}?`,
    );
    if (!confirmed) return;

    setPendingVisibleAgentId(agentId);
    setUserActionError(null);
    try {
      await addVisibleAgentToUser(backendToken, selectedManagerDetail.manager.id, agentId);
      await refreshUsers();
      setShowAddSubordinateAgents(false);
    } catch (error) {
      setUserActionError(error instanceof Error ? error.message : "Thêm agent cấp dưới thất bại");
    } finally {
      setPendingVisibleAgentId(null);
    }
  }

  async function handleRemoveVisibleAgent(agentId: string) {
    if (!backendToken || !selectedManagerDetail) return;
    if (!canRemoveManagedAgent(selectedManagerDetail.manager, agentId)) {
      setUserActionError("Không thể gỡ agent mặc định của pho_phong hoặc agent chính của tài khoản.");
      return;
    }
    const confirmed = window.confirm(
      `Gỡ ${agentId} khỏi danh sách agent cấp dưới của ${selectedManagerDetail.manager.employeeName}?`,
    );
    if (!confirmed) return;

    setPendingRemoveVisibleAgentId(agentId);
    setUserActionError(null);
    try {
      await removeVisibleAgentFromUser(backendToken, selectedManagerDetail.manager.id, agentId);
      await refreshUsers();
    } catch (error) {
      setUserActionError(error instanceof Error ? error.message : "Gỡ agent cấp dưới thất bại");
    } finally {
      setPendingRemoveVisibleAgentId(null);
    }
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
        <div className="stat-card glass-panel chat-stat">
          <div className="stat-icon-wrapper">
            <ChatIcon />
          </div>
          <div className="stat-info">
            <span className="stat-value">{conversationStats.totalChats}</span>
            <span className="stat-label">Tổng cuộc hội thoại</span>
          </div>
        </div>

        <div className="stat-card glass-panel message-stat">
          <div className="stat-icon-wrapper">
            <ZapIcon />
          </div>
          <div className="stat-info">
            <span className="stat-value">{conversationStats.totalMessages}</span>
            <span className="stat-label">Tổng tin nhắn xử lý</span>
          </div>
        </div>

        <div className="stat-card glass-panel agent-stat">
          <div className="stat-icon-wrapper">
            <BotIcon />
          </div>
          <div className="stat-info">
            <span className="stat-value">{conversationStats.activeAgents}</span>
            <span className="stat-label">Agents hoạt động</span>
          </div>
        </div>

        <div className="stat-card glass-panel user-stat">
          <div className="stat-icon-wrapper">
            <UsersIcon />
          </div>
          <div className="stat-info">
            <span className="stat-value">{userStats.total}</span>
            <span className="stat-label">Tài khoản hệ thống</span>
          </div>
        </div>
      </div>

      <div className="dashboard-sections">
        <div className="glass-panel section-card dashboard-full-span">
          <div className="section-header-row">
            <h3>Quản lý tài khoản người dùng</h3>
            <div className="table-header-actions">
              <span className="table-status-note">{filteredUsers.length} kết quả</span>
            </div>
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
          <div className="detail-header-left">
            <div className="detail-manager-meta">
              <h3>{selectedManagerDetail.manager.employeeName}</h3>
              <div className="detail-manager-sub">
                <span>{selectedManagerDetail.manager.employeeId}</span>
                <span>•</span>
                <span>{selectedManagerDetail.manager.email}</span>
              </div>
            </div>
          </div>
          <button
            className="dashboard-action-btn primary"
            type="button"
            disabled={selectedManagerDetail.manager.canViewAllSessions}
            onClick={() => setShowAddSubordinateAgents(true)}
          >
            Thêm agent cấp dưới
          </button>
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
                : Array.from(
                    new Set([
                      selectedManagerDetail.manager.lockedAgentId,
                      ...resolveRequiredManagerAgents(selectedManagerDetail.manager),
                      ...(selectedManagerDetail.manager.visibleAgentIds || []),
                    ]),
                  )
              ).map((item) => (
                <span
                  key={item}
                  className={`role-chip managed-agent-chip ${canRemoveManagedAgent(selectedManagerDetail.manager, item) ? "removable" : "locked"}`}
                >
                  {item}
                  {canRemoveManagedAgent(selectedManagerDetail.manager, item) && (
                    <button
                      type="button"
                      className="managed-agent-remove"
                      disabled={pendingRemoveVisibleAgentId === item}
                      title={`Gỡ ${item}`}
                      aria-label={`Gỡ ${item}`}
                      onClick={() => void handleRemoveVisibleAgent(item)}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {userActionError && (
        <div className="glass-panel section-card dashboard-full-span">
          <div className="dashboard-inline-error">{userActionError}</div>
        </div>
      )}

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
      {showAddSubordinateAgents && (
        <div className="dashboard-modal-overlay" onClick={() => setShowAddSubordinateAgents(false)}>
          <div className="dashboard-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="dashboard-modal-header">
              <h2>Thêm agent cấp dưới</h2>
              <button className="dashboard-modal-close" onClick={() => setShowAddSubordinateAgents(false)}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="dashboard-modal-body">
              <table className="modal-table user-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Role</th>
                    <th>Agent ID</th>
                    <th>Tóm tắt</th>
                    <th>Hành động</th>
                  </tr>
                </thead>
                <tbody>
                  {assignableAgents.map((agentUser) => {
                    const agentId = agentUser.lockedAgentId || agentUser.employeeId;
                    const isPending = pendingVisibleAgentId === agentId;
                    return (
                      <tr key={agentUser.id}>
                        <td>
                          <div className="user-table-name">{agentUser.employeeName}</div>
                          <div className="user-table-sub">{agentUser.email}</div>
                        </td>
                        <td><span className="role-chip">{agentUser.role}</span></td>
                        <td>{agentId}</td>
                        <td className="modal-summary-cell">
                          {AGENT_FUNCTION_SUMMARIES[agentId] || `${agentUser.employeeName} hỗ trợ vận hành hệ thống qua agent ${agentId}.`}
                        </td>
                        <td>
                          <button
                            className="dashboard-action-btn primary"
                            type="button"
                            disabled={isPending}
                            onClick={() => void handleAddVisibleAgent(agentUser)}
                          >
                            {isPending ? "Đang thêm..." : "Thêm"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {assignableAgents.length === 0 && (
                    <tr>
                      <td colSpan={5} className="user-table-empty standalone">
                        Không còn agent Back_office nào khả dụng để thêm.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="dashboard-container">
      <div className="dashboard-header">
        <div className="header-title-row main-dashboard-header">
          <div className="header-left-group">
            {selectedManagerId && (
              <button
                className="dashboard-icon-btn back-main-btn"
                onClick={() => setSelectedManagerId(null)}
                title="Quay lại danh sách"
              >
                <BackIcon />
              </button>
            )}
            <h1>{selectedManagerDetail ? "Chi tiết quản lý tài khoản" : "Trung tâm Điều hành"}</h1>
          </div>

          {!selectedManagerId && (
            <div className="dashboard-search-wrapper">
              <div className="search-input-container glass-panel">
                <SearchIcon />
                <input
                  type="text"
                  placeholder="Tìm tên, email hoặc agent ID..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
                {searchTerm && (
                  <button className="clear-search-btn" onClick={() => setSearchTerm("")}>?</button>
                )}
              </div>
              <button
                className={`dashboard-action-btn filter-toggle-btn ${isFilterOpen || filterRole || filterGroup || filterStatus ? "active" : ""}`}
                onClick={() => setIsFilterOpen(!isFilterOpen)}
              >
                <FilterIcon />
                <span>Bộ lọc</span>
                {(filterRole || filterGroup || filterStatus) && <span className="filter-active-dot"></span>}
              </button>

              {isFilterOpen && (
                <div className="advanced-filter-dropdown glass-panel animation-fade-scale">
                  <div className="dropdown-filter-header">
                    <h4>Bộ lọc nâng cao</h4>
                    <button className="clear-filter-btn subtle" onClick={() => {
                      setFilterRole(null);
                      setFilterGroup(null);
                      setFilterStatus(null);
                    }}>Đặt lại</button>
                  </div>

                  <div className="dropdown-filter-body">
                    <div className="compact-metric-row">
                      <div
                        className={`compact-metric-pill active ${filterStatus === "active" ? "selected" : ""}`}
                        onClick={() => setFilterStatus(filterStatus === "active" ? null : "active")}
                      >
                        <span className="dot"></span>
                        <span className="label">Đang hoạt động:</span>
                        <span className="val">{userStats.active}</span>
                      </div>
                      <div
                        className={`compact-metric-pill disabled ${filterStatus === "disabled" ? "selected" : ""}`}
                        onClick={() => setFilterStatus(filterStatus === "disabled" ? null : "disabled")}
                      >
                        <span className="dot"></span>
                        <span className="label">Đã tắt:</span>
                        <span className="val">{userStats.disabled}</span>
                      </div>
                    </div>

                    <div className="dropdown-dist-section">
                      <span className="section-label">Phân bổ Vai trò</span>
                      <div className="mini-chips-grid">
                        {Object.entries(userStats.byRole).map(([role, count]) => (
                          <div
                            key={role}
                            className={`mini-dist-chip ${filterRole === role ? "selected" : ""}`}
                            onClick={() => setFilterRole(filterRole === role ? null : role)}
                          >
                            <span className="role">{role}</span>
                            <span className="count">{count}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="dropdown-dist-section">
                      <span className="section-label">Cấu trúc Nhóm</span>
                      <div className="mini-chips-grid">
                        {groupUsers(users).map((group) => (
                          <div
                            key={group.id}
                            className={`mini-dist-chip group-variant ${filterGroup === group.id ? "selected" : ""}`}
                            onClick={() => setFilterGroup(filterGroup === group.id ? null : group.id)}
                          >
                            <span className="role">{group.label}</span>
                            <span className="count">{group.users.length}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
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
