"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import ChatArea from "@/components/ChatArea";
import MessageInput from "@/components/MessageInput";
import DashboardArea from "@/components/DashboardArea";
import ThemeToggle from "@/components/ThemeToggle";
import { useAuth } from "@/context/AuthContext";
import { useConversations } from "@/hooks/useConversations";
import { canAccessAutomationLane, ChatLane } from "@/utils/chatLogic";
import { getAdminDashboardUrl } from "@/lib/runtimeUrls";

type AppMode = "chat" | "dashboard";

export default function Home() {
  const router = useRouter();
  const {
    isAuthenticated,
    isLoading,
    logout,
    token,
    backendToken,
    employeeId,
    employeeName,
    accessPolicy,
    bootstrapConfig,
  } = useAuth();

  const [appMode, setAppMode] = useState<AppMode>("chat");
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [chatLane, setChatLane] = useState<ChatLane>("user");
  const [viewingAgentId, setViewingAgentId] = useState("");
  const [showAgentDropdown, setShowAgentDropdown] = useState(false);
  const [showPersonalChatModal, setShowPersonalChatModal] = useState(false);
  const [showAutomationChatModal, setShowAutomationChatModal] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const canUseAutomationLane = canAccessAutomationLane(employeeId, accessPolicy);
  const isViewingSubordinate = viewingAgentId !== "" && viewingAgentId !== employeeId;
  const enableConversationRealtime = appMode === "chat";
  const adminDashboardUrl = getAdminDashboardUrl();

  const {
    filteredConversations,
    workflowGroups,
    activeConversation,
    activeId,
    isStreaming,
    streamingMessageId,
    streamingStore,
    handleNewConversation,
    handleSelectConversation,
    handleDeleteConversation,
    handleSendMessage,
    handleStopStreaming,
    activeStatusLabel,
    activeStreamState,
    activeWorkflowProgress,
    createInFlight,
    transientError,
    clearTransientError,
    sseStatus,
  } = useConversations({
    token,
    backendToken,
    employeeId,
    accessPolicy,
    viewingAgentId,
    chatLane,
    canUseAutomationLane,
    enablePolling: enableConversationRealtime,
  });

  useEffect(() => {
    if (accessPolicy?.lockedAgentId && !viewingAgentId) {
      setViewingAgentId(accessPolicy.lockedAgentId);
    }
  }, [accessPolicy, viewingAgentId]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowAgentDropdown(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    setIsSidebarCollapsed(window.innerWidth <= 768);
    const handleResize = () => {
      setIsSidebarCollapsed(window.innerWidth <= 768);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (isLoading) {
      return;
    }

    if (!isAuthenticated) {
      router.push("/login");
      return;
    }

    const isAdminUser = employeeId === "admin" || employeeId === "Admin" || employeeId === "main";
    if (isAdminUser && adminDashboardUrl) {
      window.location.assign(adminDashboardUrl);
    }
  }, [adminDashboardUrl, employeeId, isAuthenticated, isLoading, router]);

  useEffect(() => {
    if (!canUseAutomationLane && chatLane === "automation") {
      setChatLane("user");
    }
  }, [canUseAutomationLane, chatLane]);

  if (isLoading || !isAuthenticated || !employeeId) {
    return null;
  }

  const allAccounts = bootstrapConfig?.demoLogin?.accounts || [];
  let availableAgents = allAccounts
    .map((account) => ({
      lockedAgentId: account.employeeId || "",
      label: account.label || account.employeeName || account.employeeId || "",
      employeeName: account.employeeName,
    }))
    .filter((account) => account.lockedAgentId);

  if (!accessPolicy?.canViewAllSessions) {
    const visibleIds = accessPolicy?.visibleAgentIds || [];
    const lockedId = accessPolicy?.lockedAgentId;
    const allowed = new Set([...visibleIds, lockedId]);
    availableAgents = availableAgents.filter((account) => allowed.has(account.lockedAgentId));
  }

  if (availableAgents.length === 0 && accessPolicy) {
    const fallbackAgentIds = Array.from(
      new Set([
        accessPolicy.lockedAgentId || "",
        ...(accessPolicy.visibleAgentIds || []),
      ].filter(Boolean)),
    );

    availableAgents = fallbackAgentIds.map((agentId) => ({
      lockedAgentId: agentId,
      label: agentId === accessPolicy.lockedAgentId ? (employeeName || agentId) : agentId,
      employeeName: agentId,
    }));
  }

  // Filter out admin roles for giam_doc as they shouldn't see admin chats
  if (employeeId === "giam_doc") {
    availableAgents = availableAgents.filter((a) => !["admin", "Admin", "main"].includes(a.lockedAgentId));
  }

  const currentAgentName = availableAgents.find((agent) => agent.lockedAgentId === viewingAgentId)?.label || viewingAgentId;
  const automationCanSend = true;
  const automationDisabledReason = undefined;

  const onCreateConversation = () => {
    void handleNewConversation();
    if (typeof window !== "undefined" && window.innerWidth <= 768) {
      setIsSidebarCollapsed(true);
    }
  };

  const onSelectConversation = (conversationId: string) => {
    handleSelectConversation(conversationId);
    if (typeof window !== "undefined" && window.innerWidth <= 768) {
      setIsSidebarCollapsed(true);
    }
  };

  const onSendMessage = (content: string, type?: "manager_note") => {
    void handleSendMessage(content, { type });
  };

  const onStopStreaming = () => {
    void handleStopStreaming();
  };

  return (
    <div className="app-container">
      <Sidebar
        conversations={filteredConversations}
        workflowGroups={workflowGroups}
        activeConversationId={activeId}
        onSelectConversation={onSelectConversation}
        onNewConversation={onCreateConversation}
        onDeleteConversation={(conversationId) => void handleDeleteConversation(conversationId)}
        employeeName={employeeName}
        employeeId={employeeId}
        onLogout={logout}
        isCollapsed={isSidebarCollapsed}
        onToggle={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
        onOpenDashboard={() => setAppMode("dashboard")}
        canViewAllSessions={!!accessPolicy?.canViewAllSessions}
        createInFlight={createInFlight}
      />

      <main className={`main-content ${isSidebarCollapsed ? "sidebar-collapsed" : ""}`}>
        <div className="header-bar">
          <button className="menu-button" onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="12" x2="21" y2="12"></line>
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
          </button>

          <div className="agent-selector-wrapper" ref={dropdownRef}>
            <button
              className={`agent-selector-btn ${availableAgents.length > 1 ? "interactive" : ""}`}
              onClick={() => availableAgents.length > 1 && setShowAgentDropdown(!showAgentDropdown)}
            >
              <div className="header-title-group">
                <img src="/dbc2d982-780a-40a7-9588-5406dac6054d.jpg" alt="Uptek Logo" className="header-logo" />
                <span className="agent-badge">{currentAgentName}</span>
              </div>
              {availableAgents.length > 1 && (
                <svg className={`dropdown-icon ${showAgentDropdown ? "open" : ""}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              )}
            </button>

            {showAgentDropdown && availableAgents.length > 1 && (
              <div className="agent-dropdown">
                <div className="agent-dropdown-header">Theo dõi & Chat dưới quyền:</div>
                {availableAgents.map((agent) => (
                  <button
                    key={agent.lockedAgentId}
                    className={`agent-option ${viewingAgentId === agent.lockedAgentId ? "selected" : ""}`}
                    onClick={() => {
                      if (agent.lockedAgentId) {
                        setViewingAgentId(agent.lockedAgentId);
                      }
                      setShowAgentDropdown(false);
                    }}
                  >
                    <div className="agent-option-avatar">
                      {(agent.label || agent.employeeName || "A")[0].toUpperCase()}
                    </div>
                    <div className="agent-option-info">
                      <span className="agent-option-name">{agent.label || agent.employeeName}</span>
                      <span className="agent-option-id">{agent.lockedAgentId}</span>
                    </div>
                    {viewingAgentId === agent.lockedAgentId && (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" strokeWidth="3" strokeLinecap="round">
                        <polyline points="20 6 9 17 4 12"></polyline>
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="header-spacer" />

          <div className="header-modes-nav">
            <button
              className={`mode-btn ${chatLane === "user" && appMode === "chat" ? "active" : ""}`}
              onClick={() => {
                if (chatLane !== "user" || appMode !== "chat") {
                  setShowPersonalChatModal(true);
                }
                setAppMode("chat");
                setChatLane("user");
              }}
            >
              Chat cá nhân
            </button>
            {canUseAutomationLane && (
              <button
                className={`mode-btn ${chatLane === "automation" && appMode === "chat" ? "active" : ""}`}
                onClick={() => {
                  if (chatLane !== "automation" || appMode !== "chat") {
                    setShowAutomationChatModal(true);
                  }
                  setAppMode("chat");
                  setChatLane("automation");
                }}
              >
                Luồng tự động
              </button>
            )}
          </div>

          <div className="header-spacer" />

          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <ThemeToggle />
            <button
              className="new-chat-icon-button"
              onClick={onCreateConversation}
              disabled={createInFlight}
              title="Tạo mới"
              style={{ visibility: appMode === "chat" ? "visible" : "hidden" }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
        </div>

        {appMode === "chat" ? (
          <>
            {isViewingSubordinate && (
              <div className="surveillance-banner">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                  <circle cx="12" cy="12" r="3"></circle>
                </svg>
                <span>Đang giám sát đoạn chat của <strong>{currentAgentName}</strong></span>
              </div>
            )}
            <ChatArea
              conversationId={activeConversation?.id || null}
              messages={activeConversation?.messages || []}
              isStreaming={isStreaming}
              streamingMessageId={streamingMessageId}
              streamingStore={streamingStore}
              agentId={currentAgentName}
              backendToken={backendToken}
              streamStatusLabel={activeStatusLabel}
              streamState={activeStreamState}
              workflowProgress={activeWorkflowProgress}
              transientError={transientError}
              onDismissTransientError={clearTransientError}
              sseStatus={sseStatus}
            />

            <div className="input-container-wrapper">
              <MessageInput
                onSend={onSendMessage}
                isStreaming={isStreaming}
                onStopStreaming={onStopStreaming}
                isManagerView={isViewingSubordinate}
                disabled={!automationCanSend}
                disabledReason={automationDisabledReason}
                statusLabel={activeStatusLabel}
              />
            </div>
          </>
        ) : (
          <DashboardArea backendToken={backendToken} />
        )}
      </main>

      {showPersonalChatModal && (
        <div style={{
          position: "fixed",
          inset: 0,
          zIndex: 9999,
          background: "rgba(0, 0, 0, 0.6)",
          backdropFilter: "blur(4px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "20px"
        }}>
          <div style={{
            background: "var(--bg-panel)",
            border: "1px solid var(--border-color)",
            borderRadius: "16px",
            padding: "32px",
            maxWidth: "500px",
            width: "100%",
            boxShadow: "0 24px 60px rgba(0, 0, 0, 0.3)"
          }}>
            <h3 style={{ margin: "0 0 16px 0", color: "var(--text-primary)", fontSize: "1.35rem", fontWeight: 700 }}>Thông báo</h3>
            <p style={{ color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: "28px", fontSize: "1.05rem" }}>
              Tab chat cá nhân chỉ sử dụng với các yêu cầu cá nhân, không chạy quy trình tự động.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                onClick={() => setShowPersonalChatModal(false)}
                style={{
                  background: "var(--accent-primary)",
                  color: "#fff",
                  border: "none",
                  padding: "10px 20px",
                  borderRadius: "10px",
                  fontWeight: 600,
                  cursor: "pointer",
                  transition: "opacity 0.2s"
                }}
                onMouseOver={(e) => e.currentTarget.style.opacity = "0.9"}
                onMouseOut={(e) => e.currentTarget.style.opacity = "1"}
              >
                Tôi đã hiểu
              </button>
            </div>
          </div>
        </div>
      )}

      {showAutomationChatModal && (
        <div style={{
          position: "fixed",
          inset: 0,
          zIndex: 9999,
          background: "rgba(0, 0, 0, 0.6)",
          backdropFilter: "blur(4px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "20px"
        }}>
          <div style={{
            background: "var(--bg-panel)",
            border: "1px solid var(--border-color)",
            borderRadius: "16px",
            padding: "32px",
            maxWidth: "540px",
            width: "100%",
            boxShadow: "0 24px 60px rgba(0, 0, 0, 0.3)"
          }}>
            <h3 style={{ margin: "0 0 16px 0", color: "var(--text-primary)", fontSize: "1.35rem", fontWeight: 700 }}>Thông báo</h3>
            <p style={{ color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: "28px", fontSize: "1.05rem" }}>
              Tab chat luồng tự động chỉ phục vụ các quy trình tự động. Khi đã bắt đầu 1 luồng tự động thì không can thiệp vào quá trình chạy luồng ngoại trừ lúc agent yêu cầu duyệt. Nếu có yêu cầu riêng vui lòng chat tại tab chat cá nhân.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                onClick={() => setShowAutomationChatModal(false)}
                style={{
                  background: "var(--accent-primary)",
                  color: "#fff",
                  border: "none",
                  padding: "10px 20px",
                  borderRadius: "10px",
                  fontWeight: 600,
                  cursor: "pointer",
                  transition: "opacity 0.2s"
                }}
                onMouseOver={(e) => e.currentTarget.style.opacity = "0.9"}
                onMouseOut={(e) => e.currentTarget.style.opacity = "1"}
              >
                Tôi đã hiểu
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
