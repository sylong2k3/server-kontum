# Implementation Plan — WebGIS/MobileGIS Kon Tum

## Overview

Kế hoạch triển khai chia 5 phase: nền tảng (bảo mật + PostGIS + quản trị user), GIS lõi + GeoServer, dự báo cháy rừng, CMS + phản ánh, và MobileGIS/realtime/thống kê. Mỗi task tham chiếu requirement tương ứng và bám pattern hiện có (`migrations → repository → service → controller → routes`).

## Tasks

### Phase 0 — Nền tảng

- [x] 1. Bảo mật cấu hình
- [x] 1.1 Thêm dòng `.env` vào `.gitignore` (nếu chưa có) và xác nhận không track `.env`
  - _Requirements: 14.2_
- [x] 1.2 Tạo `.env.example` liệt kê tên khóa (không giá trị) cho DB, JWT, Google OAuth, GeoServer, GEE, FIRMS, OpenWeather, FCM
  - _Requirements: 14.2_

- [x] 2. Bật PostGIS & tạo schema domain
- [x] 2.1 Viết migration `009_postgis_and_schemas.sql`: `CREATE EXTENSION IF NOT EXISTS postgis` và `CREATE SCHEMA IF NOT EXISTS` cho `gis`, `fire`, `cms`, `field`
  - _Requirements: 14.5_
- [x] 2.2 Cập nhật `options: '-c search_path=...'` trong `configs/database.js` thành `public,auth,gis,fire,cms,field`
  - _Requirements: 14.5_
- [x] 2.3 Tạo helper chạy migration (nếu chưa có) hoặc tài liệu lệnh chạy `009`; verify extension + schema tồn tại bằng query `SELECT`
  - _Requirements: 14.5_ — verify query có trong comment cuối migration

- [x] 3. Middleware phân quyền chi tiết
- [x] 3.1 Thêm `requirePermission(resource, action)` trong `middlewares/auth.middleware.js` đọc `req.user.role_permissions` (JSONB), trả 403 song ngữ khi thiếu quyền
  - _Requirements: 1.6, 14.1_
- [x] 3.2 Thêm helper `hasPermission(permissions, resource, action)` thuần (pure function) để tái dùng và dễ test
  - _Requirements: 1.6_

- [x] 4. Quản trị người dùng — Data layer
- [x] 4.1 Mở rộng `user.repository.js`: `findAll({ filter, page, pageSize })`, `countAll(filter)` (lọc theo role/is_active/email)
  - _Requirements: 1.1_
- [x] 4.2 Thêm `updateRole(userId, roleCode)`, `setActive(userId, isActive)` vào repository
  - _Requirements: 1.1, 1.2_
- [x] 4.3 Thêm `setTemporaryPassword(userId, passwordHash)` + cờ `must_change_password` (migration `009` cột bổ sung cho `auth.users`)
  - _Requirements: 1.3_

- [x] 5. Quản trị người dùng — Service & validation
- [x] 5.1 Tạo `services/user.service.js`: list user (phân trang), tạo user với role, khóa/mở khóa, reset mật khẩu tạm
  - _Requirements: 1.1, 1.2, 1.3_
- [x] 5.2 Giới hạn phạm vi cho `so_nnmt` (chỉ thao tác tài khoản cấp sở) trong service
  - _Requirements: 1.4_
- [x] 5.3 Service hồ sơ cá nhân: `getOwnProfile`, `updateOwnProfile` (mọi vai trò)
  - _Requirements: 1.5_
- [x] 5.4 Tạo `validators/user.validator.js` (Joi) cho create/update/setRole/resetPassword
  - _Requirements: 1.1, 1.3_

- [x] 6. Quản trị người dùng — Controller & routes
- [x] 6.1 Tạo `controllers/user.controller.js` map các use case sang response chuẩn (`core/success.response`)
  - _Requirements: 1.1, 1.2, 1.3, 1.5_
- [x] 6.2 Tạo `routes/user.routes.js` với `verifyToken` + `requireRole`/`requirePermission`; route `/me/profile` cho self-service
  - _Requirements: 1.1, 1.5, 1.6_
- [x] 6.3 Mount `/users` vào `routes/index.js`
  - _Requirements: 1.1_

