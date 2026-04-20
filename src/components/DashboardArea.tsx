import React, { useState, useEffect } from 'react';
import { loadAllConversationsGlobally, Conversation } from '@/lib/storage';

export default function DashboardArea({ backendToken }: { backendToken: string | null }) {
  const [globalStats, setGlobalStats] = useState({
    totalChats: 0,
    totalMessages: 0,
    activeAgents: 0,
    agentBreakdown: {} as Record<string, number>
  });

  useEffect(() => {
    let mounted = true;
    
    async function loadData() {
      if (!backendToken) return;
      const allConvs = await loadAllConversationsGlobally({ backendToken });
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
  }, [backendToken]);

  return (
    <div className="dashboard-container">
      <div className="dashboard-header">
        <h1>Phân tích Trung tâm Điều hành</h1>
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
                  <div className="bar-value">{count} cuộc chat</div>
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
          <p className="empty-text">Tích hợp bảng Kanban cho các dự án.</p>
          <button className="dashboard-btn" style={{ padding: '0.5rem 1rem', borderRadius: '6px', cursor: 'pointer', background: 'var(--bg-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}>Tạo Dự Án Mới</button>
        </div>
 
        <div className="glass-panel section-card" style={{ gridColumn: '1 / -1' }}>
          <h3>Bản Tin Điều Hành (AI Tổng Hợp)</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '1rem' }}>
            Tổng hợp nhanh bằng AI toàn bộ các sự kiện, tiến độ dự án, và nút thắt công việc trong 24h qua rải rác ở từng agent.
          </p>
          <button 
            className="dashboard-btn primary" 
            style={{ 
              padding: '0.7rem 1.8rem', 
              borderRadius: '12px', 
              cursor: 'pointer', 
              background: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)', 
              color: 'white', 
              border: 'none', 
              fontWeight: 700,
              boxShadow: '0 10px 15px -3px rgba(99, 102, 241, 0.4)',
              transition: 'all 0.3s ease'
            }}
            onMouseOver={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 20px 25px -5px rgba(99, 102, 241, 0.4)'; }}
            onMouseOut={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 10px 15px -3px rgba(99, 102, 241, 0.4)'; }}
          >
            Tạo Báo Cáo Điều Hành Ngay
          </button>
        </div>
      </div>
    </div>
  );
}
