"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";

export default function DocsPage() {
  const [activeSection, setActiveSection] = useState("muc-dich");

  const navLinks = [
    { id: "muc-dich", label: "1. Mục đích tài liệu" },
    { id: "truy-cap", label: "2. Thông tin truy cập" },
    { id: "nguyen-tac", label: "3. Nguyên tắc sử dụng" },
    { id: "vai-tro", label: "4. Vai trò Agent" },
    { id: "luong-van-hanh", label: "5. Luồng tổng quát" },
    { id: "quy-trinh", label: "6. Quy trình chi tiết" },
    { id: "phan-hoi", label: "7. Cách phản hồi đúng" },
    { id: "loi-thuong-gap", label: "8. Lỗi thường gặp" },
    { id: "mau-cau-lenh", label: "9. Mẫu câu lệnh" },
    { id: "khuyen-nghi", label: "10. Khuyến nghị vận hành" },
    { id: "tom-tat", label: "11. Tóm tắt quy trình" },
    { id: "ket-luan", label: "12. Kết luận" },
  ];

  useEffect(() => {
    const handleScroll = () => {
      const sections = navLinks.map(link => document.getElementById(link.id));
      const scrollPosition = window.scrollY + 100;

      for (let i = sections.length - 1; i >= 0; i--) {
        const section = sections[i];
        if (section && section.offsetTop <= scrollPosition) {
          setActiveSection(navLinks[i].id);
          break;
        }
      }
    };

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const roles = [
    {
      id: "Phó phòng",
      icon: "💼",
      tasks: [
        "Nhận yêu cầu trực tiếp từ người dùng",
        "Điều phối nhân viên theo từng bước",
        "Gửi kết quả nội dung/ảnh/video để duyệt",
        "Nhận góp ý và tiếp tục triển khai/xuất bản",
      ],
    },
    {
      id: "nv_content",
      icon: "✍️",
      tasks: [
        "Nghiên cứu và viết nội dung nháp",
        "Chỉnh sửa nội dung theo feedback",
        "Tối ưu câu chữ theo tone và mục tiêu",
      ],
    },
    {
      id: "nv_media",
      icon: "📸",
      tasks: [
        "Chuẩn hóa brief hình ảnh",
        "Tạo ảnh minh họa theo yêu cầu",
        "Chỉnh sửa ảnh khi có phản hồi",
      ],
    },
    {
      id: "nv_prompt",
      icon: "⌨️",
      tasks: [
        "Viết prompt tối ưu cho công cụ tạo ảnh",
        "Viết prompt tối ưu cho công cụ tạo video",
        "Hỗ trợ bộ phận Media tạo đúng sản phẩm",
      ],
    },
    {
      id: "media_video",
      icon: "🎬",
      tasks: [
        "Chuẩn hóa brief video từ nội dung/ảnh",
        "Tạo video chuyên nghiệp theo yêu cầu",
        "Chỉnh sửa video theo feedback",
      ],
    },
  ];

  const steps = [
    { title: "Giao yêu cầu", content: "Người dùng gửi brief rõ ràng về sản phẩm, mục tiêu, tone giọng cho Phó phòng." },
    { title: "Duyệt nội dung", content: "Duyệt hoặc yêu cầu sửa bản nháp từ nv_content. Cần rõ ràng về phần muốn sửa." },
    { title: "Tạo & Duyệt ảnh", content: "Hệ thống tự động chuyển sang tạo ảnh sau khi chốt văn bản. Phản hồi màu sắc/bố cục." },
    { title: "Quyết định nhánh", content: "Sau khi duyệt ảnh, chọn tiếp tục Tạo Video, Đăng ngay hoặc Hẹn giờ đăng." },
    { title: "Duyệt video", content: "Nếu chọn tạo video, hãy duyệt/sửa về tốc độ, chuyển cảnh, âm thanh." },
    { title: "Xuất bản & Reset", content: "Đăng bài thành công. BẮT BUỘC gõ /reset để làm sạch ngữ cảnh cho bài mới." },
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
        <header className="docs-header" style={{ textAlign: "left", maxWidth: "none", marginBottom: "3rem" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <div style={{ display: "inline-flex", alignItems: "center", gap: "0.75rem", background: "var(--accent-primary)", color: "white", padding: "0.2rem 0.6rem", borderRadius: "6px", width: "fit-content", fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px" }}>
              Phiên bản 1.0
            </div>
            <h1 style={{ margin: 0, lineHeight: 1.2 }}>HƯỚNG DẪN SỬ DỤNG HỆ THỐNG AGENT</h1>
            <p style={{ margin: 0, fontSize: "1.1rem" }}>Tài liệu bàn giao cho khách hàng cuối • Đối tượng: Phó phòng</p>
          </div>
        </header>

        <div className="docs-content-layout">
          <nav className="docs-sidebar-nav">
            {navLinks.map((link) => (
              <a
                key={link.id}
                href={`#${link.id}`}
                className={`sidebar-nav-link ${activeSection === link.id ? "active" : ""}`}
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById(link.id)?.scrollIntoView({ behavior: "smooth" });
                }}
              >
                {link.label}
              </a>
            ))}
          </nav>

          <section className="docs-main-content">
            {/* 1. Mục đích */}
            <div id="muc-dich" className="doc-section">
              <h2 className="doc-section-title">1. Mục đích tài liệu</h2>
              <p className="doc-text">
                Tài liệu này hướng dẫn người dùng cuối cách sử dụng hệ thống agent theo đúng quy trình vận hành thực tế.
                <strong> Bạn không làm việc trực tiếp với từng nhân viên</strong> mà chỉ cần ra lệnh cho <strong>Phó phòng</strong>.
                Phó phòng sẽ tự động phân việc cho các nhân viên phù hợp ở từng bước để hoàn thành công việc.
              </p>
            </div>

            {/* 2. Thông tin truy cập */}
            <div id="truy-cap" className="doc-section">
              <h2 className="doc-section-title">2. Thông tin truy cập</h2>
              <p className="doc-text">Truy cập hệ thống qua link mạng nội bộ:</p>
              <div className="command-code-wrapper" style={{ marginBottom: "1.5rem" }}>
                <code className="command-code">http://192.168.35.210:18789</code>
              </div>
              <div className="info-box important">
                <div className="info-box-title">⚠️ Yêu cầu bắt buộc</div>
                <p className="doc-text" style={{ fontSize: "0.95rem", margin: 0 }}>
                  1. Truy cập đúng link nêu trên. <br />
                  2. Chọn đúng tài khoản <strong>Phó phòng</strong>. <br />
                  3. Thực hiện toàn bộ trao đổi tại khung chat của Phó phòng.
                </p>
              </div>
            </div>

            {/* 3. Nguyên tắc sử dụng */}
            <div id="nguyen-tac" className="doc-section">
              <h2 className="doc-section-title">3. Nguyên tắc sử dụng</h2>
              <div className="role-grid">
                <div className="role-card">
                  <div className="role-card-title">Chỉ ra lệnh cho Phó phòng</div>
                  <p className="doc-text" style={{ fontSize: "0.9rem" }}>Phó phòng là đầu mối duy nhất tiếp nhận, điều phối và theo dõi tiến trình cho bạn.</p>
                </div>
                <div className="role-card">
                  <div className="role-card-title">Một phiên - Một đầu việc</div>
                  <p className="doc-text" style={{ fontSize: "0.9rem" }}>Nên tập trung xử lý trọn vẹn một bài đăng trước khi bắt đầu yêu cầu mới để tránh nhầm lẫn.</p>
                </div>
              </div>

              <div className="info-box" style={{ borderColor: "var(--accent-secondary)", background: "rgba(192, 132, 252, 0.05)" }}>
                <div className="info-box-title" style={{ color: "var(--accent-secondary)" }}>✨ Quy tắc Vàng: /reset</div>
                <p className="doc-text" style={{ fontSize: "1rem", margin: 0 }}>
                  Sau khi hoàn thành xuất bản mỗi bài đăng, <strong>bắt buộc</strong> nhập lệnh:
                </p>
                <div className="command-code-wrapper" style={{ margin: "1rem 0" }}>
                  <code className="command-code" style={{ color: "var(--accent-secondary)", textAlign: "center", fontSize: "1.2rem" }}>/reset</code>
                </div>
                <p className="doc-text" style={{ fontSize: "0.9rem", margin: 0, opacity: 0.8 }}>
                  Giúp làm sạch ngữ cảnh, tránh đầy Context và đảm bảo Agent xử lý bài tiếp theo một cách chính xác nhất.
                </p>
              </div>
            </div>

            {/* 4. Vai trò Agent */}
            <div id="vai-tro" className="doc-section">
              <h2 className="doc-section-title">4. Vai trò của các agent</h2>
              <div className="role-grid">
                {roles.map(role => (
                  <div key={role.id} className="role-card">
                    <div className="role-card-header">
                      <span style={{ fontSize: "1.5rem" }}>{role.icon}</span>
                      <span className="role-card-title">{role.id}</span>
                    </div>
                    <ul className="role-card-tasks">
                      {role.tasks.map((task, i) => <li key={i}>{task}</li>)}
                    </ul>
                  </div>
                ))}
              </div>
            </div>

            {/* 5. Luồng vận hành */}
            <div id="luong-van-hanh" className="doc-section">
              <h2 className="doc-section-title">5. Luồng vận hành tổng quát</h2>
              <p className="doc-text">Mặc dù bạn chỉ chat với Phó phòng, hệ thống sẽ thực hiện theo chuỗi chuyên môn hóa:</p>
              <div className="workflow-box">
                Sơ đồ: Người dùng ➔ Phó phòng ➔ nv_content ➔ nv_media ➔ nv_prompt ➔ Phó phòng ➔ (Tùy chọn) Video ➔ Đăng bài
              </div>
              <p className="doc-text" style={{ marginTop: "1rem", fontSize: "0.9rem" }}>
                <em>* Lưu ý: Luồng luôn bắt đầu bằng Văn bản ➔ Hình ảnh ➔ Video/Đăng.</em>
              </p>
            </div>

            {/* 6. Quy trình chi tiết */}
            <div id="quy-trinh" className="doc-section">
              <h2 className="doc-section-title">6. Quy trình sử dụng chi tiết</h2>
              <div className="steps-container">
                {steps.map((step, i) => (
                  <div key={i} className="step-item">
                    <div className="step-number">{i + 1}</div>
                    <div className="step-content">
                      <div className="step-title">{step.title}</div>
                      <p className="doc-text" style={{ margin: 0 }}>{step.content}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 7. Phản hồi */}
            <div id="phan-hoi" className="doc-section">
              <h2 className="doc-section-title">7. Cách phản hồi hiệu quả</h2>
              <div className="role-grid">
                <div className="role-card" style={{ borderLeft: "4px solid #22c55e" }}>
                  <div className="role-card-title">Khi muốn Duyệt</div>
                  <p className="doc-text" style={{ fontSize: "0.9rem" }}>"Duyệt nội dung", "Duyệt ảnh", "Bài này ổn", "Đăng ngay".</p>
                </div>
                <div className="role-card" style={{ borderLeft: "4px solid #ef4444" }}>
                  <div className="role-card-title">Khi muốn Sửa</div>
                  <p className="doc-text" style={{ fontSize: "0.9rem" }}>Nói rõ đối tượng + hướng sửa. Vd: "Sửa nội dung cho ngắn hơn", "Sửa ảnh tông màu đỏ".</p>
                </div>
              </div>
            </div>

            {/* 8. Lỗi thường gặp */}
            <div id="loi-thuong-gap" className="doc-section">
              <h2 className="doc-section-title">8. Các lỗi thường gặp và cách tránh</h2>
              <div className="role-grid">
                <div className="role-card">
                  <div className="role-card-title" style={{ color: "#f87171" }}>Nhiều yêu cầu cùng lúc</div>
                  <p className="doc-text" style={{ fontSize: "0.85rem" }}>Đừng trộn nhiều chiến dịch trong 1 luồng chat. Hãy hoàn thành từng bài một.</p>
                </div>
                <div className="role-card">
                  <div className="role-card-title" style={{ color: "#f87171" }}>Góp ý chung chung</div>
                  <p className="doc-text" style={{ fontSize: "0.85rem" }}>Tránh câu "Làm đẹp hơn". Hãy dùng "Bố cục thoáng hơn", "Nền sáng hơn".</p>
                </div>
                <div className="role-card">
                  <div className="role-card-title" style={{ color: "#f87171" }}>Quên gõ /reset</div>
                  <p className="doc-text" style={{ fontSize: "0.85rem" }}>Dễ gây nhầm lẫn ngữ cảnh cho bài tiếp theo. Hãy tạo thói quen Reset khi xong việc.</p>
                </div>
              </div>
            </div>

            {/* 9. Mẫu câu lệnh */}
            <div id="mau-cau-lenh" className="doc-section">
              <h2 className="doc-section-title">9. Mẫu câu lệnh khuyến nghị cho người dùng</h2>
              <div className="command-list" style={{ gap: "1rem" }}>
                <div className="role-card">
                  <strong>Khởi động:</strong> "Viết bài quảng cáo sản phẩm A cho nữ 25-35 tuổi, tone thân thiện."
                </div>
                <div className="role-card">
                  <strong>Sửa ảnh:</strong> "Thêm logo rõ hơn", "Làm ảnh phong cách sang trọng hơn."
                </div>
                <div className="role-card">
                  <strong>Hẹn giờ:</strong> "Hẹn đăng lúc 8h sáng mai", "Lên lịch vào 20:30 ngày 25/04."
                </div>
              </div>
            </div>

            {/* 10. Khuyến nghị vận hành */}
            <div id="khuyen-nghi" className="doc-section">
              <h2 className="doc-section-title">10. Khuyến nghị vận hành để đạt kết quả tốt nhất</h2>
              <div className="role-card" style={{ marginBottom: "1.5rem" }}>
                <p className="doc-text">Để chất lượng đầu ra ngày càng tốt hơn, người dùng nên:</p>
                <ul className="role-card-tasks">
                  <li>Cung cấp brief rõ ràng ngay từ đầu</li>
                  <li>Phản hồi cụ thể khi yêu cầu sửa</li>
                  <li>Dùng cách diễn đạt thống nhất, dễ hiểu</li>
                  <li>Duyệt từng bước rõ ràng thay vì nói quá mơ hồ</li>
                  <li>Luôn reset sau khi hoàn tất</li>
                </ul>
              </div>
              <div className="info-box">
                <p className="doc-text">
                  Ngoài ra, nếu trong quá trình làm việc người dùng có những nguyên tắc lặp đi lặp lại (ví dụ: "Luôn chèn logo", "Tone giọng phải hài hước", "Ưu tiên văn phong gần gũi") thì nên nhắc rõ trong brief hoặc feedback để hệ thống bám sát hơn trong cùng workflow.
                </p>
              </div>
            </div>

            {/* 11. Tóm tắt quy trình */}
            <div id="tom-tat" className="doc-section">
              <h2 className="doc-section-title">11. Tóm tắt quy trình chuẩn</h2>
              <p className="doc-text">Người dùng chỉ cần nhớ 6 bước sau:</p>
              <div className="steps-container">
                <div className="step-item">
                  <div className="step-number">1</div>
                  <div className="step-content">
                    <p className="doc-text" style={{ margin: 0 }}>Truy cập đúng link: <strong>http://192.168.35.210:18789</strong></p>
                  </div>
                </div>
                <div className="step-item">
                  <div className="step-number">2</div>
                  <div className="step-content">
                    <p className="doc-text" style={{ margin: 0 }}>Chọn đúng tài khoản <strong>Phó phòng</strong></p>
                  </div>
                </div>
                <div className="step-item">
                  <div className="step-number">3</div>
                  <div className="step-content">
                    <p className="doc-text" style={{ margin: 0 }}>Gửi yêu cầu công việc cho Phó phòng</p>
                  </div>
                </div>
                <div className="step-item">
                  <div className="step-number">4</div>
                  <div className="step-content">
                    <p className="doc-text" style={{ margin: 0 }}>Duyệt hoặc yêu cầu sửa theo từng bước: <strong>nội dung → ảnh → video (nếu cần)</strong></p>
                  </div>
                </div>
                <div className="step-item">
                  <div className="step-number">5</div>
                  <div className="step-content">
                    <p className="doc-text" style={{ margin: 0 }}>Chọn Đăng ngay hoặc Hẹn giờ</p>
                  </div>
                </div>
                <div className="step-item">
                  <div className="step-number">6</div>
                  <div className="step-content">
                    <p className="doc-text" style={{ margin: 0 }}>Sau khi hoàn thành, nhập <strong>/reset</strong></p>
                  </div>
                </div>
              </div>
            </div>

            {/* 12. Kết luận */}
            <div id="ket-luan" className="doc-section">
              <h2 className="doc-section-title">12. Kết luận</h2>
              <p className="doc-text">
                Hệ thống được thiết kế để người dùng chỉ cần làm việc với Phó phòng, còn toàn bộ phần phân công chuyên môn phía sau sẽ do hệ thống tự vận hành.
              </p>
              <div className="role-card" style={{ borderLeft: "4px solid var(--accent-primary)" }}>
                <p className="doc-text" style={{ fontWeight: 600, color: "var(--text-primary)" }}>Người dùng sẽ đạt hiệu quả cao nhất khi:</p>
                <ul className="role-card-tasks">
                  <li>Giao brief rõ ràng</li>
                  <li>Phản hồi đúng bước</li>
                  <li>Góp ý cụ thể khi cần sửa</li>
                  <li>Không trộn nhiều đầu việc trong cùng một phiên</li>
                  <li>Luôn dùng <strong>/reset</strong> sau khi hoàn tất mỗi bài đăng</li>
                </ul>
              </div>
              <p className="doc-text" style={{ marginTop: "1.5rem" }}>
                Nếu sử dụng đúng theo tài liệu này, người dùng có thể vận hành hệ thống ổn định, hạn chế hiểu nhầm ngữ cảnh và khai thác tốt nhất khả năng phối hợp của các agent.
              </p>
            </div>

            {/* Conclude */}
            <div className="doc-section" style={{ borderTop: "1px solid var(--border-color)", paddingTop: "4rem", textAlign: "center" }}>
              <p className="doc-text">
                Hệ thống được thiết kế để bạn đạt hiệu quả cao nhất với nỗ lực thấp nhất. <br />
                Hãy tuân thủ quy trình để các Agent phục vụ bạn tốt nhất!
              </p>
              <div style={{ marginTop: "2rem", opacity: 0.3, fontSize: "0.8rem" }}>
                &copy; 2026 OpenClaw AI Ecosystem • Tài liệu bàn giao bảo mật
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
