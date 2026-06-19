# 14 — Đặc tả chức năng chi tiết (Functional Specification)

> Đặc tả field-level dùng như "prompt triển khai" cho từng chức năng. Mỗi mục gồm: mục tiêu, quyền, đầu vào (ràng buộc Joi), quy tắc nghiệp vụ, đầu ra, lỗi/edge case, acceptance.
>
> Các module đã có thiết kế riêng (Fire-risk → doc 07, Thời tiết/Vệ tinh → doc 08, MobileGIS → doc 09, GeoServer → doc 12/13) chỉ tham chiếu, không lặp lại.
>
> Quy ước chung: base `/api/v1`; auth `Bearer`; response theo `core/success.response.js`; lỗi theo `core/error.response.js`; phân trang `?page=&limit=` (mặc định page=1, limit=10, max 100).

## Mục lục
- [A. Quản trị người dùng & hồ sơ](#a)
- [B. Lớp dữ liệu bản đồ](#b)
- [C. API bản đồ chia sẻ](#c)
- [D. Ảnh vệ tinh (tham chiếu doc 08)](#d)
- [E. Thống kê](#e)
- [F. Phân tích không gian](#f)
- [G. CMS: Tin tức](#g)
- [H. CMS: Văn bản & Bản đồ PDF](#h)
- [I. Phản ánh hiện trường](#i)

---

<a id="a"></a>
## A. Quản trị người dùng & hồ sơ (EP-02)

### A1. Tạo tài khoản (US-010)
- **Quyền:** `system_admin` (mọi vai trò); `so_nnmt` (chỉ tạo `so_nnmt`/`citizen` trong phạm vi sở).
- **Endpoint:** `POST /users`
- **Đầu vào:**
  | Field | Kiểu | Bắt buộc | Ràng buộc |
  |-------|------|:---:|-----------|
  | email | string | ✓ | email hợp lệ, unique (lower) |
  | full_name | string | ✓ | 2–100 ký tự |
  | role_code | enum | ✓ | `system_admin\|ubnd_tinh\|so_nnmt\|citizen` |
  | phone | string | – | regex VN `^0\d{9}$` |
  | district | string | – | bắt buộc nếu phân quyền theo địa bàn |
- **Quy tắc nghiệp vụ:**
  - Sinh mật khẩu tạm + đặt `must_change_password = true` (migration 009).
  - Gửi email kích hoạt nếu `REQUIRE_EMAIL_VERIFICATION=true`.
  - `so_nnmt` KHÔNG được tạo `system_admin`/`ubnd_tinh` (chặn leo thang quyền).
- **Đầu ra:** `201` `{ data: { user } }` (không trả password_hash).
- **Lỗi/edge:** `409 EMAIL_EXISTS`; `403 ROLE_NOT_ALLOWED`; email trùng kể cả khác hoa/thường.
- **Acceptance:** tạo thành công → user `is_active=true`, nhận email; `so_nnmt` tạo admin → 403.

### A2. Danh sách user (US-012)
- **Quyền:** `system_admin`, `so_nnmt`.
- **Endpoint:** `GET /users?page=&limit=&role=&status=&q=`
- **Đầu vào (query):** `role` (enum), `status` (`active|locked|deleted`), `q` (tìm theo email/tên, ≥2 ký tự).
- **Quy tắc:** `so_nnmt` chỉ thấy user cùng địa bàn/sở; mặc định ẩn `deleted_at IS NOT NULL` trừ khi `status=deleted`.
- **Đầu ra:** `OK_LIST` items + `metadata.pagination`.
- **Edge:** `q` rỗng → bỏ lọc; `limit>100` → ép 100.

### A3. Đổi vai trò (US-010)
- **Quyền:** `system_admin`.
- **Endpoint:** `PATCH /users/:id/role` — body `{ role_code }`.
- **Quy tắc:** không cho tự hạ quyền admin cuối cùng (giữ ≥1 `system_admin` active); ghi audit log.
- **Lỗi:** `409 LAST_ADMIN`; `404 USER_NOT_FOUND`.

### A4. Khóa/mở tài khoản (US-010)
- **Quyền:** `system_admin`, `so_nnmt` (phạm vi).
- **Endpoint:** `PATCH /users/:id/active` — body `{ is_active: boolean, reason? }`.
- **Quy tắc:** khóa → revoke toàn bộ refresh token của user (đăng xuất mọi phiên). Không tự khóa chính mình.

### A5. Cấp lại mật khẩu (US-010)
- **Quyền:** `system_admin`, `so_nnmt`.
- **Endpoint:** `POST /users/:id/reset-password`.
- **Quy tắc:** sinh mật khẩu tạm + `must_change_password=true` + gửi email; revoke phiên cũ.

### A6. Xóa mềm user (US-010)
- **Quyền:** `system_admin`, `so_nnmt`.
- **Endpoint:** `DELETE /users/:id`.
- **Quy tắc:** set `deleted_at=NOW()` (migration 010), KHÔNG xóa cứng; revoke token; giữ ràng buộc dữ liệu (phản ánh/tin do user tạo vẫn còn). Không xóa admin cuối.

### A7. Hồ sơ cá nhân (US-011)
- **Quyền:** mọi user (chính chủ).
- **Endpoint:** `GET /users/me/profile`, `PATCH /users/me/profile`.
- **Đầu vào PATCH:** `full_name`, `phone`, `avatar` (upload, ≤ `UPLOAD_IMAGE_MAX_MB=5`MB, `image/*`).
- **Quy tắc:** không cho sửa `email`/`role` qua endpoint này; avatar lưu `/uploads`.

---

<b id="b"></b>
## B. Lớp dữ liệu bản đồ (EP-03)

### B1. CRUD metadata lớp (US-020)
- **Quyền:** `system_admin` (CRUD); `so_nnmt` (lớp thuộc chuyên ngành rừng/MT).
- **Endpoints:** `POST /map/layers`, `GET /map/layers`, `GET /map/layers/:code`, `PATCH /map/layers/:code`, `DELETE /map/layers/:code`.
- **Đầu vào (POST):**
  | Field | Kiểu | Bắt buộc | Ràng buộc |
  |-------|------|:---:|-----------|
  | code | string | ✓ | slug `^[a-z0-9_]+$`, unique |
  | name_vi | string | ✓ | 2–150 |
  | name_en | string | – | |
  | geom_type | enum | ✓ | POINT/LINESTRING/POLYGON/RASTER |
  | category | enum | – | rung/hanh_chinh/tram_kiem_lam/... |
  | is_public | bool | – | mặc định false |
  | source_type | enum | – | postgis/geoserver/external (mặc định postgis) |
  | style | object | – | JSON style Mapbox |
  | min_zoom/max_zoom | int | – | 0–22 |
- **Quy tắc:** đổi `is_public` ghi audit; xóa lớp → kiểm tra ràng buộc (nếu đã publish GeoServer phải unpublish trước, doc 12 §4).
- **Lỗi:** `409 CODE_EXISTS`; `409 LAYER_PUBLISHED` (xóa khi còn publish).

### B2. Import dữ liệu (US-021)
- **Quyền:** `system_admin`, `so_nnmt`.
- **Endpoint:** `POST /map/layers/:code/import` (multipart).
- **Đầu vào:** file `.zip` (shapefile), `.geojson`, hoặc `.xlsx` (có cột lat/lng hoặc WKT); param `srid` (mặc định 4326), `mode` (`append|replace`).
- **Quy tắc nghiệp vụ:**
  - Validate định dạng + SRID; reproject về 4326 nếu khác.
  - Validate geometry hợp lệ (`ST_IsValid`), tự sửa nhẹ (`ST_MakeValid`) hoặc báo lỗi từng dòng.
  - `replace` → xóa feature cũ của lớp trong transaction; `append` → thêm.
  - Trả báo cáo: tổng dòng, thành công, lỗi (kèm số dòng + lý do).
- **Đầu ra:** `200 { data: { inserted, failed, errors: [{row, reason}] } }`.
- **Lỗi/edge:** file > giới hạn (`UPLOAD_DOCUMENT_MAX_MB`), SRID không xác định, geometry rỗng, encoding tên cột tiếng Việt (UTF-8).
- **Acceptance:** import 100 polygon hợp lệ → 100 inserted; 1 polygon self-intersect → ghi vào `errors`, không rollback toàn bộ nếu `mode=append`.

### B3. Truy vấn feature theo bbox (US-022)
- **Quyền:** public (lớp `is_public`), còn lại cần quyền.
- **Endpoint:** `GET /map/layers/:code/features?bbox=minLng,minLat,maxLng,maxLat&zoom=&limit=`
- **Quy tắc:** `ST_Intersects(geom, ST_MakeEnvelope(bbox,4326))`; LIMIT theo zoom (zoom thấp → đơn giản hóa `ST_SimplifyPreserveTopology`); trả GeoJSON FeatureCollection.
- **Lỗi/edge:** thiếu bbox → 400; bbox quá lớn ở zoom thấp → ép giới hạn feature + cảnh báo `truncated:true` trong metadata.

### B4. Feature-info / popup (US-023)
- **Endpoint:** `GET /map/layers/:code/feature-info?lng=&lat=` hoặc `?id=`.
- **Quy tắc:** với điểm click, tìm feature gần nhất trong bán kính theo zoom (`ST_DWithin`), trả thuộc tính.

### B5. Layer switcher / lớp nền / 3D (US-026) — frontend
- Trả danh sách lớp khả dụng theo quyền (`GET /map/layers`); FE Mapbox quản lý bật/tắt, lớp nền (vệ tinh/đường phố), terrain 3D. Không cần endpoint riêng ngoài B1.

---

<c id="c"></c>
## C. API bản đồ chia sẻ (US-025)
- **Quyền:** `system_admin` tạo/cấp; bên thứ ba dùng `api_key`.
- **Endpoints:** `POST /map-apis`, `GET /map-apis`, `PATCH /map-apis/:id`, `DELETE /map-apis/:id`.
- **Đầu vào (POST):** `name`, `layer_id`, `scope` (`{ read:true, bbox_limit?, rate_per_min? }`), `is_active`.
- **Quy tắc:** sinh `api_key` ngẫu nhiên 64 ký tự (lưu hashed); request kèm header `X-Map-Api-Key`; middleware riêng kiểm key + scope + rate-limit; chỉ cho phép GET feature/tile.
- **Lỗi:** `401 INVALID_API_KEY`; `403 SCOPE_DENIED`; `429` vượt rate.

---

<d id="d"></d>
## D. Ảnh vệ tinh
> Đã đặc tả chi tiết tại **doc 08 phần B** (search/indices/compare/classify) và **doc 13** (GeoTIFF→GeoServer). Xem chéo.

---

<e id="e"></e>
## E. Thống kê (EP-07)

### E1. Diện tích lớp phủ theo huyện/thời gian (US-060)
- **Quyền:** `so_nnmt`, `ubnd_tinh` (xem); public (số liệu đã công bố).
- **Endpoint:** `GET /stats/landcover?by=district&from=&to=&forest_type=`
- **Quy tắc:** aggregate `SUM(ST_Area(geom::geography))/10000` (ha) join ranh giới hành chính; nhóm theo `district` + mốc thời gian.
- **Đầu ra:** mảng `{ district, period, area_ha, change_pct }` + dữ liệu cho biểu đồ.
- **Edge:** khoảng thời gian không có dữ liệu → trả 0 + cờ `no_data`.

### E2. Dashboard điều hành (US-063)
- **Quyền:** `ubnd_tinh`, `system_admin`.
- **Endpoint:** `GET /stats/dashboard` + `GET /stats/dashboard/export?format=pdf|xlsx`.
- **Đầu ra:** tổng hợp: số cảnh báo cháy theo cấp, diện tích rừng, số phản ánh theo trạng thái, top huyện nguy cơ.
- **Quy tắc:** cache kết quả (TTL 5–15 phút); export tạo file tải về.

---

<f id="f"></f>
## F. Phân tích không gian (EP-07)

### F1. Thay đổi rừng giữa 2 mốc (US-061)
- **Quyền:** `so_nnmt`.
- **Endpoint:** `POST /spatial/forest-change` — body `{ from_date, to_date, region_geom? }`.
- **Quy tắc:** so sánh NDVI/NBR 2 thời điểm (qua GEE hoặc raster đã lưu); xác định vùng suy giảm (ΔNDVI < ngưỡng); trả GeoJSON vùng thay đổi + diện tích.
- **Edge:** thiếu ảnh 1 trong 2 mốc (mây) → báo `insufficient_imagery`.

### F2. Khoảng cách dân cư–rừng (US-062)
- **Endpoint:** `GET /spatial/residential-distance?threshold_m=500`
- **Quy tắc:** `ST_DWithin`/`ST_Distance` giữa lớp dân cư và ranh giới rừng; trả khu dân cư trong ngưỡng (vùng giáp ranh nguy cơ).

---

<g id="g"></g>
## G. CMS: Tin tức (EP-08)

### G1. CRUD tin tức (US-070)
- **Quyền:** `system_admin`, `so_nnmt` (đăng chuyên ngành).
- **Endpoints:**
  - `POST /news`: Tạo tin mới (metadata + bản dịch đầu tiên, upload cover).
  - `GET /news/admin/:id`: Chi tiết tin phía admin (kèm đầy đủ bản dịch).
  - `PATCH /news/admin/:id`: Cập nhật metadata chung (status, cover).
  - `PUT /news/admin/:id`: Cập nhật gộp metadata + tất cả bản dịch.
  - `DELETE /news/:id`: Xóa tin (soft delete).
  - `GET /news`: Lấy danh sách tin public (chỉ lấy published).
  - `GET /news/:slug`: Lấy chi tiết tin public theo slug.
- **Đầu vào (POST):**
  | Field | Kiểu | Bắt buộc | Ràng buộc |
  |-------|------|:---:|-----------|
  | title | string | ✓ | 5–255 |
  | content | string(html) | ✓ | sanitize HTML (chống XSS) |
  | cover | file | – | image, ≤5MB |
  | status | enum | – | draft/published (mặc định draft) |
- **Quy tắc:** sinh `slug` từ title (unique, bỏ dấu); set `published_at` khi chuyển `published`; cập nhật `search_tsv` (full-text VN). **Sanitize HTML bắt buộc.**
- **Lỗi:** `409 SLUG_EXISTS` (tự thêm hậu tố `-2`).

### G2. Đọc / tìm kiếm (US-071)
- **Endpoint:** `GET /news?q=&page=&limit=` — full-text `search_tsv @@ plainto_tsquery`.
- **Quy tắc:** public chỉ thấy `published`; sắp theo `published_at DESC`.

### G3. Bình luận (US-071)
- **Quyền:** `citizen` đã đăng nhập mới được tạo bình luận; public chỉ được xem bình luận đã duyệt.
- **Endpoints:**
  - `GET /news/:id/comments` — public xem danh sách bình luận đã duyệt của tin `published`.
  - `POST /news/:id/comments` — `citizen` gửi body `{ content }` (1–1000 ký tự, sanitize) cho tin `published`.
  - `PATCH /comments/:id/approve` — `system_admin`/`so_nnmt` duyệt hoặc từ chối bình luận.
  - `DELETE /comments/:id` — `system_admin`/`so_nnmt` hoặc chính người tạo xóa bình luận.
- **Quy tắc:** không cho comment/list public trên tin `draft`; `is_approved=false` mặc định → chờ duyệt (chống spam).

---

<h id="h"></h>
## H. CMS: Văn bản & Bản đồ PDF (US-072, US-073)
- **Quyền:** `system_admin`, `so_nnmt` (upload); public xem `is_public`.
- **Endpoints:**
  - `POST /documents`: Upload tài liệu mới (metadata + bản dịch đầu tiên + file).
  - `GET /documents/admin/:id`: Chi tiết tài liệu phía admin (kèm đầy đủ bản dịch).
  - `PATCH /documents/admin/:id`: Cập nhật metadata chung (docType, isPublic).
  - `PUT /documents/admin/:id`: Cập nhật gộp metadata + tất cả bản dịch.
  - `DELETE /documents/:id`: Xóa tài liệu (soft delete).
  - `GET /documents`: Lấy danh sách tài liệu public (chỉ lấy public hoặc theo quyền).
  - `GET /documents/:id`: Lấy chi tiết tài liệu public theo ID.
- **Đầu vào (POST):** `title`, `doc_type` (`bao_cao|van_ban|pdf_map`), file (PDF/DOCX/XLSX, ≤ `UPLOAD_DOCUMENT_MAX_MB=20`MB), `is_public`.
- **Quy tắc:** lưu file qua `uploadDocument` → `public/uploads/documents/YYYY/MM/`; DB lưu `file_url` tương đối; kiểm MIME thực (không chỉ đuôi file); `pdf_map` cho phép tải về + xem inline.
- **Lỗi:** `415 UNSUPPORTED_FILE_TYPE`; vượt dung lượng.

---

<i id="i"></i>
## I. Phản ánh hiện trường (EP-09)

### I1. Gửi phản ánh (US-080)
- **Quyền:** `citizen` (đăng nhập) + **ẩn danh** qua header `x-anonymous-id`.
- **Endpoint:** `POST /feedback` (multipart).
- **Đầu vào:**
  | Field | Kiểu | Bắt buộc | Ràng buộc |
  |-------|------|:---:|-----------|
  | category | enum | ✓ | chay_rung/vi_pham/hien_trang |
  | title | string | ✓ | 5–255 |
  | description | string | – | ≤2000 |
  | lng,lat | number | ✓ | trong bbox Kon Tum |
  | media[] | file[] | – | ảnh/video, ≤`UPLOAD_MAX_FILES=20`, ảnh ≤5MB / video ≤100MB |
  | client_uuid | string | – | dedupe offline (doc 09 §5) |
- **Quy tắc:**
  - Lưu media qua `uploadMedia` (ảnh+video) → `public/uploads/...`; DB `media_urls` lưu mảng đường dẫn tương đối `/uploads/...`.
  - Tạo `field.feedback` status=`new`, geom point 4326.
  - Nếu `category=chay_rung` và gần vùng nguy cơ ≥ cấp 4 → gắn cờ ưu tiên + broadcast WebSocket cho `so_nnmt`.
  - Dedupe theo `client_uuid` (tránh gửi trùng khi sync lại).
- **Đầu ra:** `201 { data: { feedback_id, status } }`.
- **Lỗi/edge:** tọa độ ngoài tỉnh → 422; vượt số file; ẩn danh thiếu `x-anonymous-id` → 400.

### I2. Xử lý phản ánh (US-081)
- **Quyền:** `so_nnmt` (lĩnh vực rừng); `system_admin`.
- **Endpoint:** `PATCH /feedback/:id/status` — body `{ to_status, note }`.
- **Quy tắc:** chuyển trạng thái hợp lệ `new→in_progress→resolved` (không nhảy ngược trừ admin); ghi `field.feedback_status_log`; thông báo người gửi (push/email nếu có).
- **Lỗi:** `409 INVALID_TRANSITION`.

### I3. Danh sách & bản đồ phản ánh (US-082)
- **Quyền:** `ubnd_tinh` (toàn tỉnh, xem), `so_nnmt` (xử lý).
- **Endpoints:** `GET /feedback?status=&category=&district=&page=`, `GET /feedback/map?bbox=` (GeoJSON).
- **Quy tắc:** lọc theo trạng thái/khu vực; phân trang.

### I4. Theo dõi phản ánh của tôi (US-083)
- **Quyền:** `citizen` (chính chủ / theo `x-anonymous-id`).
- **Endpoint:** `GET /feedback/mine`.
- **Quy tắc:** trả phản ánh + lịch sử trạng thái + phản hồi cơ quan.

---

## J. Quy tắc ngang (áp dụng mọi chức năng)
- **Validate:** mọi input qua Joi (`validate.middleware`); body/query/params.
- **RBAC:** `requireRole(...)`; kiểm quyền theo địa bàn nếu bật.
- **Sanitize:** mọi nội dung HTML (tin tức/bình luận/mô tả) phải sanitize chống XSS.
- **Upload (lưu LOCAL filesystem — đã chốt):** dùng `upload.middleware.js` có sẵn.
  - Root: `public/uploads/{images|videos|documents}/YYYY/MM/`; phục vụ tĩnh tại `/uploads/...` (app.js).
  - Tên file random `slug-timestamp-hex.ext` (chống path traversal); validate **MIME thực + extension**; giới hạn dung lượng/số file theo `.env`.
  - Helper: `uploadImage`, `uploadMedia` (ảnh+video), `uploadDocument`, `uploadAny` + `handleUploadError`.
  - DB lưu **đường dẫn tương đối** (vd `/uploads/images/2026/06/abc-...jpg`), không lưu blob.
  - Backup ảnh: nằm trong backup filesystem định kỳ (US-103); cân nhắc tách volume riêng cho `public/uploads`.
- **i18n:** thông điệp song ngữ theo locale.
- **Audit:** thao tác quản trị (đổi quyền, khóa user, đổi public, xóa) ghi log.
- **Pagination:** `OK_LIST` + `metadata.pagination`.
- **Spatial:** SRID 4326 đồng nhất; GIST index; giới hạn feature theo zoom.

## K. Mức độ chi tiết hiện tại (tự đánh giá)
| Module | Story+AC (doc 02) | Thiết kế (07–13) | Spec field-level (doc này) |
|--------|:---:|:---:|:---:|
| Auth | ✓ | code thực | — (đã có code) |
| User mgmt | ✓ | — | ✓ §A |
| Map layers | ✓ | doc 12/13 | ✓ §B |
| Map API | ✓ | — | ✓ §C |
| Satellite | ✓ | doc 08/13 | ✓ (tham chiếu) |
| Weather | ✓ | doc 08 | ✓ (doc 08) |
| Fire-risk | ✓ | doc 07/13 | ✓ (doc 07) |
| Stats | ✓ | — | ✓ §E |
| Spatial | ✓ | — | ✓ §F |
| News/CMS | ✓ | — | ✓ §G/§H |
| Feedback | ✓ | — | ✓ §I |
| MobileGIS | ✓ | doc 09 | ✓ (doc 09) |
