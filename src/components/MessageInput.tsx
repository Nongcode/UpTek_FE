"use client";

import React, { useEffect, useRef, useState } from "react";

interface MessageInputProps {
  onSend: (content: string, type?: "manager_note") => void;
  isStreaming: boolean;
  onStopStreaming?: () => void;
  isManagerView?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  statusLabel?: string | null;
}

export default function MessageInput({
  onSend,
  isStreaming,
  onStopStreaming,
  isManagerView = false,
  disabled,
  disabledReason,
  statusLabel,
}: MessageInputProps) {
  const [message, setMessage] = useState("");
  const [isManagerNote, setIsManagerNote] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const templates = [
    {
      title: "Bao cao tien do",
      text: "Xin chao sep, toi xin bao cao tien do cong viec hom nay nhu sau:\n1. [Cong viec A]: Hoan thanh.\n2. [Cong viec B]: Dang xu ly.",
    },
    {
      title: "Xin duyet y tuong",
      text: "Vui long xem xet va phe duyet y tuong content/media sau day truoc khi toi bat dau trien khai:\n- Muc tieu: ...\n- Noi dung cot loi: ...",
    },
    {
      title: "Hoi dap chuyen mon",
      text: "Dua vao quy dinh cua cong ty, hay giai thich cho toi quy trinh ...",
    },
  ];

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
  }, [message]);

  useEffect(() => {
    if (!disabled && !isStreaming) {
      textareaRef.current?.focus();
    }
  }, [disabled, isStreaming]);

  const handleSubmit = () => {
    const trimmed = message.trim();
    if (!trimmed || isStreaming || disabled) {
      return;
    }
    onSend(trimmed, isManagerNote ? "manager_note" : undefined);
    setMessage("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
  };

  const placeholder = disabled
    ? (disabledReason || "Tam thoi khong the gui tin nhan...")
    : isStreaming
      ? "Agent dang tra loi. Ban van co the soan ban nhap tiep theo..."
      : "Nhap tin nhan...";

  return (
    <div className="message-input-container">
      <div className="message-input-wrapper">
        <textarea
          ref={textareaRef}
          className="message-textarea"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          disabled={Boolean(disabled)}
        />

        <div className="input-actions">
          <button
            className="action-button icon-btn"
            title="Thu vien lenh"
            onClick={() => setShowTemplates((previous) => !previous)}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
          </button>

          {showTemplates && (
            <div
              className="template-dropdown"
              style={{
                position: "absolute",
                bottom: "100%",
                left: 0,
                width: "300px",
                zIndex: 100,
                display: "flex",
                flexDirection: "column",
                gap: "0.25rem",
                padding: "0.5rem",
                borderRadius: "8px",
                border: "1px solid var(--border-color)",
                background: "var(--bg-panel)",
                boxShadow: "var(--shadow-lg)",
              }}
            >
              <div style={{ padding: "0 0.5rem 0.25rem", fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                THU VIEN LENH
              </div>
              {templates.map((template) => (
                <button
                  key={template.title}
                  style={{
                    background: "transparent",
                    color: "var(--text-primary)",
                    border: "none",
                    textAlign: "left",
                    padding: "0.5rem",
                    cursor: "pointer",
                    borderRadius: "4px",
                  }}
                  onMouseEnter={(event) => {
                    event.currentTarget.style.background = "rgba(255,255,255,0.05)";
                  }}
                  onMouseLeave={(event) => {
                    event.currentTarget.style.background = "transparent";
                  }}
                  onClick={() => {
                    setMessage(template.text);
                    setShowTemplates(false);
                  }}
                >
                  <div style={{ fontWeight: 500, fontSize: "0.85rem" }}>{template.title}</div>
                  <div
                    style={{
                      fontSize: "0.7rem",
                      color: "var(--text-secondary)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {template.text}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {isStreaming ? (
          <button
            className="stop-button"
            onClick={onStopStreaming}
            title="Dung phan hoi"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
              <rect x="4" y="4" width="10" height="10" rx="1" />
            </svg>
          </button>
        ) : (
          <button
            className="send-button"
            onClick={handleSubmit}
            disabled={!message.trim() || isStreaming || Boolean(disabled)}
            title={isStreaming ? "Agent dang tra loi. Bam Dung de gui yeu cau moi." : "Gui tin nhan (Enter)"}
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
        {disabled && disabledReason
          ? disabledReason
          : isStreaming
            ? (statusLabel || "Agent dang tra loi. Ban co the bam Dung hoac tiep tuc soan ban nhap.")
            : "Enter de gui · Shift+Enter xuong dong"}
      </p>

      {isManagerView && (
        <div
          className="manager-options"
          style={{
            marginTop: "0.5rem",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            fontSize: "0.85rem",
            color: "var(--text-secondary)",
          }}
        >
          <input
            type="checkbox"
            id="manager-note"
            checked={isManagerNote}
            onChange={(event) => setIsManagerNote(event.target.checked)}
          />
          <label htmlFor="manager-note" style={{ cursor: "pointer" }}>
            Gui duoi dang ghi chu quan ly
          </label>
        </div>
      )}
    </div>
  );
}
