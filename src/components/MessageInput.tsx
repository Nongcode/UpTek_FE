"use client";

import React, { useState, useRef, useEffect } from "react";

interface MessageInputProps {
  onSend: (content: string, type?: "manager_note") => void;
  isStreaming: boolean;
  onStopStreaming?: () => void;
  isManagerView?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

export default function MessageInput({
  onSend,
  isStreaming,
  onStopStreaming,
  isManagerView = false,
  disabled,
  disabledReason,
}: MessageInputProps) {
  const [message, setMessage] = useState("");
  const [isManagerNote, setIsManagerNote] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const templates = [
    { title: "Báo cáo tiến độ", text: "Xin chào sếp, tôi xin báo cáo tiến độ công việc hôm nay như sau:\n1. [Công việc A]: Hoàn thành.\n2. [Công việc B]: Đang xử lý." },
    { title: "Xin duyệt ý tưởng", text: "Vui lòng xem xét và phê duyệt ý tưởng content/media sau đây trước khi tôi bắt đầu triển khai:\n- Mục tiêu: ...\n- Nội dung cốt lõi: ..." },
    { title: "Hỏi đáp chuyên môn", text: "Dựa vào quy định của công ty, hãy giải thích cho tôi quy trình ..." }
  ];

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [message]);

  const handleSubmit = () => {
    const trimmed = message.trim();
    if (!trimmed || isStreaming || disabled) return;
    onSend(trimmed, isManagerNote ? "manager_note" : undefined);
    setMessage("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="message-input-container">
      <div className="message-input-wrapper">
        <textarea
          ref={textareaRef}
          className="message-textarea"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? (disabledReason || "Tạm thời không thể gửi tin nhắn...") : "Nhập tin nhắn..."}
          rows={1}
          disabled={isStreaming || disabled}
        />
        <div className="input-actions">
          <button
            className="action-button icon-btn"
            title="Thư viện Lệnh (Business Templates)"
            onClick={() => setShowTemplates(!showTemplates)}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
          </button>
          {showTemplates && (
            <div className="template-dropdown" style={{
              position: 'absolute', bottom: '100%', left: '0', background: 'var(--bg-panel)',
              border: '1px solid var(--border-color)', borderRadius: '8px', padding: '0.5rem',
              boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', gap: '0.25rem',
              width: '300px', zIndex: 100
            }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', padding: '0 0.5rem 0.25rem' }}>THƯ VIỆN LỆNH</div>
              {templates.map((t, idx) => (
                <button
                  key={idx}
                  style={{ background: 'transparent', color: 'var(--text-primary)', border: 'none', textAlign: 'left', padding: '0.5rem', cursor: 'pointer', borderRadius: '4px' }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  onClick={() => {
                    setMessage(t.text);
                    setShowTemplates(false);
                  }}
                >
                  <div style={{ fontWeight: 500, fontSize: '0.85rem' }}>{t.title}</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.text}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        {isStreaming ? (
          <button
            className="stop-button"
            onClick={onStopStreaming}
            title="Dừng phản hồi"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
              <rect x="4" y="4" width="10" height="10" rx="1" />
            </svg>
          </button>
        ) : (
          <button
            className="send-button"
            onClick={handleSubmit}
            disabled={!message.trim() || disabled}
            title="Gửi tin nhắn (Enter)"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 18 18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 15V3M4 8l5-5 5 5" />
            </svg>
          </button>
        )}
      </div>
      <p className="input-hint">
        {disabled && disabledReason ? disabledReason : "Enter để gửi · Shift+Enter xuống dòng"}
      </p>
      {isManagerView && (
        <div className="manager-options" style={{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          <input
            type="checkbox"
            id="manager-note"
            checked={isManagerNote}
            onChange={(e) => setIsManagerNote(e.target.checked)}
          />
          <label htmlFor="manager-note" style={{ cursor: 'pointer' }}>Gửi dưới dạng Ghi chú Quản lý (Whisper)</label>
        </div>
      )}
    </div>
  );
}
