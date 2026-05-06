"use client";

import React, { memo } from "react";

interface MessageBubbleProps {
  role: "user" | "assistant" | "system" | "manager";
  type?: "regular" | "manager_note" | "approval_request";
  content: string;
  timestamp: number;
  isStreaming?: boolean;
  isStreamingMessage?: boolean;
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

  const parseTableCells = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());

  const isTableRow = (line: string): boolean => {
    const trimmed = line.trim();
    return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.split("|").length >= 4;
  };

  const isTableSeparator = (line: string): boolean => {
    if (!isTableRow(line)) {
      return false;
    }

    return parseTableCells(line).every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];

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

    if (
      isTableRow(line) &&
      lineIndex + 1 < lines.length &&
      isTableSeparator(lines[lineIndex + 1])
    ) {
      const headers = parseTableCells(line);
      const rows: string[][] = [];
      lineIndex += 2;

      while (lineIndex < lines.length && isTableRow(lines[lineIndex])) {
        rows.push(parseTableCells(lines[lineIndex]));
        lineIndex += 1;
      }
      lineIndex -= 1;

      elements.push(
        <div key={`table-${blockIndex++}`} className="md-table-scroll">
          <table className="md-table">
            <thead>
              <tr>
                {headers.map((header, headerIndex) => (
                  <th key={`th-${headerIndex}`}>{processInline(header)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`tr-${rowIndex}`}>
                  {headers.map((_, cellIndex) => (
                    <td key={`td-${rowIndex}-${cellIndex}`}>
                      {processInline(row[cellIndex] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
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
          <span className="md-bullet">{"\u2022"}</span>
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
  isStreaming,
  isStreamingMessage,
}: MessageBubbleProps) {
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
              {renderMarkdown(content)}
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
