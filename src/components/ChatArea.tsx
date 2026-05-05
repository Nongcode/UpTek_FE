"use client";

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Message } from "@/lib/types";
import MessageBubble from "./MessageBubble";
import StreamingMessage from "./StreamingMessage";
import { StreamingStore } from "@/hooks/useConversations";
import {
  isTerminalStreamPhase,
  StreamState,
  type WorkflowProgressState,
} from "@/hooks/useConversations.helpers";
import { SSEConnectionStatus } from "@/hooks/useSSE";

interface ChatAreaProps {
  conversationId?: string | null;
  messages: Message[];
  isStreaming: boolean;
  streamingMessageId: string | null;
  streamingStore: StreamingStore;
  agentId: string | null;
  backendToken?: string | null;
  streamStatusLabel?: string | null;
  streamState?: StreamState | null;
  workflowProgress?: WorkflowProgressState | null;
  transientError?: string | null;
  onDismissTransientError?: () => void;
  sseStatus?: SSEConnectionStatus;
}

function formatElapsed(startedAt: number | null | undefined): string | null {
  if (!startedAt) {
    return null;
  }
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, "0");
  const seconds = String(elapsedSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function ChatArea({
  conversationId,
  messages,
  isStreaming,
  streamingMessageId,
  streamingStore,
  agentId,
  backendToken,
  streamStatusLabel,
  streamState,
  workflowProgress,
  transientError,
  onDismissTransientError,
  sseStatus = "disconnected",
}: ChatAreaProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const resizeSnapshotRef = useRef({ height: 0, count: 0, lastId: "" });
  const currentMessageSnapshotRef = useRef({ count: 0, lastId: "" });
  const [hasUnreadBelow, setHasUnreadBelow] = useState(false);
  const [heartbeatTick, setHeartbeatTick] = useState(0);
  const hasActiveStreamState = Boolean(
    streamState && !isTerminalStreamPhase(streamState.phase),
  );
  const latestMessageId = messages[messages.length - 1]?.id || "";
  currentMessageSnapshotRef.current = {
    count: messages.length,
    lastId: latestMessageId,
  };

  useEffect(() => {
    if (!hasActiveStreamState && !streamStatusLabel) {
      return;
    }
    const timer = setInterval(() => {
      setHeartbeatTick((previous) => previous + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [hasActiveStreamState, streamStatusLabel]);

  const isNearBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return true;
    }
    return container.scrollHeight - container.scrollTop - container.clientHeight < 120;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const container = containerRef.current;
    if (!container) {
      bottomRef.current?.scrollIntoView({ behavior });
      return;
    }
    container.scrollTo({ top: container.scrollHeight, behavior });
    setHasUnreadBelow(false);
  }, []);

  const scrollToBottomIfNeeded = useCallback(() => {
    shouldAutoScrollRef.current = shouldAutoScrollRef.current || isNearBottom();
    if (!shouldAutoScrollRef.current) {
      setHasUnreadBelow(true);
      return;
    }
    scrollToBottom("auto");
  }, [isNearBottom, scrollToBottom]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) {
      return;
    }
    shouldAutoScrollRef.current = isNearBottom();
    if (shouldAutoScrollRef.current) {
      setHasUnreadBelow(false);
    }
  }, [isNearBottom]);

  useEffect(() => {
    scrollToBottomIfNeeded();
  }, [messages.length, messages[messages.length - 1]?.id, isStreaming, scrollToBottomIfNeeded]);

  useEffect(() => {
    shouldAutoScrollRef.current = true;
    resizeSnapshotRef.current = {
      height: 0,
      ...currentMessageSnapshotRef.current,
    };
    requestAnimationFrame(() => scrollToBottom("auto"));
  }, [conversationId, scrollToBottom]);

  useEffect(() => {
    const container = containerRef.current;
    const messagesElement = messagesRef.current;
    if (!container || !messagesElement || typeof ResizeObserver === "undefined") {
      return;
    }

    resizeSnapshotRef.current = {
      height: container.scrollHeight,
      ...currentMessageSnapshotRef.current,
    };
    const observer = new ResizeObserver(() => {
      const previousSnapshot = resizeSnapshotRef.current;
      const nextHeight = container.scrollHeight;
      const heightDelta = nextHeight - previousSnapshot.height;
      const messageListChanged =
        previousSnapshot.count !== currentMessageSnapshotRef.current.count
        || previousSnapshot.lastId !== currentMessageSnapshotRef.current.lastId;
      resizeSnapshotRef.current = {
        height: nextHeight,
        ...currentMessageSnapshotRef.current,
      };

      if (shouldAutoScrollRef.current || isNearBottom()) {
        shouldAutoScrollRef.current = true;
        scrollToBottom("auto");
        return;
      }

      if (heightDelta !== 0 && !messageListChanged) {
        container.scrollTop += heightDelta;
      }
      setHasUnreadBelow(true);
    });

    observer.observe(messagesElement);
    return () => observer.disconnect();
  }, [isNearBottom, scrollToBottom]);

  const progressSummary = useMemo(() => {
    if (!streamStatusLabel) {
      return null;
    }
    const elapsed = formatElapsed(streamState?.startedAt || null);
    const parts = [streamStatusLabel, elapsed].filter(Boolean);
    return parts.join(" · ");
  }, [heartbeatTick, streamState?.startedAt, streamStatusLabel]);

  const realtimeLabel =
    sseStatus === "connected"
      ? null
      : sseStatus === "reconnecting"
        ? "Dang ket noi lai realtime..."
        : "Realtime dang ngat ket noi.";

  if (messages.length === 0) {
    return (
      <div className="chat-area">
        <div className="chat-welcome">
          <h2>Xin chao</h2>
          <p className="welcome-subtitle">
            Ban dang ket noi voi agent <strong>{agentId || "Uptek-AI"}</strong>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-area" ref={containerRef} onScroll={handleScroll}>
      {(progressSummary || realtimeLabel || transientError) && (
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 8,
            display: "grid",
            gap: "8px",
            padding: "12px 16px",
            background: "var(--bg-primary)",
            borderBottom: "1px solid rgba(148, 163, 184, 0.12)",
            boxShadow: "0 10px 22px rgba(2, 6, 23, 0.20)",
          }}
        >
          {progressSummary && (
            <div
              style={{
                borderRadius: "999px",
                padding: "8px 12px",
                background: "rgba(56, 189, 248, 0.08)",
                border: "1px solid rgba(56, 189, 248, 0.18)",
                color: "var(--text-primary)",
                fontSize: "0.85rem",
              }}
            >
              {progressSummary}
            </div>
          )}
          {realtimeLabel && (
            <div
              style={{
                borderRadius: "12px",
                padding: "8px 12px",
                background: "rgba(245, 158, 11, 0.10)",
                border: "1px solid rgba(245, 158, 11, 0.22)",
                fontSize: "0.82rem",
              }}
            >
              {realtimeLabel}
            </div>
          )}
          {transientError && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                borderRadius: "12px",
                padding: "10px 12px",
                background: "rgba(248, 113, 113, 0.10)",
                border: "1px solid rgba(248, 113, 113, 0.22)",
                fontSize: "0.82rem",
              }}
            >
              <span>{transientError}</span>
              {onDismissTransientError && (
                <button
                  type="button"
                  onClick={onDismissTransientError}
                  style={{ background: "transparent", border: "none", cursor: "pointer", color: "inherit" }}
                >
                  Dong
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="chat-messages" ref={messagesRef}>
        {messages.map((message) => {
          const isStreamingBubble = isStreaming && message.id === streamingMessageId;
          if (isStreamingBubble) {
            return (
              <StreamingMessage
                key={message.id}
                messageId={message.id}
                timestamp={message.timestamp}
                streamingStore={streamingStore}
                onContentChange={scrollToBottomIfNeeded}
              />
            );
          }

          return (
            <MessageBubble
              key={message.id}
              role={message.role}
              type={message.type}
              content={message.content}
              timestamp={message.timestamp}
              backendToken={backendToken}
            />
          );
        })}
        <div ref={bottomRef} />
      </div>

      {hasUnreadBelow && (
        <button
          type="button"
          onClick={() => {
            shouldAutoScrollRef.current = true;
            scrollToBottom("smooth");
          }}
          style={{
            position: "sticky",
            bottom: "20px",
            marginLeft: "auto",
            marginRight: "20px",
            borderRadius: "999px",
            border: "1px solid rgba(59, 130, 246, 0.25)",
            background: "rgba(59, 130, 246, 0.10)",
            padding: "10px 14px",
            cursor: "pointer",
          }}
        >
          Co phan hoi moi ↓
        </button>
      )}
    </div>
  );
}

export default memo(ChatArea);