### Phase 1 — GIS lõi & GeoServer

- [ ] 7. Schema lớp bản đồ
- [ ] 7.1 Migration `009_gis_layers_features.sql`: tạo `gis.map_layers` (code, tên song ngữ, geometry_type, source_table, geoserver_layer, style_name, access_level, category, is_published, created_by, timestamps)
  - _Requirements: 2.5_
- [ ] 7.2 Trong cùng migration: tạo `gis.features` (layer_id FK, properties JSONB, geom GEOMETRY(Geometry,4326)) + index GiST trên `geom` + index `layer_id`
  - _Requirements: 2.1, 14.5_

- [ ] 8. Schema ranh giới, ảnh vệ tinh, map-apis
- [ ] 8.1 Migration `010_gis_boundaries_satellite.sql`: `gis.boundaries` (level, name, parent_id, geom MultiPolygon 4326 + GiST)
  - _Requirements: 10.3_
- [ ] 8.2 Trong cùng migration: `gis.satellite_images` (source, captured_at, region, image_type, cloud_percent, asset/url, is_public, metadata JSONB)
  - _Requirements: 5.1_
- [ ] 8.3 Migration `015_gis_map_apis.sql`: `gis.map_apis` (name, api_key hash, scopes JSONB, is_active, expires_at, created_by)
  - _Requirements: 4.1_

- [ ] 9. GeoServer service — kết nối & workspace
- [ ] 9.1 Thêm biến GeoServer vào `.env`/`.env.example` và tạo `configs/geoserver.js` đọc cấu hình
  - _Requirements: 2.2, 14.3_
- [ ] 9.2 Tạo `services/gis/geoserver.service.js` với client REST (Basic Auth) + `ensureWorkspace()`, `ensurePostgisDatastore()` (idempotent)
  - _Requirements: 2.2, 2.6_

- [ ] 10. GeoServer service — publish & style
- [ ] 10.1 Thêm `publishLayer({ tableName, layerName, srs })` và `unpublishLayer(layerName)`
  - _Requirements: 2.2, 2.4_
- [ ] 10.2 Thêm `uploadStyle(sldName, sldXml)` và `applyStyle(layerName, sldName)`
  - _Requirements: 2.3_
- [ ] 10.3 Bọc lỗi GeoServer: log chi tiết, ném lỗi API thân thiện, không làm hỏng metadata khi GeoServer fail
  - _Requirements: 2.6_

- [ ] 11. Quản lý lớp — Data & service
- [ ] 11.1 Tạo `repositories/layer.repository.js`: CRUD `gis.map_layers`, query theo access_level/category
  - _Requirements: 2.5_
- [ ] 11.2 Tạo `services/gis/layer.service.js`: tạo/sửa/xóa lớp gọi kèm publish/unpublish + applyStyle GeoServer
  - _Requirements: 2.2, 2.3, 2.4_
- [ ] 11.3 Hàm import: parse shapefile/excel → ghi `gis.features` (EPSG:4326) → tạo map_layer → publish
  - _Requirements: 2.1, 2.2_

- [ ] 12. Quản lý lớp — Controller & routes
- [ ] 12.1 Tạo `validators/layer.validator.js` + `controllers/gis/layer.controller.js`
  - _Requirements: 2.1, 2.5_
- [ ] 12.2 Tạo `routes/layer.routes.js` (`/map/layers`) với RBAC; endpoint upload import dùng middleware file
  - _Requirements: 2.1, 2.3, 2.4_
- [ ] 12.3 Mount `/map/layers` vào `routes/index.js`
  - _Requirements: 2.1_

- [ ] 13. Proxy bản đồ có phân quyền
- [ ] 13.1 Tạo `controllers/gis/geoserver-proxy.controller.js`: phân giải `LAYERS`/`typeName` từ query → tra `access_level` trong `gis.map_layers`
  - _Requirements: 3.1, 3.3_
- [ ] 13.2 Forward request tới GeoServer nội bộ (stream), truyền lại content-type + cache header; lớp `public` cho qua kể cả ẩn danh
  - _Requirements: 3.2, 3.5_
