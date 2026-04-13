"use client";

import React from "react";
import { Conversation } from "@/lib/types";

interface SidebarProps {
  conversations: Conversation[];
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (id: string) => void;
  employeeName: string | null;
  employeeId: string | null;
  onLogout: () => void;
  isCollapsed: boolean;
  onToggle: () => void;
}

export default function Sidebar({
  conversations,
  activeConversationId,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  employeeName,
  employeeId,
  onLogout,
  isCollapsed,
  onToggle,
}: SidebarProps) {
  const sortedConversations = [...conversations].sort(
    (a, b) => b.updatedAt - a.updatedAt
  );

  const groupConversations = () => {
    const now = Date.now();
    const today: Conversation[] = [];
    const yesterday: Conversation[] = [];
    const thisWeek: Conversation[] = [];
    const older: Conversation[] = [];

    const dayMs = 86400000;

    sortedConversations.forEach((conv) => {
      const age = now - conv.updatedAt;
      if (age < dayMs) today.push(conv);
      else if (age < 2 * dayMs) yesterday.push(conv);
      else if (age < 7 * dayMs) thisWeek.push(conv);
      else older.push(conv);
    });

    return { today, yesterday, thisWeek, older };
  };

  const groups = groupConversations();

  const renderGroup = (label: string, items: Conversation[]) => {
    if (items.length === 0) return null;
    return (
      <div className="sidebar-group">
        <div className="sidebar-group-label">{label}</div>
        {items.map((conv) => (
          <div
            key={conv.id}
            className={`sidebar-conversation ${conv.id === activeConversationId ? "active" : ""}`}
            onClick={() => onSelectConversation(conv.id)}
          >
            <div className="conversation-icon">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M2.5 3A1.5 1.5 0 014 1.5h8A1.5 1.5 0 0113.5 3v7A1.5 1.5 0 0112 11.5H5.707l-2.854 2.854A.5.5 0 012 14V3.5 3z" />
              </svg>
            </div>
            <span className="conversation-title">{conv.title}</span>
            <button
              className="conversation-delete"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteConversation(conv.id);
              }}
              title="Xóa cuộc trò chuyện"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                <path d="M5.5 1a.5.5 0 00-.5.5V2H2.5a.5.5 0 000 1h.538l.46 8.28A1.5 1.5 0 005 12.75h4a1.5 1.5 0 001.502-1.47L10.962 3h.538a.5.5 0 000-1H9v-.5a.5.5 0 00-.5-.5h-3zM6 2v-.5h2V2H6z" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    );
  };

  return (
    <>
      <div className={`sidebar-overlay ${!isCollapsed ? "visible" : ""}`} onClick={onToggle} />
      <aside className={`sidebar ${isCollapsed ? "collapsed" : ""}`}>
        <div className="sidebar-header">
          <button className="new-chat-button full-width" onClick={onNewConversation}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M9 3v12M3 9h12" />
            </svg>
            <span>Cuộc trò chuyện mới</span>
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
              {renderGroup("Hôm nay", groups.today)}
              {renderGroup("Hôm qua", groups.yesterday)}
              {renderGroup("Tuần này", groups.thisWeek)}
              {renderGroup("Trước đó", groups.older)}
            </>
          )}
        </nav>

        <div className="sidebar-footer">
          <div className="user-profile">
            <div className="user-avatar">
              {(employeeName || "U")[0].toUpperCase()}
            </div>
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
    </>
  );
}
