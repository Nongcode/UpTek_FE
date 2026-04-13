# UpTek-AI Command Center (Frontend)

Mã nguồn này chứa giao diện Điều hành (Command Center) được xây dựng bằng Next.js, nhằm mục đích mở rộng hệ sinh thái OpenClaw (đã rebrand thành UpTek-AI).

## 📊 Tổng hợp các nâng cấp & thay đổi kỹ thuật

### 1. Phía Frontend (Thư mục `UpTek_FE`)
Nhằm chuyển hóa giao diện Chat đơn thuần thành 1 "Trung tâm Điều khiển", hàng loạt file cốt lõi đã được nâng cấp:

- **Bảo mật & Phân quyền (`page.tsx`, `LoginPage.tsx`, `AuthContext.tsx`):**
  - Giám đốc (Có mã `employeeId` là `main` hoặc `admin`) bị "cấm" dùng Frontend nhánh này. Khi đăng nhập, trình duyệt sẽ tự động chuyển hướng (**Redirect**) thẳng góc về backend quản trị gốc tại `http://localhost:18789/`. Điều này giúp đảm bảo sự an toàn và phân tách quyền lực tuyệt đối.
  - Giao diện Login loại bỏ danh sách tài khoản dùng thử (Quick Login), chỉ giữ lại chức năng đăng nhập với bảo mật cao. Nạp trực tiếp Logo của công ty cấu hình từ Server.

- **Dashboard Phân tích Tổng quan (`DashboardArea.tsx`, `page.tsx`):**
  - Xây dựng Component Dashboard theo dõi hiệu suất, số lượng tin nhắn, và tổng quan nhân sự bằng cách "lắng nghe" toàn bộ luồng hội thoại từ bộ nhớ đệm (localStorage scan).
  - Có sẵn Placeholder (Chính tả) cho báo cáo "Executive Brief" và quản lý dự án (Project).

- **Sư tôn điểm chỉ / Manager Whisper (`MessageInput.tsx`, `MessageBubble.tsx`):**
  - Khi một người làm Quản lý "nhảy" vào phiên chat của nhân sự cấp dưới, họ có thể tick chọn chế độ `[x] Ghi chú Quản lý (Whisper)`.
  - Khung viền tin nhắn sẽ hóa Vàng rực, gắn nhãn "Chỉ đạo từ Quản lý" giúp phân ranh giới rạch ròi với AI và người dùng thao tác.

- **Thư viện Kịch bản lệnh Doanh nghiệp (`MessageInput.tsx`):**
  - Bổ sung icon Thư viện gần khung Input chữ. Bấm vào sẽ sổ ra danh sách Mẫu nhập liệu tiêu chuẩn của công ty (VD: Báo cáo tiến độ, Trình duyệt ý tưởng).

- **Kiến trúc Dữ liệu Cục bộ (`storage.ts`, `types.ts`):** 
  - Gọt dũa lại interface `Message` và `Conversation`. Bổ sung thêm biến `type`, `projectId`. 
  - Khai báo các hàm tổng hợp dữ liệu `loadAllConversationsGlobally` để cấp số liệu cho Biểu đồ thống kê.

### 2. Phía Backend (Lõi `OpenClaw Gateway`)
Sự điều chỉnh nằm chủ yếu ở file cấu hình máy chủ:
- **CORS Configuration (`openclaw.json`):** 
  - Đường dẫn `http://localhost:3000` (địa chỉ của Next.js Front-end này) đã được cấp quyền `allowedOrigins` trong phần `controlUi`, cho phép API từ frontend này chọt sang Cổng (Gateway) `18789` của backend để kéo dữ liệu cấu hình, gọi LLM, và stream Chat thoải mái không bị Block CORS.

---

## 🚀 Hướng dẫn Chạy (Run)

1. Khởi động Backend (OpenClaw):
   Tại thư mục gốc `openclaw`:
   ```bash
   pnpm gateway:watch
   ```

2. Khởi động Frontend (Nơi này):
   Tại thư mục `UpTek_FE`:
   ```bash
   npm run dev
   ```
   Sau đó truy cập `http://localhost:3000` trên trình duyệt. Truy cập bằng tài khoản `quanly@openclaw.local` để xem đầy đủ tính năng Dashboard & Whisper. Tải khoản `admin / boss / main` truy cập vào đây bị chuyển tới cổng 18789.