- [ ] 13.3 Tạo `routes/geoserver-proxy.routes.js` (`/map/wms`, `/map/wfs`) với `optionalAuth`; đảm bảo không lộ URL/credential GeoServer; mount vào index
  - _Requirements: 3.1, 3.4_

- [ ] 14. API dữ liệu bản đồ (`/map-apis`)
- [ ] 14.1 Tạo `repositories/map-api.repository.js`: tạo (hash key), liệt kê, thu hồi, kiểm hết hạn + scopes
  - _Requirements: 4.1, 4.2, 4.4_
- [ ] 14.2 Tạo `middlewares/api-key.middleware.js` xác thực key từ header, gắn scopes vào `req`
  - _Requirements: 4.3, 4.4_
- [ ] 14.3 Tạo service/controller/validator/routes `/map-apis` (admin tạo/chia sẻ/thu hồi); mount vào index
  - _Requirements: 4.1, 4.2_

### Phase 2 — Dự báo cháy rừng

- [ ] 15. Schema thời tiết & cháy
- [ ] 15.1 Migration `011_gis_weather.sql`: `gis.weather_data` (observed_at, temperature, rainfall, wind_speed/dir, humidity, source, geom Point 4326) + index thời gian + GiST
  - _Requirements: 6.1_
- [ ] 15.2 Migration `012_fire_tables.sql`: `fire.forest_fire_warning` (theo DDL + cột phụ lst/ndmi/ndvi/nbr/wind/rainfall_7d, `is_priority`) + GiST
  - _Requirements: 7.3_
- [ ] 15.3 Trong cùng migration: `fire.active_fire_point` (theo DDL) + GiST trên `geom`
  - _Requirements: 8.1_

- [ ] 16. GEE — kết nối & chỉ số
- [ ] 16.1 Bật/hoàn thiện `configs/gge.js`: khởi tạo GEE bằng service account, hàm `isInitialized()`; lỗi init chỉ log, không sập
  - _Requirements: 7.6_
- [ ] 16.2 Tạo `services/fire/gee.service.js`: tính NDVI, NDMI, NBR (Sentinel-2) + LST (MODIS) cho vùng Kon Tum
  - _Requirements: 7.1_

- [ ] 17. GEE — tính FireRisk & export
- [ ] 17.1 Hàm tổng hợp `FireRisk` theo trọng số và phân 5 cấp (`risk_level` ∈ {1..5}); tách thành pure function để test
  - _Requirements: 7.2_
- [ ] 17.2 Export GeoJSON: `getInfo` cho vùng nhỏ, hàng đợi/task bất đồng bộ cho vùng lớn (không chạy đồng bộ trong HTTP request)
  - _Requirements: 7.5_
- [ ] 17.3 `repositories/fire.repository.js`: ghi kết quả vào `fire.forest_fire_warning`
  - _Requirements: 7.3_

- [ ] 18. FIRMS & Weather services
- [ ] 18.1 Tạo `services/fire/firms.service.js`: gọi FIRMS API theo bbox Kon Tum, parse CSV → ghi `fire.active_fire_point`
  - _Requirements: 8.1_
- [ ] 18.2 Tạo `services/fire/weather.service.js`: lấy gió/mưa/độ ẩm (OpenWeather/ERA5) → `gis.weather_data`
  - _Requirements: 6.1, 6.3_
- [ ] 18.3 Logic ưu tiên: truy vấn `ST_DWithin` giữa warning và điểm FIRMS, set `is_priority`
  - _Requirements: 8.2_

- [ ] 19. Cronjobs ingestion
- [ ] 19.1 Tạo `jobs/weather.job.js` (mặc định 1 giờ) theo mẫu `token-cleanup.job.js`
  - _Requirements: 6.1_
- [ ] 19.2 Tạo `jobs/firms.job.js` (mặc định 2 giờ)
  - _Requirements: 8.1_
- [ ] 19.3 Tạo `jobs/fire-risk.job.js` (mặc định 1 ngày): chạy GEE → ghi warning → gắn is_priority → refresh lớp GeoServer
  - _Requirements: 7.4_
- [ ] 19.4 Đăng ký 3 job trong `server.js` dưới `IS_SINGLETON_WORKER`; dừng job trong `gracefulShutdown`
  - _Requirements: 14.4_

