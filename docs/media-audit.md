# Media Audit

Phạm vi: audit toàn bộ codebase trong repo này, gồm Next.js frontend ở `src/`, Express backend ở `backend/src/`, static assets ở `public/`, storage ảnh hiện có ở `backend/storage/images/`, scripts backend và schema SQLite legacy trong `backend/database.sqlite`. Task này chỉ tạo tài liệu, không thay đổi hành vi hệ thống.

## Tóm tắt nhanh

- Luồng ảnh nghiệp vụ tập trung ở thư viện ảnh sản phẩm: frontend `src/app/gallery/page.tsx` upload/render, backend `backend/src/server.js` nhận file/base64, lưu file vào `backend/storage/images/<companyId>/<departmentId>/`, lưu URL tương đối vào bảng PostgreSQL `Images.url`, rồi serve lại qua `/storage/images/...`.
- Chat hiện tại chỉ lưu/render text. Không có upload ảnh trong `MessageInput`, không có parser markdown image trong `MessageBubble`, và schema `Messages.content` chỉ là text.
- Generated media đi vào gallery qua endpoint automation `/api/gallery/agent-upload`, với `source = 'AI'`, `prefix`, `productModel` và `agentId`.
- Company asset hiện có là logo/favicon trong `public/dbc2d982-780a-40a7-9588-5406dac6054d.jpg` và `public/uptek-logo.svg`; UI dùng ảnh JPG trực tiếp.
- Không thấy cleanup/TTL cho file ảnh; file lưu trong `backend/storage/images/` là storage bền vững theo filesystem hiện tại.

## 1. Endpoint và backend logic liên quan tới ảnh

### Static serve

| Endpoint | File | Logic |
| --- | --- | --- |
| `GET /storage/images/*` | `backend/src/server.js` | `app.use('/storage/images', express.static(storageDir))`, với `storageDir = path.join(__dirname, '../storage/images')`. Đây là đường đọc/render ảnh gallery sau upload. Express static tự serve file từ filesystem, không có auth middleware riêng trên route này. |

### User upload gallery

| Endpoint | File | Logic |
| --- | --- | --- |
| `POST /api/gallery/upload` | `backend/src/server.js` | Có `requireBackendAuth`, dùng `upload.array('images', 20)` từ Multer. Frontend gửi `multipart/form-data` với field `images`, `productModel`, và có thể có `companyId`, `departmentId`. |

Chi tiết backend:

- Multer storage dùng `multer.diskStorage` trong `backend/src/server.js`.
- Destination mặc định lấy `companyId` và `departmentId` từ `req.auth`; nếu user là `admin`, `Admin`, `main`, hoặc `giam_doc` thì có thể override bằng `req.body.companyId` và `req.body.departmentId`.
- File được lưu vào `backend/storage/images/<companyId>/<departmentId>/`.
- Tên file là `${Date.now()}_${file.originalname}`.
- Endpoint yêu cầu có ít nhất một file và bắt buộc `productModel`.
- Với mỗi file, backend tạo URL dạng `/storage/images/${companyId}/${departmentId}/${file.filename}`.
- Backend insert record vào bảng `Images` với `source = 'User'`, `uploaderId = auth.employeeId || 'unknown'`, `productModel`, `prefix = null`.
- Response trả `{ success, count, images: [{ id, url }] }`.

### Agent/generated upload gallery

| Endpoint | File | Logic |
| --- | --- | --- |
| `POST /api/gallery/agent-upload` | `backend/src/server.js` | Endpoint automation nhận JSON body chứa ảnh base64. Nếu env `AUTOMATION_SYNC_TOKEN` có cấu hình thì yêu cầu header `x-automation-sync-token` khớp token. |

Chi tiết backend:

