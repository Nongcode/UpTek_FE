"use client";

import React from "react";
import Link from "next/link";

export default function DocsPage() {
  const categories = [
    {
      title: "Thiết lập & Khởi đầu",
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
        </svg>
      ),
      commands: [
        {
          name: "openclaw onboard",
          desc: "Bắt đầu quá trình thiết lập ban đầu (tạo workspace, cấu hình agent mặc định, và thiết lập provider).",
          code: "openclaw onboard --non-interactive",
        },
        {
          name: "openclaw login",
          desc: "Đăng nhập vào hệ thống OpenClaw để xác thực quyền truy cập và nhận gateway token.",
          code: "openclaw login",
        },
      ],
    },
    {
      title: "Vận hành hệ thống",
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
      ),
      commands: [
        {
          name: "openclaw gateway run",
          desc: "Khởi động gateway server để bắt đầu nhận và điều phối các tác vụ của agent.",
          code: "openclaw gateway run --bind loopback --port 18789",
        },
        {
          name: "openclaw gateway restart",
          desc: "Tải lại cấu hình gateway và khởi động lại dịch vụ mà không ngắt kết nối hiện tại.",
          code: "openclaw gateway restart --force",
        },
      ],
    },
    {
      title: "Quản trị & Giám sát",
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      ),
      commands: [
        {
          name: "openclaw gateway status",
          desc: "Kiểm tra trạng thái sức khỏe của gateway và các RPC endpoint đang hoạt động.",
          code: "openclaw gateway status --deep --require-rpc",
        },
        {
          name: "openclaw channels status",
          desc: "Liệt kê tất cả các kênh liên lạc (Telegram, Discord, Slack, v.v.) và trạng thái kết nối của chúng.",
          code: "openclaw channels status --probe",
        },
        {
          name: "openclaw update",
          desc: "Cập nhật OpenClaw lên phiên bản mới nhất từ repository chính thức.",
          code: "openclaw update --branch main",
        },
      ],
    },
  ];

  return (
    <div className="docs-page-wrapper">
      <Link href="/" className="docs-back-button">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="19" y1="12" x2="5" y2="12" />
          <polyline points="12 19 5 12 12 5" />
        </svg>
        <span>Quay lại Chat</span>
      </Link>

      <main className="docs-container">
        <header className="docs-header">
          <h1>Tài liệu Hướng dẫn sử dụng</h1>
          <p>
            Chào mừng bạn đến với hệ thống <strong>OpenClaw</strong>. Đây là danh sách các lệnh cơ bản giúp bạn vận hành và quản lý các agent một cách hiệu quả nhất.
          </p>
        </header>

        <div className="docs-grid">
          {categories.map((category, idx) => (
            <section key={idx} className="docs-section">
              <h2>
                {category.icon}
                {category.title}
              </h2>
              <div className="command-list">
                {category.commands.map((cmd, cIdx) => (
                  <div key={cIdx} className="command-item">
                    <h3>{cmd.name}</h3>
                    <p>{cmd.desc}</p>
                    <div className="command-code-wrapper">
                      <code className="command-code">
                        <span className="tag">$</span> {cmd.code}
                      </code>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        <footer style={{ marginTop: "5rem", textAlign: "center", opacity: 0.5, fontSize: "0.9rem" }}>
          &copy; 2026 OpenClaw AI Ecosystem. Toàn bộ quyền được bảo lưu.
        </footer>
      </main>
    </div>
  );
}
