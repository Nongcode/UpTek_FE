"use client";

import React, { memo } from "react";

interface MessageBubbleProps {
  role: "user" | "assistant" | "system" | "manager";
  type?: "regular" | "manager_note" | "approval_request";
  content: string;
  timestamp: number;
  backendToken?: string | null;
  isStreaming?: boolean;
  isStreamingMessage?: boolean;
}

const BACKEND_BASE = "http://localhost:3001";

type MediaAttachment = {
  path: string;
  kind: "image" | "video";
};

function classifyMediaAttachment(filePath: string): MediaAttachment["kind"] | null {
  if (/\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(filePath)) {
    return "image";
  }
  if (/\.(mp4|webm|mov)$/i.test(filePath)) {
    return "video";
  }
  return null;
}

function extractMediaAttachments(text: string): { cleanedText: string; attachments: MediaAttachment[] } {
  const attachments: MediaAttachment[] = [];
  const cleanedLines: string[] = [];

  for (const line of String(text || "").split("\n")) {
    const mediaMatch = line.match(/^MEDIA:\s*["']?(.+?)["']?\s*$/i);
    if (!mediaMatch) {
      cleanedLines.push(line);
      continue;
    }

    const filePath = mediaMatch[1].trim();
    const kind = classifyMediaAttachment(filePath);
    if (!kind) {
      continue;
    }

    attachments.push({ path: filePath, kind });
  }

  return {
    cleanedText: cleanedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    attachments,
  };
}

function buildMediaPreviewUrl(filePath: string, backendToken?: string | null): string {
  const url = new URL(`${BACKEND_BASE}/api/media-preview`);
  url.searchParams.set("path", filePath);
  if (backendToken) {
    url.searchParams.set("token", backendToken);
  }
  return url.toString();
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeLanguage = "";
  let codeContent: string[] = [];
  let blockIndex = 0;

  const processBoldItalic = (textValue: string): React.ReactNode => {
    const boldRegex = /\*\*(.+?)\*\*/g;
    const parts: React.ReactNode[] = [];
    let lastIdx = 0;
    let match: RegExpExecArray | null;
    let partIndex = 0;

    while ((match = boldRegex.exec(textValue)) !== null) {
      if (match.index > lastIdx) {
        parts.push(textValue.slice(lastIdx, match.index));
      }
      parts.push(<strong key={`bold-${partIndex++}`}>{match[1]}</strong>);
      lastIdx = match.index + match[0].length;
    }

    if (lastIdx < textValue.length) {
      parts.push(textValue.slice(lastIdx));
    }

    return parts.length === 1 ? parts[0] : <>{parts}</>;
  };

  const processInline = (line: string): React.ReactNode[] => {
    const parts: React.ReactNode[] = [];
    const codeRegex = /`([^`]+)`/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let partIndex = 0;

    while ((match = codeRegex.exec(line)) !== null) {
      if (match.index > lastIndex) {
        parts.push(
          <span key={`text-${partIndex++}`}>
            {processBoldItalic(line.slice(lastIndex, match.index))}
          </span>,
        );
      }

      parts.push(
        <code key={`code-${partIndex++}`} className="inline-code">
          {match[1]}
        </code>,
      );
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < line.length) {
      parts.push(
        <span key={`text-${partIndex++}`}>
          {processBoldItalic(line.slice(lastIndex))}
        </span>,
      );
    }

    if (parts.length === 0) {
      parts.push(processBoldItalic(line));
    }

    return parts;
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        elements.push(
          <div key={`codeblock-${blockIndex++}`} className="code-block">
            <div className="code-block-header">
              <span className="code-lang">{codeLanguage || "code"}</span>
              <button
                className="copy-button"
                onClick={() => {
                  navigator.clipboard.writeText(codeContent.join("\n"));
                }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                  <path d="M4 2a2 2 0 012-2h6a2 2 0 012 2v6a2 2 0 01-2 2H6a2 2 0 01-2-2V2zm2 8a2 2 0 00-2 2v.5a.5.5 0 01-1 0V12a3 3 0 013-3h.5a.5.5 0 010 1H6z" />
                </svg>
                Copy
              </button>
            </div>
            <pre>
              <code>{codeContent.join("\n")}</code>
            </pre>
          </div>,
        );
        inCodeBlock = false;
        codeLanguage = "";
        codeContent = [];
      } else {
        inCodeBlock = true;
        codeLanguage = line.slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeContent.push(line);
      continue;
    }

    if (line.startsWith("### ")) {
      elements.push(
        <h4 key={`h-${blockIndex++}`} className="md-heading">
          {processInline(line.slice(4))}
        </h4>,
      );
      continue;
    }

    if (line.startsWith("## ")) {
      elements.push(
        <h3 key={`h-${blockIndex++}`} className="md-heading">
          {processInline(line.slice(3))}
        </h3>,
      );
      continue;
    }

    if (line.startsWith("# ")) {
      elements.push(
        <h2 key={`h-${blockIndex++}`} className="md-heading">
          {processInline(line.slice(2))}
        </h2>,
      );
      continue;
    }

    if (/^[-*] /.test(line)) {
      elements.push(
        <div key={`li-${blockIndex++}`} className="md-list-item">
          <span className="md-bullet">•</span>
          <span>{processInline(line.slice(2))}</span>
        </div>,
      );
      continue;
    }

    if (/^\d+\.\s/.test(line)) {
      const numberedMatch = line.match(/^(\d+)\.\s(.*)$/);
      if (numberedMatch) {
        elements.push(
          <div key={`ol-${blockIndex++}`} className="md-list-item">
            <span className="md-number">{numberedMatch[1]}.</span>
            <span>{processInline(numberedMatch[2])}</span>
          </div>,
        );
        continue;
      }
    }

    if (line.trim() === "") {
      elements.push(<div key={`br-${blockIndex++}`} className="md-spacer" />);
      continue;
    }

    elements.push(
      <p key={`p-${blockIndex++}`} className="md-paragraph">
        {processInline(line)}
      </p>,
    );
  }

  return elements;
}

function MessageBubble({
  role,
  type,
  content,
  timestamp,
  backendToken,
  isStreaming,
  isStreamingMessage,
}: MessageBubbleProps) {
  const { cleanedText, attachments } = extractMediaAttachments(content);

  return (
    <div className={`message-row ${role}`}>
      <div className="message-avatar">
        {role === "assistant" ? (
          <div className="avatar-ai">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M10 2L2 7v6l8 5 8-5V7l-8-5z" fill="url(#ai-grad)" opacity="0.9" />
              <circle cx="10" cy="10" r="3" fill="white" opacity="0.8" />
              <defs>
                <linearGradient id="ai-grad" x1="2" y1="2" x2="18" y2="18">
                  <stop stopColor="var(--accent-primary)" />
                  <stop offset="1" stopColor="var(--accent-secondary)" />
                </linearGradient>
              </defs>
            </svg>
          </div>
        ) : (
          <div className="avatar-user">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
              <path d="M9 9a3.5 3.5 0 100-7 3.5 3.5 0 000 7zm0 1.5c-3.315 0-6 1.79-6 4v.5a1 1 0 001 1h10a1 1 0 001-1v-.5c0-2.21-2.685-4-6-4z" />
            </svg>
          </div>
        )}
      </div>
      <div className="message-content-wrapper">
        <div className="message-sender">
          {type === "manager_note"
            ? "Chỉ đạo từ Quản lý"
            : role === "manager"
              ? "Quản lý"
              : role === "assistant"
                ? "Uptek-AI"
                : "Bạn"}
        </div>
        <div className={`message-bubble ${role} ${type === "manager_note" ? "manager-whisper" : ""}`}>
          {role === "assistant" ? (
            <div className={`markdown-body ${isStreamingMessage ? "streaming" : ""}`}>
              {attachments.length > 0 && (
                <div style={{ display: "grid", gap: "12px", marginBottom: cleanedText ? "12px" : 0 }}>
                  {attachments.map((attachment, index) => {
                    const previewUrl = buildMediaPreviewUrl(attachment.path, backendToken);
                    if (attachment.kind === "video") {
                      return (
                        <video
                          key={`${attachment.path}-${index}`}
                          src={previewUrl}
                          controls
                          style={{ width: "100%", maxWidth: "360px", borderRadius: "12px", display: "block" }}
                        />
                      );
                    }

                    return (
                      <img
                        key={`${attachment.path}-${index}`}
                        src={previewUrl}
                        alt="Media preview"
                        loading="lazy"
                        style={{ width: "100%", maxWidth: "180px", borderRadius: "12px", display: "block" }}
                      />
                    );
                  })}
                </div>
              )}
              {cleanedText ? renderMarkdown(cleanedText) : null}
              {isStreaming && (
                <div
                  className="typing-indicator"
                  style={{ display: "inline-flex", marginLeft: "8px", verticalAlign: "middle" }}
                >
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                </div>
              )}
            </div>
          ) : (
            <div className="plain-content">{content}</div>
          )}
        </div>
        <div className="message-time">{formatTime(timestamp)}</div>
      </div>
    </div>
  );
}

export default memo(MessageBubble);
