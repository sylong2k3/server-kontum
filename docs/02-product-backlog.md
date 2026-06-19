# 02 — Product Backlog

> Ưu tiên theo cột **P** (P0 = bắt buộc/nền tảng, P1 = cao, P2 = trung bình, P3 = mở rộng). Cột **SP** = Story Point. Trạng thái: ✅ Done (đã có trong code), 🟡 In Progress, ⬜ To Do.

## Tổng quan Epics

| Epic | Tên | Ưu tiên | Trạng thái |
|------|-----|---------|-----------|
| EP-01 | Nền tảng & Bảo mật (Auth, RBAC) | P0 | ✅ Done |
| EP-02 | Quản trị người dùng & hồ sơ | P0 | ✅ Done |
| EP-03 | Lớp dữ liệu bản đồ & WebGIS core | P0 | ⬜ |
| EP-04 | Ảnh vệ tinh & Google Earth Engine | P1 | ⬜ |
| EP-05 | Thời tiết thời gian gần thực | P1 | ⬜ |
| EP-06 | Dự báo & cảnh báo cháy rừng | P0 | ⬜ |
| EP-07 | Phân tích không gian & Thống kê | P2 | ⬜ |
| EP-08 | CMS: Tin tức, Văn bản, Bản đồ PDF | P2 | 🟡 |
| EP-09 | Phản ánh hiện trường (Feedback) | P1 | ⬜ |
| EP-10 | MobileGIS | P1 | ⬜ |
| EP-11 | Vận hành, Pipeline dữ liệu & DevOps | P0 | 🟡 |

---

## EP-01 — Nền tảng & Bảo mật

| ID | User Story | AC tóm tắt | P | SP | TT |
|----|-----------|-----------|---|----|----|
| US-001 | Là người dùng, tôi muốn đăng ký bằng email để có tài khoản. | Validate email/mật khẩu; gửi email xác thực; chống trùng email (lower index). | P0 | 5 | ✅ |
| US-002 | Là người dùng, tôi muốn đăng nhập nhận JWT để dùng API. | Trả access(15m)+refresh(30d); sai pass khóa mềm theo rate-limit. | P0 | 5 | ✅ |
| US-003 | Là người dùng, tôi muốn đăng nhập bằng Google. | OAuth20 web + mobile (android/ios client id); liên kết social account. | P0 | 8 | ✅ |
| US-004 | Là người dùng, tôi muốn refresh token và logout an toàn. | Refresh xoay vòng; revoke token; cron dọn token hết hạn. | P0 | 5 | ✅ |
| US-005 | Là người dùng, tôi muốn reset mật khẩu qua email. | Token reset hết hạn 15m, tối đa 3 lần. | P0 | 3 | ✅ |
| US-006 | Là hệ thống, tôi muốn phân quyền RBAC 4 vai trò. | Middleware kiểm tra role/permission JSONB; chặn truy cập trái phép. | P0 | 5 | ✅ |
| US-007 | Là người dùng, tôi muốn nhận thông điệp song ngữ (vi/en). | `locale.middleware` chọn ngôn ngữ; i18n cho lỗi & thành công. | P1 | 3 | ✅ |

**Gherkin mẫu — US-002**
```gherkin
Scenario: Đăng nhập thành công
  Given tài khoản đã xác thực email với mật khẩu đúng
  When người dùng POST /api/v1/auth/login với email + password hợp lệ
  Then trả 200 với accessToken (15m) và refreshToken (30d)
  And refreshToken được lưu hashed trong auth.tokens

Scenario: Sai mật khẩu vượt ngưỡng
  Given đã sai mật khẩu AUTH_RATE_LIMIT lần trong cửa sổ
  When người dùng đăng nhập lại
  Then trả 429 TOO_MANY_REQUESTS
```

---

## EP-02 — Quản trị người dùng & hồ sơ

| ID | User Story | AC tóm tắt | P | SP | TT |
|----|-----------|-----------|---|----|----|
| US-010 | Là `system_admin`, tôi muốn thêm/khóa/xóa mềm tài khoản & gán vai trò. | CRUD user; soft delete (migration 010); buộc đổi mật khẩu lần đầu (`must_change_password`). | P0 | 8 | ✅ |
| US-011 | Là người dùng, tôi muốn xem & sửa hồ sơ cá nhân. | Cập nhật tên, avatar (upload middleware), đổi mật khẩu. | P1 | 5 | ✅ |
| US-012 | Là `system_admin`, tôi muốn xem danh sách user có phân trang/lọc. | Phân trang, lọc theo role/trạng thái/từ khóa. | P1 | 3 | ✅ |
| US-013 | Là `so_nnmt` admin cấp sở, tôi muốn quản lý tài khoản chuyên môn của sở. | Giới hạn scope tạo user trong phạm vi sở. | P2 | 5 | ✅ |