- [ ] 20. API cảnh báo cháy (`/fire-risk`)
- [ ] 20.1 Mở rộng `fire.repository.js`: `getLatestGeoJSON()`, `getHistory(from,to)`, `getFirmsPoints()`, `getWarningPopup(id)`
  - _Requirements: 9.1, 9.2, 9.3_
- [ ] 20.2 Tạo `services/fire/fire-risk.service.js` + `controllers/fire/fire-risk.controller.js`
  - _Requirements: 9.1, 9.2, 9.3_
- [ ] 20.3 Tạo `routes/fire-risk.routes.js` (`optionalAuth` cho endpoint công khai); mount vào index
  - _Requirements: 9.1, 9.4_

### Phase 3 — CMS & Phản ánh

- [ ] 21. Schema CMS
- [ ] 21.1 Migration `013_cms_tables.sql`: `cms.news`, `cms.news_comments`
  - _Requirements: 11.1_
- [ ] 21.2 Trong cùng migration: `cms.documents`, `cms.pdf_maps` (scope public/internal/specialized)
  - _Requirements: 11.3, 11.4_

- [ ] 22. Module tin tức (`/news`)
- [ ] 22.1 Repository + service: CRUD tin tức, tìm kiếm theo từ khóa/danh mục
  - _Requirements: 11.1, 11.2_
- [ ] 22.2 Bình luận: thêm/lấy bình luận theo bài; controller/validator/routes; đăng cần quyền, đọc/bình luận mở
  - _Requirements: 11.2_
- [ ] 22.3 Mount `/news` vào index
  - _Requirements: 11.1_

- [ ] 23. Module văn bản & bản đồ PDF (`/documents`)
- [ ] 23.1 Repository + service: CRUD `documents`/`pdf_maps`, lọc theo scope, kiểm quyền tải về
  - _Requirements: 11.3, 11.4_
- [ ] 23.2 Controller/validator/routes `/documents` + endpoint tải về theo quyền; mount vào index
  - _Requirements: 11.3, 11.4_

- [ ] 24. Schema phản ánh & hiện trường
- [ ] 24.1 Migration `014_field_tables.sql`: `field.feedback` (+ geom Point 4326), `field.feedback_media`, `field.feedback_history`
  - _Requirements: 12.1, 12.2_
- [ ] 24.2 Trong cùng migration: `field.field_updates`, `field.device_tokens`
  - _Requirements: 12.3, 13.1_

- [ ] 25. Module phản ánh (`/feedback`)
- [ ] 25.1 Repository + service: tạo phản ánh (nội dung + GPS + ảnh, status `new`), đổi trạng thái + ghi `feedback_history`
  - _Requirements: 12.1, 12.2_
- [ ] 25.2 Query tổng hợp toàn tỉnh cho UBND; controller/validator/routes; citizen gửi, so_nnmt/admin xử lý; mount vào index
  - _Requirements: 12.2, 12.4_

### Phase 4 — MobileGIS, Realtime, Thống kê

- [ ] 26. Realtime WebSocket
- [ ] 26.1 Bật `realtime/websocket.server.js` trong `server.js` (init + close trong shutdown), kênh `alerts`
  - _Requirements: 13.3_
- [ ] 26.2 Hàm `broadcastAlert(payload)` để phát cảnh báo tới client đang kết nối
  - _Requirements: 13.3_

- [ ] 27. Push FCM
- [ ] 27.1 Tạo `services/notification/fcm.service.js` (init service account, `sendToTokens`)
  - _Requirements: 13.2_
- [ ] 27.2 Repository `device_tokens`: đăng ký token + cập nhật `last_lat/last_lng`
  - _Requirements: 13.1_
- [ ] 27.3 Hàm gửi cảnh báo gần vị trí GPS (lọc token theo bán kính quanh warning)
  - _Requirements: 13.2_

- [ ] 28. Tích hợp cảnh báo realtime + push
- [ ] 28.1 Gắn `broadcastAlert` + FCM vào luồng cảnh báo ưu tiên cao trong `fire-risk.job` (task 18.3/19.3)
  - _Requirements: 8.3, 13.2, 13.3_

