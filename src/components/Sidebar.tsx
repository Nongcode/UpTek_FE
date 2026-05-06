"use client";

import React, { useMemo, useState } from "react";
import { Conversation } from "@/lib/types";
import { SessionBoxConversation, WorkflowConversationGroup } from "@/hooks/useConversations";
import SearchModal from "@/components/SearchModal";

import Link from "next/link";

interface SidebarProps {
  conversations: SessionBoxConversation[];
  workflowGroups?: WorkflowConversationGroup[];
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (id: string) => void;
  employeeName: string | null;
  employeeId: string | null;
  onLogout: () => void;
  isCollapsed: boolean;
  onToggle: () => void;
  onOpenDashboard?: () => void;
  canViewAllSessions?: boolean;
  createInFlight?: boolean;
}

export default function Sidebar({
  conversations,
  workflowGroups = [],
  activeConversationId,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  employeeName,
  employeeId,
  onLogout,
  isCollapsed,
  onToggle,
  onOpenDashboard,
  canViewAllSessions,
  createInFlight = false,
}: SidebarProps) {
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [expandedWorkflows, setExpandedWorkflows] = useState<Set<string>>(new Set());

  const getStatusLabel = (status?: Conversation["status"]) => {
    if (status === "pending_approval") return "Chờ duyệt";
    if (status === "approved") return "Hoàn tất";
    if (status === "cancelled") return "Đã hủy";
    if (status === "stopped") return "Đã dừng";
    if (status === "error") return "Lỗi";
    return "Đang chạy";
  };

  const sortedConversations = useMemo(
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations],
  );

  const userConversations = useMemo(
    () => sortedConversations.filter((conversation) => (conversation.lane || "user") !== "automation"),
    [sortedConversations],
  );

  const groupByTime = (source: SessionBoxConversation[]) => {
    const now = Date.now();
    const dayMs = 86400000;
    const today: SessionBoxConversation[] = [];
    const yesterday: SessionBoxConversation[] = [];
    const thisWeek: SessionBoxConversation[] = [];
    const older: SessionBoxConversation[] = [];

    source.forEach((conversation) => {
      const age = now - conversation.updatedAt;
      if (age < dayMs) today.push(conversation);
      else if (age < 2 * dayMs) yesterday.push(conversation);
      else if (age < 7 * dayMs) thisWeek.push(conversation);
      else older.push(conversation);
    });

    return { today, yesterday, thisWeek, older };
  };

  const timeGroups = groupByTime(userConversations);

  const agentLabel: Record<string, string> = {
    nv_content: "NV Content",
    nv_media: "NV Media",
    nv_prompt: "NV Prompt",
    media_video: "Media Video",
    pho_phong: "Phó phòng",
    truong_phong: "Trưởng phòng",
  };

  const renderConvItem = (conversation: Conversation, indent = false) => {
    const isMember = conversation.role === "sub_agent";
    return (
      <div
        key={conversation.id}
        className={`sidebar-conversation ${conversation.id === activeConversationId ? "active" : ""} ${indent ? "sub-agent" : ""}`}
        style={indent ? { paddingLeft: "1.75rem" } : undefined}
        onClick={() => onSelectConversation(conversation.id)}
      >
        <div className="conversation-icon">
          {isMember ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" opacity={0.7}>
              <path d="M8 1a4 4 0 100 8A4 4 0 008 1zM3 8a5 5 0 1110 0A5 5 0 013 8z" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2.5 3A1.5 1.5 0 014 1.5h8A1.5 1.5 0 0113.5 3v7A1.5 1.5 0 0112 11.5H5.707l-2.854 2.854A.5.5 0 012 14V3.5 3z" />
            </svg>
          )}
        </div>
        <span className="conversation-title">
          {indent ? (agentLabel[conversation.agentId] || conversation.agentId) : conversation.title}
        </span>
        {(conversation.lane === "automation") && (
          <span className={`conversation-status-badge ${conversation.status || "active"}`}>
            {getStatusLabel(conversation.status)}
          </span>
        )}
        <button
          className="conversation-delete"
          onClick={(event) => {
            event.stopPropagation();
            onDeleteConversation(conversation.id);
          }}
          title="Xóa cuộc trò chuyện"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
            <path d="M5.5 1a.5.5 0 00-.5.5V2H2.5a.5.5 0 000 1h.538l.46 8.28A1.5 1.5 0 005 12.75h4a1.5 1.5 0 001.502-1.47L10.962 3h.538a.5.5 0 000-1H9v-.5a.5.5 0 00-.5-.5h-3zM6 2v-.5h2V2H6z" />
          </svg>
        </button>
      </div>
    );
  };

  const renderWorkflowBox = (group: WorkflowConversationGroup) => {
    const rootConversation =
      group.memberConversations.find((conversation) => conversation.id === group.rootConversationId)
      || group.memberConversations.find((conversation) => conversation.role !== "sub_agent")
      || group.memberConversations[0];
    const subAgents = group.memberConversations.filter((conversation) => conversation.role === "sub_agent");
    const hasSubAgents = subAgents.length > 0;
    const isExpanded = expandedWorkflows.has(group.workflowId);
    const selectedConversationId = rootConversation?.id || group.rootConversationId || group.memberConversationIds[0] || "";
    const activeInGroup = activeConversationId ? group.memberConversationIds.includes(activeConversationId) : false;
    const status = rootConversation?.status || group.memberConversations[0]?.status;

    return (
      <div key={group.workflowId} className="sidebar-workflow-group">
        <div
          className={`sidebar-conversation ${activeInGroup ? "active" : ""}`}
          onClick={() => selectedConversationId && onSelectConversation(selectedConversationId)}
        >
          {hasSubAgents && (
            <button
              className="workflow-expand-btn"
              style={{ background: "none", border: "none", cursor: "pointer", padding: "0 4px", flexShrink: 0 }}
              onClick={(event) => {
                event.stopPropagation();
                setExpandedWorkflows((previous) => {
                  const next = new Set(previous);
                  next.has(group.workflowId) ? next.delete(group.workflowId) : next.add(group.workflowId);
                  return next;
                });
              }}
              title={isExpanded ? "Thu gọn" : "Mở rộng"}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="currentColor"
                style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
              >
                <path d="M3 1l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          <div className="conversation-icon">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2.5 3A1.5 1.5 0 014 1.5h8A1.5 1.5 0 0113.5 3v7A1.5 1.5 0 0112 11.5H5.707l-2.854 2.854A.5.5 0 012 14V3.5 3z" />
            </svg>
          </div>
          <span className="conversation-title">{group.title}</span>
          <span className={`conversation-status-badge ${status || "active"}`}>
            {getStatusLabel(status)}
          </span>
          <button
            className="conversation-delete"
            onClick={(event) => {
              event.stopPropagation();
              if (selectedConversationId) {
                onDeleteConversation(selectedConversationId);
              }
            }}
            title="Xóa luồng"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <path d="M5.5 1a.5.5 0 00-.5.5V2H2.5a.5.5 0 000 1h.538l.46 8.28A1.5 1.5 0 005 12.75h4a1.5 1.5 0 001.502-1.47L10.962 3h.538a.5.5 0 000-1H9v-.5a.5.5 0 00-.5-.5h-3zM6 2v-.5h2V2H6z" />
            </svg>
          </button>
        </div>
        {hasSubAgents && isExpanded && (
          <div className="workflow-sub-agents">
            {subAgents.sort((a, b) => a.createdAt - b.createdAt).map((conversation) => renderConvItem(conversation, true))}
          </div>
        )}
      </div>
    );
  };

  const renderTimeGroup = (label: string, items: SessionBoxConversation[]) => {
    if (items.length === 0) return null;
    return (
      <div className="sidebar-group">
        <div className="sidebar-group-label">{label}</div>
        {items.map((conversation) => renderConvItem(conversation))}
      </div>
    );
  };

  return (
    <>
      <div className={`sidebar-overlay ${!isCollapsed ? "visible" : ""}`} onClick={onToggle} />
      <aside className={`sidebar ${isCollapsed ? "collapsed" : ""}`}>
        <div className="sidebar-header">
          <button className="new-chat-button full-width" onClick={onNewConversation} disabled={createInFlight}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M9 3v12M3 9h12" />
            </svg>
            <span>Cuộc trò chuyện mới</span>
          </button>
        </div>

        <div className="sidebar-search-button-wrapper" style={{ margin: "0 auto" }}>
          <button className="menu-button" onClick={() => setShowSearchModal(true)} aria-label="Mở tìm kiếm">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <p style={{ marginLeft: "5px", fontSize: "14px" }}>Tìm kiếm đoạn chat</p>
          </button>
        </div>

        <nav className="sidebar-nav">
          {sortedConversations.length === 0 ? (
            <div className="sidebar-empty">
              <p>Chưa có cuộc trò chuyện nào</p>
              <p className="sidebar-empty-hint">Nhấn nút ở trên để bắt đầu</p>
            </div>
          ) : (
            <>
              {userConversations.length > 0 && (
                <>
                  {renderTimeGroup("Hôm nay", timeGroups.today)}
                  {renderTimeGroup("Hôm qua", timeGroups.yesterday)}
                  {renderTimeGroup("Tuần này", timeGroups.thisWeek)}
                  {renderTimeGroup("Trước đó", timeGroups.older)}
                </>
              )}

              {workflowGroups.length > 0 && (
                <div className="sidebar-group">
                  {userConversations.length > 0 && (
                    <div className="sidebar-group-label">Luồng tự động</div>
                  )}
                  {workflowGroups.map((group) => renderWorkflowBox(group))}
                </div>
              )}
            </>
          )}
        </nav>

        <div className="sidebar-footer">
          <div className="docs-nav-item">
            {canViewAllSessions && (
              <button
                onClick={onOpenDashboard}
                className="docs-button"
                style={{ marginBottom: "10px", width: "100%", border: "none", cursor: "pointer", textAlign: "left" }}
              >
                <div className="docs-button-content">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="7" height="7" rx="1"></rect>
                    <rect x="14" y="3" width="7" height="7" rx="1"></rect>
                    <rect x="14" y="14" width="7" height="7" rx="1"></rect>
                    <rect x="3" y="14" width="7" height="7" rx="1"></rect>
                  </svg>
                  <span>Bảng điều khiển</span>
                </div>
              </button>
            )}
            <Link href="/gallery" className="docs-button" style={{ marginBottom: "10px" }}>
              <div className="docs-button-content">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
                <span>Kho ảnh sản phẩm</span>
              </div>
            </Link>
            <Link href="/docs" className="docs-button">
              <div className="docs-button-content">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                </svg>
                <span>TÀI LIỆU HDSD</span>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </Link>
          </div>

          <div className="sidebar-version-wrapper">
            <div className="sidebar-version">
              <span>PHIÊN BẢN <span>v2026.3.14</span></span>
              <div className="version-dot"></div>
            </div>
          </div>

          <div className="user-profile">
            <div className="user-avatar">{(employeeName || "U")[0].toUpperCase()}</div>
            <div className="user-info">
              <span className="user-name">{employeeName || "User"}</span>
              <span className="user-role">{employeeId || ""}</span>
            </div>
            <button className="logout-button" onClick={onLogout} title="Đăng xuất">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 15H3a1 1 0 01-1-1V4a1 1 0 011-1h3M12 12l3-3-3-3M7 9h8" />
              </svg>
            </button>
          </div>
        </div>
      </aside>
      <SearchModal
        isOpen={showSearchModal}
        onClose={() => setShowSearchModal(false)}
        conversations={sortedConversations}
        onSelectConversation={(id) => onSelectConversation(id)}
      />
    </>
  );
}