---

## EP-03 — Lớp dữ liệu bản đồ & WebGIS core

| ID | User Story | AC tóm tắt | P | SP | TT |
|----|-----------|-----------|---|----|----|
| US-020 | Là `system_admin`, tôi muốn CRUD lớp dữ liệu bản đồ. | Bảng `gis.map_layers` (metadata: tên, loại hình học, schema, style, công khai?). | P0 | 8 | ⬜ |
| US-021 | Là `system_admin`, tôi muốn import shapefile/GeoJSON/Excel. | Upload → validate SRID 4326 → ghi PostGIS; báo lỗi từng dòng. | P0 | 13 | ⬜ |
| US-022 | Là người dân, tôi muốn xem các lớp công khai trên bản đồ. | API trả GeoJSON/MVT theo bbox+zoom; chỉ lớp `is_public`. | P0 | 8 | ⬜ |
| US-023 | Là người dùng, tôi muốn click đối tượng để xem thuộc tính (popup). | API feature-info theo tọa độ/id; trả thuộc tính. | P1 | 5 | ⬜ |
| US-024 | Là hệ thống, tôi muốn proxy WMS/WFS qua GeoServer an toàn. | Proxy ẩn credential; GeoServer chỉ bind nội bộ; cache tile. | P0 | 8 | ⬜ |
| US-025 | Là `system_admin`, tôi muốn tạo & phân quyền API bản đồ. | Bảng `gis.map_apis` + api-key/scope; rate-limit riêng. | P2 | 8 | ⬜ |
| US-026 | Là người dùng WebGIS, tôi muốn chọn lớp nền & bật/tắt layer, xem 3D. | Layer switcher, lớp nền (vệ tinh/đường phố), terrain 3D. | P1 | 5 | ⬜ |

**Gherkin mẫu — US-022**
```gherkin
Scenario: Người dân xem lớp công khai trong khung nhìn
  Given lớp "ranh_gioi_rung" có is_public = true
  When GET /api/v1/map/layers/ranh_gioi_rung/features?bbox=...&zoom=10
  Then trả 200 GeoJSON FeatureCollection trong bbox
  And không trả lớp có is_public = false dù biết tên
```

---

## EP-04 — Ảnh vệ tinh & Google Earth Engine

| ID | User Story | AC | P | SP | TT |
|----|-----------|----|---|----|----|
| US-030 | Là `so_nnmt`, tôi muốn tìm & xem ảnh Sentinel-2 theo vùng/thời gian. | Filter bbox + date + cloud%; trả tile/thumbnail từ GEE. | P1 | 13 | ⬜ |
| US-031 | Là `so_nnmt`, tôi muốn xem chỉ số NDVI/NDMI/NBR. | Tính trên GEE, hiển thị layer màu + legend. | P1 | 8 | ⬜ |
| US-032 | Là `so_nnmt`, tôi muốn so sánh hiện trạng 2 thời điểm (swipe). | Split/swipe 2 ảnh; chênh lệch NDVI. | P2 | 8 | ⬜ |
| US-033 | Là `so_nnmt`, tôi muốn tính diện tích & xuất vector phân loại. | Phân loại theo ngưỡng; export GeoJSON/diện tích (ha). | P2 | 13 | ⬜ |
| US-034 | Là `system_admin`, tôi muốn quản lý/lưu trữ ảnh đã phân loại. | Bảng metadata ảnh; phân loại công khai/nội bộ. | P2 | 5 | ⬜ |

---

## EP-05 — Thời tiết thời gian gần thực

| ID | User Story | AC | P | SP | TT |
|----|-----------|----|---|----|----|
| US-040 | Là người dùng, tôi muốn xem nhiệt độ/mưa/mây/gió trên bản đồ. | Raster OpenWeather + lưới gió Open-Meteo (windy streamlines). | P1 | 8 | ⬜ |
| US-041 | Là hệ thống, tôi muốn ingest thời tiết theo cron mỗi giờ. | `WEATHER_CRON=0 * * * *`; lưu `gis`/cache; fallback khi API lỗi. | P1 | 5 | ⬜ |
| US-042 | Là người dùng, tôi muốn click điểm bất kỳ xem thời tiết. | Popup nhiệt độ/gió/mưa tại tọa độ. | P2 | 3 | ⬜ |

