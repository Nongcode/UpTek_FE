"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import Sidebar from "@/components/Sidebar";
import ChatArea from "@/components/ChatArea";
import MessageInput from "@/components/MessageInput";
import DashboardArea from "@/components/DashboardArea";
import {
  Conversation,
  loadConversations,
  createConversation,
  createMessage,
  generateConversationTitle,
  apiCreateConversation,
  apiUpdateConversation,
  apiDeleteConversation,
  apiSaveMessages,
  Project
} from "@/lib/storage";
import { streamChatCompletion } from "@/lib/api";

type AppMode = "chat" | "dashboard";

export default function Home() {
  const router = useRouter();
  const { isAuthenticated, isLoading, logout, token, employeeId, employeeName, accessPolicy, bootstrapConfig } = useAuth();

  const [appMode, setAppMode] = useState<AppMode>("chat");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  
  // Per-conversation streaming state (cho phép nhiều chat stream đồng thời)
  const streamingMapRef = useRef<Map<string, { messageId: string; controller: AbortController }>>(new Map());
  const [streamingConvIds, setStreamingConvIds] = useState<Set<string>>(new Set());

  // Agent viewing state
  const [viewingAgentId, setViewingAgentId] = useState<string>("");
  const [showAgentDropdown, setShowAgentDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Initialize viewingAgentId
  useEffect(() => {
    if (accessPolicy?.lockedAgentId && !viewingAgentId) {
      setViewingAgentId(accessPolicy.lockedAgentId);
    }
  }, [accessPolicy, viewingAgentId]);

  // Click outside to close dropdown
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowAgentDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Auto-collapse sidebar on mobile
  useEffect(() => {
    if (typeof window !== "undefined") {
      setIsSidebarCollapsed(window.innerWidth <= 768);
      const handleResize = () => {
        if (window.innerWidth <= 768) setIsSidebarCollapsed(true);
        else setIsSidebarCollapsed(false);
      };
      window.addEventListener("resize", handleResize);
      return () => window.removeEventListener("resize", handleResize);
    }
  }, []);

  useEffect(() => {
    if (!isLoading) {
      if (!isAuthenticated) {
        router.push("/login");
      } else if (employeeId === "admin" || employeeId === "Admin" || employeeId === "main") {
        window.location.href = "http://localhost:18789/";
      }
    }
  }, [isLoading, isAuthenticated, router, employeeId]);

  // Xác định đang xem nhân viên nào: mình hay cấp dưới
  const isViewingSubordinate = viewingAgentId !== "" && viewingAgentId !== employeeId;
  // EmployeeId dùng để tải conversations: nếu xem cấp dưới thì dùng ID cấp dưới
  const targetLoadId = isViewingSubordinate ? viewingAgentId : employeeId;

  // Load conversations — tải lại khi chuyển sang xem nhân viên khác
  useEffect(() => {
    let mounted = true;
    if (targetLoadId) {
      loadConversations(targetLoadId).then((loaded) => {
        if (mounted) {
          setConversations(loaded);
          // Auto-select first conversation of viewed agent
          const filtered = loaded.filter(c => c.agentId === viewingAgentId);
          if (filtered.length > 0) {
            setActiveId(filtered[0].id);
          } else {
            setActiveId(null);
          }
        }
      });
    }
    return () => { mounted = false; };
  }, [targetLoadId, viewingAgentId]);

  if (isLoading || !isAuthenticated || !employeeId) {
    return null;
  }

  // Determine available agents
  const allAccounts = bootstrapConfig?.demoLogin?.accounts || [];

  // Map demo accounts to a standardized agent list using employeeId as the agentId
  let availableAgents = allAccounts.map(acc => ({
    lockedAgentId: acc.employeeId || "",
    label: acc.label || acc.employeeName || acc.employeeId || "",
    employeeName: acc.employeeName
  })).filter(acc => acc.lockedAgentId);

  // If not admin, restrict to visibleAgentIds
  if (!accessPolicy?.canViewAllSessions) {
    const visibleIds = accessPolicy?.visibleAgentIds || [];
    const lockedId = accessPolicy?.lockedAgentId;
    // ensure their own agent is always included
    const allowed = new Set([...visibleIds, lockedId]);
    availableAgents = availableAgents.filter(acc => allowed.has(acc.lockedAgentId));
  }

  // Fallback if somehow empty
  if (availableAgents.length === 0 && accessPolicy?.lockedAgentId) {
    availableAgents = [{
      lockedAgentId: accessPolicy.lockedAgentId,
      label: employeeName || accessPolicy.lockedAgentId,
      employeeName: employeeName || ""
    }];
  }

  const currentAgentName = availableAgents.find(a => a.lockedAgentId === viewingAgentId)?.label
    || viewingAgentId;

  const filteredConversations = conversations.filter(c => c.agentId === viewingAgentId);
  const activeConversation = filteredConversations.find((c) => c.id === activeId);

  const handleNewConversation = () => {
    const newConv = createConversation(viewingAgentId);
    // Gán employeeId = người sở hữu thật sự (cấp dưới nếu đang xem cấp dưới)
    newConv.employeeId = targetLoadId ?? undefined;
    setConversations(prev => [newConv, ...prev]);
    setActiveId(newConv.id);
    apiCreateConversation(newConv);
    if (window.innerWidth <= 768) setIsSidebarCollapsed(true);
  };

  const handleSelectConversation = (id: string) => {
    setActiveId(id);
    if (window.innerWidth <= 768) setIsSidebarCollapsed(true);
  };

  const handleDeleteConversation = async (id: string) => {
    const updated = conversations.filter((c) => c.id !== id);
    setConversations(updated);
    await apiDeleteConversation(id);
    if (activeId === id) {
      const remaining = updated.filter(c => c.agentId === viewingAgentId);
      setActiveId(remaining.length > 0 ? remaining[0].id : null);
    }
  };

  const updateConversation = (id: string, updates: Partial<Conversation>) => {
    setConversations((prev) => {
      const updated = prev.map((c) =>
        c.id === id ? { ...c, ...updates, updatedAt: Date.now() } : c
      );
      apiUpdateConversation(id, { ...updates, updatedAt: Date.now() });
      if (updates.messages) {
        // Gắn conversationId vào từng message trước khi lưu DB
        const taggedMessages = updates.messages.map(m => ({ ...m, conversationId: id }));
        apiSaveMessages(taggedMessages);
      }
      return updated;
    });
  };

  const handleSendMessage = async (content: string, type?: "manager_note") => {
    if (!token) return;

    let targetConvId = activeId;
    let currentConv = conversations.find(c => c.id === activeId);

    // Create new conversation if none active
    if (!targetConvId || !currentConv) {
      currentConv = createConversation(viewingAgentId);
      currentConv.employeeId = employeeId;
      targetConvId = currentConv.id;
      setConversations((prev) => [currentConv!, ...prev]);
      setActiveId(targetConvId);
      await apiCreateConversation(currentConv);
    }

    const newSystemMessage = createMessage(type === "manager_note" ? "manager" : "user", content, type);
    newSystemMessage.conversationId = targetConvId;
    const updatedMessages = [...currentConv.messages, newSystemMessage];

    let title = currentConv.title;
    if (currentConv.messages.length === 0) {
      title = generateConversationTitle(updatedMessages);
    }

    updateConversation(targetConvId, {
      messages: updatedMessages,
      title
    });

    const aiMessageId = `msg_${Date.now()}_ai`;
    const ctrl = new AbortController();

    // Đăng ký streaming state cho conversation này
    streamingMapRef.current.set(targetConvId, { messageId: aiMessageId, controller: ctrl });
    setStreamingConvIds(prev => new Set(prev).add(targetConvId));

    const aiPlaceholder = { id: aiMessageId, role: "assistant" as const, content: "", timestamp: Date.now(), conversationId: targetConvId };
    updateConversation(targetConvId, {
      messages: [...updatedMessages, aiPlaceholder]
    });

    let aiContent = "";
    const convId = targetConvId; // capture for closure

    const cleanupStreaming = () => {
      streamingMapRef.current.delete(convId);
      setStreamingConvIds(prev => {
        const next = new Set(prev);
        next.delete(convId);
        return next;
      });
    };

    try {
      await streamChatCompletion({
        token,
        agentId: currentConv.agentId,
        sessionKey: currentConv.sessionKey,
        messages: updatedMessages.map(m => ({ role: m.role, content: m.content })),
        signal: ctrl.signal,
        onDelta: (text) => {
          aiContent += text;
          setConversations((prev) =>
            prev.map((c) => {
              if (c.id !== convId) return c;
              const msgs = [...c.messages];
              const lastMsg = msgs[msgs.length - 1];
              if (lastMsg && lastMsg.id === aiMessageId) {
                lastMsg.content = aiContent;
              }
              return c;
            })
          );
        },
        onDone: () => {
          cleanupStreaming();
          setConversations(prev => {
            const currentC = prev.find(c => c.id === convId);
            if (currentC) {
              const lastMsg = currentC.messages.find(m => m.id === aiMessageId);
              if (lastMsg) {
                apiSaveMessages([{ ...lastMsg, conversationId: convId }]);
              }
            }
            return [...prev];
          });
        },
        onError: (err) => {
          console.error("Stream error:", err);
          cleanupStreaming();
          setConversations((prev) => {
            const updated = prev.map((c) => {
              if (c.id !== convId) return c;
              const msgs = [...c.messages];
              const lastMsg = msgs[msgs.length - 1];
              if (lastMsg && lastMsg.id === aiMessageId) {
                lastMsg.content = aiContent + `\n\n**[Lỗi:** ${err.message}**]**`;
              }
              return { ...c, messages: msgs };
            });
            const currentC = updated.find(c => c.id === convId);
            if (currentC) {
              const lastMsg = currentC.messages.find(m => m.id === aiMessageId);
              if (lastMsg) apiSaveMessages([{ ...lastMsg, conversationId: convId }]);
            }
            return updated;
          });
        }
      });
    } catch (err) {
      cleanupStreaming();
    }
  };

  const handleStopStreaming = () => {
    if (activeId && streamingMapRef.current.has(activeId)) {
      const entry = streamingMapRef.current.get(activeId)!;
      entry.controller.abort();
      streamingMapRef.current.delete(activeId);
      setStreamingConvIds(prev => {
        const next = new Set(prev);
        next.delete(activeId!);
        return next;
      });
    }
  };

  return (
    <div className="app-container">
      <Sidebar
        conversations={filteredConversations}
        activeConversationId={activeId}
        onSelectConversation={handleSelectConversation}
        onNewConversation={handleNewConversation}
        onDeleteConversation={handleDeleteConversation}
        employeeName={employeeName}
        employeeId={employeeId}
        onLogout={logout}
        isCollapsed={isSidebarCollapsed}
        onToggle={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
      />

      <main className={`main-content ${isSidebarCollapsed ? "sidebar-collapsed" : ""}`}>
        {/* Header */}
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
                <span className="mobile-header-title">Uptek-AI Chat</span>
                <span className="agent-badge">{currentAgentName}</span>
              </div>
              {availableAgents.length > 1 && (
                <svg className={`dropdown-icon ${showAgentDropdown ? 'open' : ''}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              )}
            </button>

            {showAgentDropdown && availableAgents.length > 1 && (
              <div className="agent-dropdown">
                <div className="agent-dropdown-header">Theo dõi & Chat dưới quyền:</div>
                {availableAgents.map(agent => (
                  <button
                    key={agent.lockedAgentId}
                    className={`agent-option ${viewingAgentId === agent.lockedAgentId ? "selected" : ""}`}
                    onClick={() => {
                      if (agent.lockedAgentId) setViewingAgentId(agent.lockedAgentId);
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

          {/* Main Navigation Modes (Only show for Managers if desired, or everyone) */}
          <div className="header-modes-nav">
            <button
              className={`mode-btn ${appMode === 'chat' ? 'active' : ''}`}
              onClick={() => setAppMode('chat')}
            >
              Phòng Chat
            </button>
            {accessPolicy?.canViewAllSessions && (
              <button
                className={`mode-btn ${appMode === 'dashboard' ? 'active' : ''}`}
                onClick={() => setAppMode('dashboard')}
              >
                Dashboard
              </button>
            )}
          </div>

          <div className="header-spacer" />

          {appMode === 'chat' && (
            <button className="new-chat-icon-button" onClick={handleNewConversation} title="Tạo mới">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          )}
        </div>

        {appMode === 'chat' ? (
          <>
            {isViewingSubordinate && (
              <div className="surveillance-banner">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                  <circle cx="12" cy="12" r="3"></circle>
                </svg>
                <span>Đang giám sát lịch sử chat của <strong>{currentAgentName}</strong></span>
              </div>
            )}
            <ChatArea
              messages={activeConversation?.messages || []}
              isStreaming={activeId ? streamingConvIds.has(activeId) : false}
              streamingMessageId={activeId ? (streamingMapRef.current.get(activeId)?.messageId || null) : null}
              agentId={currentAgentName}
            />

            <div className="input-container-wrapper">
              <MessageInput
                onSend={handleSendMessage}
                isStreaming={activeId ? streamingConvIds.has(activeId) : false}
                onStopStreaming={handleStopStreaming}
                isManagerView={isViewingSubordinate}
              />
            </div>
          </>
        ) : (
          <DashboardArea />
        )}
      </main>
    </div>
  );
}