- Body nhận `companyId`, `departmentId`, `filename`, `base64Data`, `agentId`, `productModel`, `prefix`.
- `filename`, `base64Data`, `productModel`, và `prefix` là bắt buộc.
- `companyId` mặc định `default_company`, `departmentId` mặc định `default_dept`.
- Backend tạo thư mục `backend/storage/images/<companyId>/<departmentId>/` nếu chưa có.
- Tên file được sanitize bằng `filename.replace(/[^a-zA-Z0-9.\-_]/g, '')`, rồi prefix timestamp.
- File được ghi bằng `fs.writeFileSync(filePath, base64Data, 'base64')`.
- URL lưu DB là `/storage/images/${companyId}/${departmentId}/${safeFilename}`.
- Insert vào bảng `Images` với `source = 'AI'`, `uploaderId = agentId || 'agent'`, `productModel`, `prefix`.
- Response trả `{ success: true, url, id }`.

### Gallery read/list

| Endpoint | File | Logic |
| --- | --- | --- |
| `GET /api/gallery` | `backend/src/server.js` | Có `requireBackendAuth`. User `admin` hoặc `giam_doc` lấy toàn bộ bảng `Images`; user khác chỉ lấy ảnh theo `companyId` của auth, fallback `UpTek`. Sort theo `createdAt DESC`. |

### Các endpoint khác có thể chứa path ảnh trong text nhưng không xử lý ảnh riêng

| Endpoint | File | Ghi chú |
| --- | --- | --- |
| `POST /api/messages` | `backend/src/server.js` | Lưu `Messages.content` dạng text. Không có upload ảnh, không parse URL ảnh, không validate media. Nếu client/agent đưa URL ảnh vào text thì DB chỉ coi là text. |
| `POST /api/automation/agent-event` | `backend/src/server.js` | Lưu `content` automation vào `Messages.content` và sync sang OpenClaw gateway. Không upload/serve ảnh, nhưng content có thể nhắc tới media ở dạng text. |
| `/api/gateway/:path*` rewrite | `next.config.ts`, `src/lib/api.ts` | Frontend proxy chat streaming sang OpenClaw gateway. Code hiện gửi `messages: [{ role, content }]`, không gửi attachment ảnh. |

## 2. Bảng/cột DB đang lưu path/url ảnh

### PostgreSQL đang được backend dùng

Backend dùng `pg` trong `backend/src/database.js` qua `process.env.DATABASE_URL`. Bảng ảnh được tạo trực tiếp khi server start trong `backend/src/server.js`.

| Bảng | Cột | Kiểu | Vai trò |
| --- | --- | --- | --- |
| `Images` | `id` | `VARCHAR(255) PRIMARY KEY` | ID ảnh dạng `img_<timestamp>_<random>`. |
| `Images` | `url` | `TEXT NOT NULL` | URL tương đối để render ảnh, dạng `/storage/images/<companyId>/<departmentId>/<filename>`. Đây là cột path/url ảnh chính. |
| `Images` | `companyId` | `VARCHAR(255)` | Scope công ty, đồng thời là segment thư mục trên filesystem. |
| `Images` | `departmentId` | `VARCHAR(255)` | Scope phòng ban, đồng thời là segment thư mục trên filesystem. |
| `Images` | `source` | `VARCHAR(50)` | Phân biệt `User` và `AI`. |
| `Images` | `uploaderId` | `VARCHAR(255)` | User/agent upload. |
| `Images` | `createdAt` | `BIGINT` | Timestamp upload. |
| `Images` | `productModel` | `VARCHAR(255)` | Model/mã sản phẩm, bắt buộc ở upload hiện tại. |
| `Images` | `prefix` | `VARCHAR(255)` | Prefix cho ảnh AI/generated; user upload đang set `null`. |

`backend/migrate.js` chỉ bổ sung `Images.productModel` và `Images.prefix` nếu thiếu.

### SQLite legacy trong repo

`backend/database.sqlite` tồn tại trong repo, nhưng `backend/src/database.js` hiện không dùng SQLite. Schema SQLite hiện có:

| Bảng | Cột liên quan media | Ghi chú |
| --- | --- | --- |
| `Conversations` | Không có | Chỉ có metadata chat. |
| `Messages` | Không có cột ảnh riêng | Có `content TEXT`, có thể chứa text nhắc tới URL, nhưng không có path/url ảnh có cấu trúc. |

