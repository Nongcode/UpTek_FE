import React, { useState, useEffect } from 'react';
import { loadAllConversationsGlobally, Conversation } from '@/lib/storage';

export default function DashboardArea() {
  const [globalStats, setGlobalStats] = useState({
    totalChats: 0,
    totalMessages: 0,
    activeAgents: 0,
    agentBreakdown: {} as Record<string, number>
  });

  useEffect(() => {
    let mounted = true;
    
    async function loadData() {
      const allConvs = await loadAllConversationsGlobally();
      if (!mounted) return;
      
      let msgsCount = 0;
      const agentsCount: Record<string, number> = {};

      allConvs.forEach(c => {
        msgsCount += (c.messages?.length || 0);
        if (!agentsCount[c.agentId]) {
          agentsCount[c.agentId] = 0;
        }
        agentsCount[c.agentId]++;
      });

      setGlobalStats({
        totalChats: allConvs.length,
        totalMessages: msgsCount,
        activeAgents: Object.keys(agentsCount).length,
        agentBreakdown: agentsCount
      });
    }

    loadData();
    
    return () => { mounted = false; };
  }, []);

  return (
    <div className="dashboard-container">
      <div className="dashboard-header">
        <h1>Command Center Analytics</h1>
        <p>Tổng quan toàn bộ hoạt động của AI Agents trong doanh nghiệp</p>
      </div>

      <div className="stats-grid">
        <div className="stat-card glass-panel">
          <div className="stat-icon">💬</div>
          <div className="stat-info">
            <span className="stat-value">{globalStats.totalChats}</span>
            <span className="stat-label">Tổng Cuộc Hội Thoại</span>
          </div>
        </div>

        <div className="stat-card glass-panel">
          <div className="stat-icon">📄</div>
          <div className="stat-info">
            <span className="stat-value">{globalStats.totalMessages}</span>
            <span className="stat-label">Tổng Tin Nhắn Xử Lý</span>
          </div>
        </div>

        <div className="stat-card glass-panel">
          <div className="stat-icon">🤖</div>
          <div className="stat-info">
            <span className="stat-value">{globalStats.activeAgents}</span>
            <span className="stat-label">Agents Hoạt Động</span>
          </div>
        </div>
      </div>

      <div className="dashboard-sections">
        <div className="glass-panel section-card">
          <h3>Hiệu suất theo Agent</h3>
          <div className="bar-chart">
            {Object.entries(globalStats.agentBreakdown).map(([agentId, count]) => {
              const max = Math.max(...Object.values(globalStats.agentBreakdown));
              const percentage = (count / max) * 100;
              return (
                <div key={agentId} className="bar-row">
                  <div className="bar-label">{agentId}</div>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${percentage}%` }}></div>
                  </div>
                  <div className="bar-value">{count} chats</div>
                </div>
              );
            })}
            {Object.keys(globalStats.agentBreakdown).length === 0 && (
              <p className="empty-text">Chưa có dữ liệu hoạt động</p>
            )}
          </div>
        </div>

        <div className="glass-panel section-card">
          <h3>Quản lý Dự án</h3>
          <p className="empty-text">Tích hợp Kanban board cho các dự án.</p>
          <button className="dashboard-btn" style={{ padding: '0.5rem 1rem', borderRadius: '6px', cursor: 'pointer', background: 'var(--bg-hover)', color: 'white', border: '1px solid var(--border-color)' }}>Tạo Dự Án Mới</button>
        </div>

        <div className="glass-panel section-card" style={{ gridColumn: '1 / -1' }}>
          <h3>Executive Brief (Báo cáo Điểm tin)</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '1rem' }}>
            Tổng hợp nhanh bằng AI toàn bộ các sự kiện, tiến độ dự án, và nút thắt công việc trong 24h qua rải rác ở từng agent.
          </p>
          <button className="dashboard-btn" style={{ padding: '0.5rem 1rem', borderRadius: '6px', cursor: 'pointer', background: 'linear-gradient(90deg, var(--accent-primary), var(--accent-secondary))', color: 'white', border: 'none', fontWeight: 600 }}>Tạo Báo Cáo Điều Hành Ngay</button>
        </div>
      </div>
    </div>
  );
}
