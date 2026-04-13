"use client";

import React, { useRef, useEffect } from "react";
import { Message } from "@/lib/types";
import MessageBubble from "./MessageBubble";

interface ChatAreaProps {
  messages: Message[];
  isStreaming: boolean;
  streamingMessageId: string | null;
  agentId: string | null;
}

export default function ChatArea({
  messages,
  isStreaming,
  streamingMessageId,
  agentId
}: ChatAreaProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isStreaming]);

  if (messages.length === 0) {
    return (
      <div className="chat-area">
        <div className="chat-welcome">
          <div className="welcome-icon">
            <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
              <circle cx="32" cy="32" r="30" fill="url(#welcome-grad)" opacity="0.15" />
              <circle cx="32" cy="32" r="20" fill="url(#welcome-grad)" opacity="0.2" />
              <path
                d="M32 16L16 24v16l16 8 16-8V24l-16-8z"
                fill="url(#welcome-grad)"
                opacity="0.6"
              />
              <circle cx="32" cy="32" r="6" fill="white" opacity="0.8" />
              <defs>
                <linearGradient id="welcome-grad" x1="8" y1="8" x2="56" y2="56">
                  <stop stopColor="#818cf8" />
                  <stop offset="0.5" stopColor="#a78bfa" />
                  <stop offset="1" stopColor="#c084fc" />
                </linearGradient>
              </defs>
            </svg>
          </div>
          <h2>Xin chào! Tôi có thể giúp gì cho bạn?</h2>
          <p className="welcome-subtitle">
            Bạn đang kết nối với agent <strong>{agentId || "Uptek-AI"}</strong>. 
            Hãy bắt đầu cuộc trò chuyện!
          </p>
          <div className="welcome-suggestions">
            <div className="suggestion-card">
              <span className="suggestion-icon">💡</span>
              <span>Lên kế hoạch công việc hôm nay</span>
            </div>
            <div className="suggestion-card">
              <span className="suggestion-icon">📝</span>
              <span>Viết nội dung cho chiến dịch mới</span>
            </div>
            <div className="suggestion-card">
              <span className="suggestion-icon">📊</span>
              <span>Phân tích báo cáo hiệu suất</span>
            </div>
            <div className="suggestion-card">
              <span className="suggestion-icon">🎨</span>
              <span>Thiết kế hình ảnh cho social media</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-area" ref={containerRef}>
      <div className="chat-messages">
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            role={msg.role}
            type={msg.type}
            content={msg.content}
            timestamp={msg.timestamp}
            isStreaming={isStreaming}
            isStreamingMessage={isStreaming && msg.id === streamingMessageId}
          />
        ))}
        {isStreaming && !messages.find((m) => m.id === streamingMessageId) && (
          <div className="message-row assistant">
            <div className="message-avatar">
              <div className="avatar-ai">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path d="M10 2L2 7v6l8 5 8-5V7l-8-5z" fill="url(#ai-grad2)" opacity="0.9" />
                  <circle cx="10" cy="10" r="3" fill="white" opacity="0.8" />
                  <defs>
                    <linearGradient id="ai-grad2" x1="2" y1="2" x2="18" y2="18">
                      <stop stopColor="#818cf8" />
                      <stop offset="1" stopColor="#c084fc" />
                    </linearGradient>
                  </defs>
                </svg>
              </div>
            </div>
            <div className="message-content-wrapper">
              <div className="message-sender">Uptek-AI</div>
              <div className="typing-indicator">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