### Filesystem storage

| Vị trí | Nội dung | Ghi chú |
| --- | --- | --- |
| `backend/storage/images/<companyId>/<departmentId>/` | File ảnh upload/generated | Repo hiện có ảnh mẫu dưới `CongTyA/BanGiamDoc`, `CongTyB/BanGiamDoc`, `UpTek/BanGiamDoc`. DB lưu URL tương đối trỏ vào cây này. |
| `public/dbc2d982-780a-40a7-9588-5406dac6054d.jpg` | Logo/favicon JPG | Được frontend tham chiếu trực tiếp bằng `/dbc2d982-780a-40a7-9588-5406dac6054d.jpg`. |
| `public/uptek-logo.svg` | Logo SVG | Có trong public nhưng không thấy component hiện tại render trực tiếp file này. |

## 3. Component frontend đang hiển thị ảnh

| Component/file | Ảnh hiển thị | Ghi chú |
| --- | --- | --- |
| `src/app/gallery/page.tsx` | Gallery images từ API | Fetch `http://localhost:3001/api/gallery`, render từng ảnh bằng `<img src={http://localhost:3001${img.url}} loading="lazy" />`, click mở ảnh gốc bằng `window.open`. |
| `src/app/gallery/page.tsx` | Preview ảnh trước upload | Input `type="file" accept="image/*" multiple`; lọc `file.type.startsWith('image/')`; dùng `FileReader.readAsDataURL` để render preview `<img src={url}>`. |
| `src/app/page.tsx` | Header logo | Render `<img src="/dbc2d982-780a-40a7-9588-5406dac6054d.jpg" ... />`. |
| `src/components/LoginPage.tsx` | Login logo | Render cùng file logo JPG trong `public/`. |
| `src/app/layout.tsx` | Favicon/app icon | Metadata icon trỏ tới `/dbc2d982-780a-40a7-9588-5406dac6054d.jpg`. |
| `src/components/Sidebar.tsx` | Gallery nav icon, user avatar chữ cái | Không render ảnh file; dùng SVG inline và avatar text. |
| `src/components/ChatArea.tsx` | Welcome/avatar SVG inline | Không render ảnh upload; chỉ SVG inline, suggestion text có nghiệp vụ tạo hình ảnh. |
| `src/components/MessageBubble.tsx` | Avatar SVG inline, markdown text | Không render `<img>` từ message content. Markdown renderer tự viết chỉ xử lý text, code, heading, list; không parse markdown image. |

Frontend không dùng `next/image`; tất cả ảnh thực tế được render bằng thẻ `<img>` thường.

## 4. Phân loại ảnh theo nghiệp vụ

### Chat

- Hiện tại không có upload ảnh trong chat UI.
- `MessageInput` chỉ nhận text; `streamChatCompletion` chỉ gửi `messages` với `role` và `content`.
- `Messages.content` trong DB là text. Nếu có URL ảnh trong nội dung thì hệ thống hiện vẫn chỉ render như text, không tự biến thành ảnh.
- Chat avatar là SVG inline hoặc chữ cái, không phải ảnh upload.

### Gallery

- Đây là luồng ảnh chính của app.
- User upload qua `src/app/gallery/page.tsx` -> `POST /api/gallery/upload` -> Multer lưu file -> insert `Images.url` -> render lại trong gallery.
- Gallery filter theo ngày, `productModel`, `prefix`, và tab công ty.
- Gallery hiển thị badge theo `source`: `AI` hoặc user upload.

### Company asset

- Logo/favicon JPG: `public/dbc2d982-780a-40a7-9588-5406dac6054d.jpg`.
- Logo SVG: `public/uptek-logo.svg`, hiện chưa thấy component render trực tiếp.
- Các ảnh gallery cũng được scope theo `companyId` và có thể là tài sản công ty/sản phẩm, nhưng về storage vẫn thuộc bảng `Images`.

### Generated media