- [ ] 29. MobileGIS (`/mobile`)
- [ ] 29.1 Endpoint cập nhật hiện trạng (`field_updates`) + upload ảnh kèm tọa độ
  - _Requirements: 12.3_
- [ ] 29.2 Endpoint đăng ký/cập nhật push token; mount `/mobile` vào index
  - _Requirements: 13.1_

- [ ] 30. Thống kê (`/stats`)
- [ ] 30.1 Repository/service: diện tích lớp phủ theo huyện và theo thời gian (truy vấn PostGIS)
  - _Requirements: 10.1_
- [ ] 30.2 Endpoint số liệu dashboard điều hành cấp tỉnh cho UBND; controller/routes; mount vào index
  - _Requirements: 10.4_

- [ ] 31. Phân tích không gian (`/spatial`)
- [ ] 31.1 Phân tích thay đổi rừng: so sánh 2 thời điểm, trả vùng thay đổi
  - _Requirements: 10.2_
- [ ] 31.2 Khoảng cách dân cư–rừng bằng truy vấn không gian PostGIS; controller/routes; mount vào index
  - _Requirements: 10.3_

- [ ] 32. Ảnh vệ tinh (`/satellite`)
- [ ] 32.1 Repository + service: thêm metadata ảnh, tìm theo thời gian/vùng/loại, đánh dấu công khai
  - _Requirements: 5.1, 5.2, 5.3_
- [ ] 32.2 Endpoint so sánh hiện trạng 2 thời điểm; controller/validator/routes; mount vào index
  - _Requirements: 5.4_

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1", "2", "3"], "description": "Bảo mật cấu hình, PostGIS + schema, permission middleware" },
    { "wave": 2, "tasks": ["4", "5", "6"], "description": "Quản trị người dùng (data → service → routes)" },
    { "wave": 3, "tasks": ["7", "8", "9"], "description": "Schema GIS/ranh giới/map-apis, GeoServer kết nối" },
    { "wave": 4, "tasks": ["10", "11", "12"], "description": "GeoServer publish/style, quản lý lớp" },
    { "wave": 5, "tasks": ["13", "14", "15"], "description": "Proxy bản đồ, map-apis, schema fire/weather" },
    { "wave": 6, "tasks": ["16", "17", "18"], "description": "GEE chỉ số/FireRisk, FIRMS/weather services" },
    { "wave": 7, "tasks": ["19", "20"], "description": "Cronjobs ingestion, API cảnh báo cháy" },
    { "wave": 8, "tasks": ["21", "22", "23", "24", "25"], "description": "CMS, phản ánh" },
    { "wave": 9, "tasks": ["26", "27", "28", "29"], "description": "Realtime, push, MobileGIS" },
    { "wave": 10, "tasks": ["30", "31", "32"], "description": "Thống kê, phân tích không gian, ảnh vệ tinh" }
  ]
}
```

Phụ thuộc chính giữa các phase:

```
Phase 0 (1,2,3) ─► tất cả phase sau
Phase 1: 7,8 ─► 11,12 ; 9 ─► 10 ─► 11 ; 12 ─► 13 ; 8.3 ─► 14
Phase 2: 15 ─► 16,17,18 ─► 19 ─► 20 ; 9,10 (GeoServer) ─► 19.3/20
Phase 3: 2(PostGIS) ─► 21 ─► 22,23 ; 24 ─► 25
Phase 4: 18.3/19.3 ─► 28 ; 26,27 ─► 28 ; 24 ─► 29 ; 7,8,15 ─► 30,31 ; 8 ─► 32
```

Thứ tự đề xuất: theo số task tăng dần 1 → 32 (đã sắp theo phụ thuộc).

## Notes

- Mỗi task chỉ chạm tới tầng nghiệp vụ; KHÔNG tự thêm test trừ khi được yêu cầu (theo quy ước dự án), nhưng nên kiểm tra build/migration sau mỗi nhóm.
- GeoServer phải được cài đặt & chạy nội bộ trước task 4; cung cấp `GEOSERVER_URL`/credential qua `.env`.
- GEE cần service account; FIRMS cần MAP_KEY; FCM cần service account — chuẩn bị trước Phase 2/4.
- Ưu tiên hoàn thành Phase 1 (GIS lõi) vì là nền cho mọi lớp bản đồ phía sau.