---

## EP-06 — Dự báo & cảnh báo cháy rừng (core)

| ID | User Story | AC | P | SP | TT |
|----|-----------|----|---|----|----|
| US-050 | Là hệ thống, tôi muốn tính chỉ số FireRisk hằng ngày từ GEE. | Tổng hợp LST/Dryness/Veg/NBR/Wind/Rainfall → score; cron `0 2 * * *`. | P0 | 13 | ⬜ |
| US-051 | Là hệ thống, tôi muốn phân cấp 5 mức nguy cơ & lưu PostGIS. | Bảng `fire.forest_fire_warning`; risk_level 1–5; geom polygon 4326. | P0 | 8 | ⬜ |
| US-052 | Là hệ thống, tôi muốn ingest điểm cháy NASA FIRMS mỗi 2 giờ. | Bảng `fire.active_fire_point`; cron `0 */2 * * *`; chống trùng. | P0 | 8 | ⬜ |
| US-053 | Là người dùng, tôi muốn xem bản đồ nguy cơ + điểm cháy + popup. | API `/api/v1/fire-risk/latest` GeoJSON; popup chỉ số khuyến nghị. | P0 | 5 | ⬜ |
| US-054 | Là hệ thống, tôi muốn ưu tiên cảnh báo khi nguy cơ cao + có FIRMS gần. | Spatial join FIRMS vào polygon nguy cơ; cờ ưu tiên cao. | P0 | 8 | ⬜ |
| US-055 | Là người dùng MobileGIS, tôi muốn nhận push khi gần vùng nguy cơ ≥ Cấp 4. | FCM theo vị trí GPS; opt-in thông báo. | P1 | 8 | ⬜ |
| US-056 | Là UBND tỉnh, tôi muốn xem cảnh báo cháy cấp tỉnh & lịch sử. | Dashboard cấp tỉnh; timeline cảnh báo. | P1 | 5 | ⬜ |

**Gherkin mẫu — US-054**
```gherkin
Scenario: Cảnh báo ưu tiên cao
  Given có polygon FireRisk risk_level >= 4
  And tồn tại điểm FIRMS trong bán kính 1km của polygon đó
  When pipeline đối chiếu chạy
  Then polygon được gắn priority = "high"
  And API /fire-risk/latest trả thuộc tính priority cho FE hiển thị nổi bật
```

---

## EP-07 — Phân tích không gian & Thống kê

| ID | User Story | AC | P | SP | TT |
|----|-----------|----|---|----|----|
| US-060 | Là `so_nnmt`, tôi muốn thống kê diện tích lớp phủ theo huyện/thời gian. | Aggregate PostGIS theo ranh giới hành chính; biểu đồ. | P2 | 8 | ⬜ |
| US-061 | Là `so_nnmt`, tôi muốn phân tích thay đổi rừng giữa 2 mốc. | Diff NDVI/NBR; vùng suy giảm. | P2 | 13 | ⬜ |
| US-062 | Là `so_nnmt`, tôi muốn tính khoảng cách dân cư–rừng. | `ST_Distance`/buffer; cảnh báo vùng giáp ranh. | P3 | 8 | ⬜ |
| US-063 | Là UBND tỉnh, tôi muốn dashboard thống kê điều hành. | Biểu đồ tổng hợp; xuất PDF/Excel. | P2 | 8 | ⬜ |

---

## EP-08 — CMS: Tin tức, Văn bản, Bản đồ PDF

| ID | User Story | AC | P | SP | TT |
|----|-----------|----|---|----|----|
| US-070 | Là `system_admin`/`so_nnmt`, tôi muốn CRUD tin tức. | Bảng `cms.news`; trạng thái nháp/đăng; ảnh đính kèm. | P2 | 5 | ✅ |
| US-071 | Là người dân, tôi muốn đọc/tìm kiếm/bình luận tin tức. | Full-text search; comment kiểm duyệt. | P2 | 5 | ✅ |
| US-072 | Là cơ quan, tôi muốn CRUD báo cáo/văn bản. | Bảng `cms.documents`; phân loại công khai/nội bộ. | P2 | 5 | ✅ |
| US-073 | Là người dùng, tôi muốn xem/tải bản đồ PDF chuyên đề. | Bảng `cms.pdf_maps`; tải file; phân quyền. | P2 | 3 | ⬜ |

---

## EP-09 — Phản ánh hiện trường (Feedback)