- Endpoint automation `/api/gallery/agent-upload` là luồng generated image chính.
- Ảnh generated được gửi vào backend dưới dạng `base64Data`, lưu chung thư mục `backend/storage/images/<companyId>/<departmentId>/`, lưu DB `Images.source = 'AI'`, có `agentId` trong `uploaderId`, và bắt buộc có `productModel` + `prefix`.
- Chưa thấy luồng generated video hoặc media khác trong codebase này.

### Tạm thời

- Frontend preview upload trong `src/app/gallery/page.tsx` tạo data URL bằng `FileReader`; dữ liệu này chỉ nằm trong state `previewUrls` trước khi upload, không lưu DB.
- Không thấy thư mục temp, cleanup job, hoặc TTL cho ảnh backend.
- Không thấy file tạm cho chat/generated media ngoài preview data URL.

## 5. Rủi ro khi migrate

- `/storage/images` đang public qua `express.static` và không có auth riêng. Nếu chuyển sang object storage/CDN, cần quyết định ảnh gallery là public hay phải signed URL theo quyền công ty/phòng ban.
- DB chỉ lưu URL tương đối, không lưu provider/storage key riêng. Migration nên tách rõ `storageKey`, `publicUrl`/`signedUrl`, `bucket`, `mimeType`, `size`, nếu muốn vận hành dài hạn.
- `companyId` và `departmentId` vừa là dữ liệu phân quyền vừa là segment thư mục. Hiện chưa sanitize hai field này trước khi dùng trong `path.join`; admin/high-level role có thể override từ request body. Khi migrate cần validate whitelist/slug để tránh path traversal hoặc bucket key lạ.
- User upload dùng `${Date.now()}_${file.originalname}` và không sanitize `originalname`; có rủi ro tên file chứa ký tự lạ, path separator, Unicode, hoặc trùng tên khi upload đồng thời.
- Multer hiện không có `fileFilter`, không giới hạn kích thước file, và chỉ frontend lọc `image/*`. Client khác có thể upload non-image qua `/api/gallery/upload`.
- Agent upload ghi `base64Data` trực tiếp ra file, không kiểm tra MIME, extension, kích thước, hoặc decode lỗi. Migration nên thêm validation trước khi đưa vào storage mới.
- `Images.url` là nguồn render duy nhất của gallery. Nếu đổi prefix URL hoặc host, cần backfill URL cũ hoặc thêm resolver tương thích để ảnh cũ vẫn render.
- Frontend hardcode `http://localhost:3001` cho gallery API và ảnh. Khi migrate storage/backend host, cần thay bằng config/env hoặc proxy thống nhất.
- `GET /api/gallery` lọc non-admin theo `companyId` nhưng file static `/storage/images/...` không lọc. Người biết URL có thể đọc ảnh khác công ty.
- File và DB không có transaction thật xuyên suốt: user upload file trước rồi mới insert DB; lỗi DB sẽ để lại orphan file. Ngược lại xóa DB không xóa file vì chưa có delete image endpoint.
- Không có cleanup/orphan scanner cho `backend/storage/images`; migration cần xử lý file không có record DB và record DB trỏ file thiếu.
- SQLite `backend/database.sqlite` là legacy nhưng vẫn tracked. Nếu production từng dùng SQLite, cần kiểm tra dữ liệu thật trước khi bỏ qua; file hiện tại không có bảng `Images`.
- Generated images và user uploads đang dùng chung thư mục và bảng, chỉ phân biệt bằng `source`. Nếu policy retention/quyền truy cập khác nhau, migration nên tách loại asset hoặc thêm metadata rõ hơn.
- Preview data URL ở frontend có thể chiếm RAM lớn khi chọn nhiều ảnh lớn; hiện upload tối đa 20 file nhưng không giới hạn tổng dung lượng ở client.
- Chat hiện không render ảnh. Nếu sau migration muốn đưa generated image vào chat, phải bổ sung schema/message renderer rõ ràng thay vì nhét URL vào `Messages.content`.
