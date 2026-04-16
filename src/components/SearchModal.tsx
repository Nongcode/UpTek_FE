"use client";

import React, { useMemo, useState } from "react";
import { Conversation } from "@/lib/types";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  conversations: Conversation[];
  onSelectConversation: (id: string) => void;
}

export default function SearchModal({ isOpen, onClose, conversations, onSelectConversation }: Props) {
  const [query, setQuery] = useState("");

  const sorted = useMemo(() => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt), [conversations]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((conv) => {
      if ((conv.title || "").toLowerCase().includes(q)) return true;
      return conv.messages.some((m) => (m.content || "").toLowerCase().includes(q));
    });
  }, [sorted, query]);

  const groupConversations = (source: Conversation[]) => {
    const now = Date.now();
    const today: Conversation[] = [];
    const yesterday: Conversation[] = [];
    const thisWeek: Conversation[] = [];
    const older: Conversation[] = [];
    const dayMs = 86400000;

    source.forEach((conv) => {
      const age = now - conv.updatedAt;
      if (age < dayMs) today.push(conv);
      else if (age < 2 * dayMs) yesterday.push(conv);
      else if (age < 7 * dayMs) thisWeek.push(conv);
      else older.push(conv);
    });

    return { today, yesterday, thisWeek, older };
  };

  const groups = useMemo(() => groupConversations(filtered), [filtered]);

  const getSnippet = (conv: Conversation) => {
    if (!query) return "";
    const q = query.trim().toLowerCase();
    const m = conv.messages.find((m) => (m.content || "").toLowerCase().includes(q));
    if (!m) return "";
    const content = m.content || "";
    const idx = content.toLowerCase().indexOf(q);
    if (idx === -1) return "";
    const start = Math.max(0, idx - 30);
    const end = Math.min(content.length, idx + q.length + 60);
    let snippet = content.substring(start, end).replace(/\n+/g, " ");
    if (start > 0) snippet = "..." + snippet;
    if (end < content.length) snippet = snippet + "...";
    return snippet;
  };

  if (!isOpen) return null;

  return (
    <div className="search-modal-overlay" onMouseDown={onClose}>
      <div className="search-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="search-modal-header">
          <input
            autoFocus
            className="search-modal-input"
            placeholder="Tìm kiếm đoạn chat..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Tìm kiếm đoạn chat"
          />
          <button className="search-modal-close" onClick={onClose} aria-label="Đóng">✕</button>
        </div>

        <div className="search-modal-body">
          {filtered.length === 0 ? (
            <div className="search-empty">Không tìm thấy kết quả cho "{query}"</div>
          ) : (
            <div className="search-groups">
              {groups.today.length > 0 && (
                <div className="search-group">
                  <div className="search-group-label">Hôm nay</div>
                  {groups.today.map((c) => (
                    <div key={c.id} className="search-item" onClick={() => { onSelectConversation(c.id); onClose(); }}>
                      <div className="search-item-title">{c.title}</div>
                      <div className="search-item-snippet">{getSnippet(c)}</div>
                    </div>
                  ))}
                </div>
              )}

              {groups.yesterday.length > 0 && (
                <div className="search-group">
                  <div className="search-group-label">Hôm qua</div>
                  {groups.yesterday.map((c) => (
                    <div key={c.id} className="search-item" onClick={() => { onSelectConversation(c.id); onClose(); }}>
                      <div className="search-item-title">{c.title}</div>
                      <div className="search-item-snippet">{getSnippet(c)}</div>
                    </div>
                  ))}
                </div>
              )}

              {groups.thisWeek.length > 0 && (
                <div className="search-group">
                  <div className="search-group-label">Tuần này</div>
                  {groups.thisWeek.map((c) => (
                    <div key={c.id} className="search-item" onClick={() => { onSelectConversation(c.id); onClose(); }}>
                      <div className="search-item-title">{c.title}</div>
                      <div className="search-item-snippet">{getSnippet(c)}</div>
                    </div>
                  ))}
                </div>
              )}

              {groups.older.length > 0 && (
                <div className="search-group">
                  <div className="search-group-label">Trước đó</div>
                  {groups.older.map((c) => (
                    <div key={c.id} className="search-item" onClick={() => { onSelectConversation(c.id); onClose(); }}>
                      <div className="search-item-title">{c.title}</div>
                      <div className="search-item-snippet">{getSnippet(c)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