| ID | User Story | AC | P | SP | TT |
|----|-----------|----|---|----|----|
| US-080 | Là người dân, tôi muốn gửi phản ánh kèm ảnh + GPS. | Bảng `field.feedback`; upload ảnh; geom point 4326. | P1 | 8 | ⬜ |
| US-081 | Là `so_nnmt`, tôi muốn xử lý phản ánh theo trạng thái. | mới → đang xử lý → đã xử lý; ghi chú xử lý. | P1 | 5 | ⬜ |
| US-082 | Là UBND tỉnh, tôi muốn theo dõi phản ánh toàn tỉnh. | Bản đồ + danh sách + lọc theo trạng thái/khu vực. | P2 | 5 | ⬜ |
| US-083 | Là người dân, tôi muốn theo dõi tiến độ phản ánh của tôi. | Xem trạng thái + phản hồi cơ quan. | P2 | 3 | ⬜ |

---

## EP-10 — MobileGIS

| ID | User Story | AC | P | SP | TT |
|----|-----------|----|---|----|----|
| US-090 | Là người dân, tôi muốn xem bản đồ + định vị GPS trên mobile. | Bản đồ offline-friendly; nút "vị trí của tôi". | P1 | 8 | ⬜ |
| US-091 | Là kiểm lâm (`so_nnmt`), tôi muốn đo đạc & cập nhật đối tượng hiện trường. | Đo khoảng cách/diện tích; cập nhật điểm/đường/vùng. | P2 | 13 | ⬜ |
| US-092 | Là người dùng, tôi muốn chụp ảnh & gửi hiện trạng kèm tọa độ. | Camera + GPS + đồng bộ khi có mạng. | P1 | 8 | ⬜ |
| US-093 | Là người dùng, tôi muốn nhận thông báo đẩy cảnh báo. | FCM; deep-link tới vùng cảnh báo. | P1 | 5 | ⬜ |
| US-094 | Là người dùng, tôi muốn chỉ đường tới điểm cảnh báo. | Routing tới tọa độ cảnh báo. | P3 | 5 | ⬜ |

---

## EP-11 — Vận hành, Pipeline dữ liệu & DevOps

| ID | User Story | AC | P | SP | TT |
|----|-----------|----|---|----|----|
| US-100 | Là hệ thống, tôi muốn cron ingest fire/weather/firms ổn định. | node-cron theo `.env`; log + retry + alert khi fail. | P0 | 8 | 🟡 |
| US-101 | Là dev, tôi muốn CI lint+test trước merge. | GitHub Actions: eslint + test; chặn merge nếu đỏ. | P0 | 5 | ⬜ |
| US-102 | Là ops, tôi muốn health-check & metric cơ bản. | `/health` (đã có) + metric DB pool/cron. | P1 | 3 | 🟡 |
| US-103 | Là ops, tôi muốn backup PostGIS định kỳ. | pg_dump cron + retention; thử restore. | P1 | 3 | ⬜ |
| US-104 | Là hệ thống, tôi muốn realtime đẩy cảnh báo qua WebSocket. | `realtime/websocket.server.js` broadcast cảnh báo mới. | P1 | 5 | ✅ |

---

## Non-Functional Requirements (NFR)

| ID | Yêu cầu | Tiêu chí |
|----|---------|----------|
| NFR-01 | Hiệu năng API | p95 < 500ms cho API đọc; bản đồ dùng tile/MVT |
| NFR-02 | Bảo mật | RBAC, JWT, rate-limit, helmet, không expose GeoServer |
| NFR-03 | Khả dụng | Uptime ≥ 99%; cron có retry/fallback |
| NFR-04 | Mở rộng | Pattern phân lớp; schema tách `gis/fire/cms/field` |
| NFR-05 | Đa ngôn ngữ | Mọi thông điệp song ngữ vi/en |
| NFR-06 | Khả truy cập | WebGIS đạt WCAG AA cho thành phần UI (cần kiểm thử thủ công) |
| NFR-07 | Nhật ký & truy vết | morgan log; truy vết request id |

## Bảng tổng hợp Story Point theo Epic

| Epic | Tổng SP (ước tính) |
|------|--------------------|
| EP-01 | 34 (phần lớn đã Done) |
| EP-02 | 21 |
| EP-03 | 47 |
| EP-04 | 47 |
| EP-05 | 16 |
| EP-06 | 55 |
| EP-07 | 37 |
| EP-08 | 18 |
| EP-09 | 21 |
| EP-10 | 39 |
| EP-11 | 24 |
| **Tổng** | **~359 SP** |
