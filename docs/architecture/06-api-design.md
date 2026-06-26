# 06 — API Design (Đặc tả REST API)

> Base path: **`/api/v1`**. Convention bám theo mã nguồn hiện có.

## 1. Quy ước chung

### Định dạng response (theo `core/success.response.js`)
```jsonc
// Thành công
{
  "message": "Thông điệp song ngữ theo locale",
  "status": 200,
  "data": { /* ... */ },
  "metadata": { "pagination": { "page": 1, "limit": 10, "total": 42, "totalPages": 5, "hasMore": true } }
}
// Lỗi (core/error.response.js)
{
  "success": false,
  "message": "Mô tả lỗi",
  "errors": ["MA_LOI"]
}
```

### Quy tắc
- Auth: header `Authorization: Bearer <accessToken>`.
- Locale: `locale.middleware` (query `?lang=vi|en` hoặc header) → thông điệp song ngữ.
- Phân quyền: ưu tiên middleware `requirePermission(resource, action)` cho CRUD/capability checks; `requireRole(...)` chỉ dùng khi endpoint bắt buộc đúng vai trò cụ thể.
  - Ví dụ: `requirePermission('news', 'create')`, `requirePermission('comments', 'approve')`, `requirePermission('users', 'change_role')`.
- Validate: Joi qua `validate(schema)` / `validate(schema, 'query')`.
- Phân trang: query `?page=&limit=` → `metadata.pagination`.
- Rate-limit: áp `/api/`; endpoint nhạy cảm có limiter riêng.
- Dữ liệu không gian trả **GeoJSON** (`FeatureCollection`) hoặc **MVT** (vector tile).

### Mã trạng thái dùng chung
`200 OK`, `201 Created`, `400 Bad Request`, `401 Unauthorized`, `403 Forbidden`, `404 Not Found`, `409 Conflict`, `422 Validation`, `429 Too Many Requests`, `500 Server Error`.

### Danh sách chức năng chi tiết theo quyền

> Ma trận này là cơ sở thiết kế API và RBAC. Tên role kỹ thuật tương ứng: `system_admin`, `ubnd_tinh`, `so_nnmt`, `citizen`.

| Nhóm chức năng | Quản trị hệ thống | UBND tỉnh | Sở NN&MT tỉnh | Người dân |
|---|---|---|---|---|
| Đăng nhập / Đăng ký | Đăng nhập | Đăng nhập | Đăng nhập | Đăng nhập, Đăng ký |
| Quản trị người dùng | Thêm/xóa tài khoản, phân quyền, khóa tài khoản, cấp lại mật khẩu | Xem người dùng nếu được phân quyền | Quản lý tài khoản chuyên môn cấp sở | Quản lý hồ sơ cá nhân |
| Quản trị ảnh vệ tinh | Thêm, xóa, phân loại, quản lý ảnh vệ tinh | Xem ảnh vệ tinh | Tìm kiếm, khai thác ảnh vệ tinh phục vụ giám sát | Xem ảnh được chia sẻ công khai |
| Quản trị lớp dữ liệu bản đồ | Thêm/sửa/xóa lớp dữ liệu, phân quyền, import shapefile/excel | Xem lớp dữ liệu tổng hợp | Quản lý dữ liệu lớp phủ rừng, chuyên đề môi trường | Xem lớp dữ liệu công khai |
| API dữ liệu bản đồ | Tạo API, chia sẻ API, phân quyền API | Sử dụng API báo cáo điều hành | Khai thác API tích hợp hệ thống chuyên ngành | Không |
| Quản trị tin tức | Thêm/sửa/xóa tin tức | Đọc tin tức | Đăng tin chuyên ngành | Đọc, tìm kiếm, bình luận |
| Quản trị báo cáo – văn bản | Thêm/xóa báo cáo, văn bản | Xem báo cáo quản lý | Quản lý báo cáo nghiệp vụ | Xem tài liệu công khai |
| Quản trị bản đồ PDF | Thêm/sửa/xóa bản đồ PDF | Xem, tải bản đồ PDF | Quản lý bản đồ chuyên đề PDF | Xem, tải bản đồ PDF |
| Thông tin cập nhật từ MobileGIS | Theo dõi cập nhật, xác thực thông tin | Xem tổng hợp phản ánh | Xem thay đổi hiện trạng, xác minh thực địa | Gửi dữ liệu hiện trạng |
| Tương tác bản đồ WebGIS | Toàn quyền thao tác | Xem bản đồ, tra cứu đối tượng, 3D, lớp nền | Khai thác bản đồ chuyên sâu, lớp chuyên ngành | Tra cứu bản đồ công khai |
| Tương tác dữ liệu thời tiết | Quản trị nguồn dữ liệu | Theo dõi nhiệt độ, mưa | Theo dõi thời tiết phục vụ cảnh báo | Xem thông tin thời tiết |
| Tương tác ảnh vệ tinh | Quản trị toàn bộ chức năng | Xem, so sánh hiện trạng | Phân loại đối tượng, tính diện tích, xuất vector | Xem dữ liệu công khai |
| Thống kê | Quản trị cấu hình thống kê | Xem báo cáo, biểu đồ điều hành | Thống kê diện tích lớp phủ, theo huyện, theo thời gian | Xem thống kê công khai |
| Phân tích không gian | Quản trị mô hình phân tích | Xem cảnh báo thay đổi rừng | Phân tích thay đổi rừng, khoảng cách dân cư–rừng | Không |
| Dự báo cháy rừng | Quản trị thuật toán, cấu hình | Xem cảnh báo cháy cấp tỉnh | Theo dõi chỉ số nhiệt, độ ẩm, hướng gió, nguy cơ cháy | Xem cảnh báo công khai |
| Tin tức | Quản lý nội dung | Đọc tin | Đọc, đăng tin chuyên môn | Đọc, tìm kiếm, bình luận |
| Báo cáo | Quản lý báo cáo | Xem báo cáo điều hành | Xem báo cáo chuyên ngành | Xem báo cáo công khai |
| Gửi phản ánh | Tiếp nhận và quản lý phản ánh | Theo dõi phản ánh toàn tỉnh | Xử lý phản ánh lĩnh vực rừng | Gửi phản ánh kèm ảnh vi phạm |
| MobileGIS – tương tác bản đồ | Quản trị ứng dụng | Theo dõi dữ liệu hiện trường | Sử dụng GPS, đo đạc, cập nhật đối tượng | Xem bản đồ, GPS, tìm đường |
| MobileGIS – giám sát hiện trạng | Theo dõi dữ liệu gửi lên | Xem báo cáo hiện trường | Chụp ảnh, cập nhật hiện trạng rừng | Chụp ảnh, gửi hiện trạng |
| MobileGIS – tin tức / văn bản | Quản trị nội dung | Đọc | Đọc, tra cứu | Đọc, tra cứu kiểm tra tiến độ |

---

## 2. Auth (đã hiện thực) — `/api/v1/auth`

| Method | Endpoint | Auth | Mô tả |
|--------|----------|------|-------|
| POST | `/register` | — | Đăng ký (rate-limit) |
| POST | `/login` | — | Đăng nhập → access+refresh |
| POST | `/refresh` | — | Gia hạn access token |
| POST | `/forgot-password` | — | Gửi email reset |
| POST | `/reset-password` | — | Đặt lại mật khẩu |
| POST | `/verify-email` | — | Xác minh email |
| POST | `/resend-verification` | — | Gửi lại email xác minh |
| GET | `/google` | — | Redirect Google consent |
| GET | `/google/callback` | — | Callback OAuth web |
| POST | `/google/mobile` | — | Google login mobile |
| POST | `/oauth/exchange` | — | Đổi one-time code → token |
| POST | `/logout` | ✅ | Đăng xuất (revoke token) |
| POST | `/change-password` | ✅ | Đổi mật khẩu |
| GET | `/me` | ✅ | Thông tin user hiện tại |

## 3. Users (đã hiện thực) — `/api/v1/users`

| Method | Endpoint | Role | Mô tả |
|--------|----------|------|-------|
| GET | `/me/profile` | mọi user | Xem hồ sơ |
| PATCH | `/me/profile` | mọi user | Cập nhật hồ sơ |
| GET | `/` | admin, so_nnmt | Danh sách user (phân trang/lọc) |
| POST | `/` | admin, so_nnmt | Tạo user |
| GET | `/:id` | admin, so_nnmt | Chi tiết user |
| PATCH | `/:id/role` | admin | Đổi vai trò |
| PATCH | `/:id/active` | admin, so_nnmt | Khóa/mở tài khoản |
| POST | `/:id/reset-password` | admin, so_nnmt | Cấp lại mật khẩu |
| DELETE | `/:id` | admin, so_nnmt | Xóa mềm user |

---

## 4. Map Layers — `/api/v1/map/layers` *(EP-03)*

| Method | Endpoint | Role | Mô tả |
|--------|----------|------|-------|
| GET | `/` | public* | Danh sách lớp (public hoặc theo quyền) |
| POST | `/` | admin | Tạo lớp dữ liệu |
| GET | `/:code` | public* | Metadata lớp |
| PATCH | `/:code` | admin | Sửa metadata/style |
| DELETE | `/:code` | admin | Xóa lớp |
| POST | `/:code/import` | admin, so_nnmt | Import shapefile/GeoJSON/Excel (multipart) |
| GET | `/:code/features` | public* | GeoJSON theo `?bbox=&zoom=` |
| GET | `/:code/tiles/{z}/{x}/{y}.mvt` | public* | Vector tile |
| GET | `/:code/feature-info` | public* | Thuộc tính theo `?lng=&lat=` hoặc `?id=` |

\* lớp `is_public=false` yêu cầu auth + RBAC.

**Ví dụ — GET `/map/layers/ranh_gioi_rung/features?bbox=107.8,14.2,108.2,14.6&zoom=10`**
```jsonc
{
  "message": "OK",
  "status": 200,
  "data": {
    "type": "FeatureCollection",
    "features": [
      { "type": "Feature",
        "geometry": { "type": "Polygon", "coordinates": [[...]] },
        "properties": { "ten_tieu_khu": "TK 123", "dien_tich_ha": 245.6 } }
    ]
  }
}
```

### Map metadata & GeoServer management — `/api/v1/map`
| Method | Endpoint | Mô tả |
|--------|----------|-------|
| GET | `/layers` | Lấy metadata layer active/public theo quyền |
| POST | `/layers/:code/publish` | Publish layer lên GeoServer qua REST API *(admin)* |
| DELETE | `/layers/:code/publish` | Unpublish layer khỏi GeoServer *(admin)* |
| PATCH | `/layers/:code/active` | Bật/tắt layer, đồng bộ `is_active` và GeoServer `enabled` *(admin)* |
| POST | `/rasters/:coverageStore/harvest` | Harvest GeoTIFF vào ImageMosaic + truncate GWC nếu cần *(admin)* |

### Import file GIS — `/api/v1/map` *(EP-03b)*

| Method | Endpoint | Quyền | Mô tả |
|--------|----------|-------|-------|
| POST | `/layers/import-file` | `map_layers.import` | Upload file GIS (multipart `file`). Nạp vào PostGIS qua `ogr2ogr`, đăng ký `layer_registry`, auto-publish GeoServer. Trả **202** + `job_id`. |
| GET | `/import-jobs/:jobId` | `map_layers.import` | Poll tiến độ job (`status`, `progress`, `imported_count`, `error_log`). |
| GET | `/layers/:code/import-jobs` | `map_layers.import` | Lịch sử import của một layer. |

**Multipart fields cho `POST /layers/import-file`:**

| Field | Kiểu | Bắt buộc | Ghi chú |
|-------|------|----------|---------|
| `file` | File | ✅ | `.zip` (shapefile/KMZ/GDB), `.geojson`, `.json`, `.kml`, `.tif/.tiff` |
| `code` | text | ✅ | Mã layer (tạo mới hoặc re-import nếu trùng) |
| `name_vi` | text | ✅ (tạo mới) | Tên hiển thị tiếng Việt |
| `source_format` | text | ✅ | `shapefile` \| `geojson` \| `kml` \| `geotiff` \| `filegdb` |
| `import_mode` | text | — | `overwrite` (mặc định) \| `append` |
| `srid_input` | int | — | SRID nguồn nếu file thiếu CRS (mặc định 4326) |
| `source_layer_name` | text | — | Layer con trong FileGDB/KML nhiều layer |
| `category`, `layer_kind`, `layer_group`, `data_year`, `is_public` | text | — | Metadata phân loại |
| `auto_publish` | bool | — | Mặc định `true` — tự publish GeoServer sau import |

**Response 202:**
```jsonc
{
  "success": true,
  "message": "Yêu cầu import đã được tiếp nhận, đang xử lý",
  "data": { "job_id": 42, "code": "ranh_gioi_rung", "status": "processing", "sync": true }
}
```

> Luồng render FE sau import: `GET /map/layers` → FE nhận `geoserver_layer` → build URL WMS/WFS/WMTS/MVT → render trực tiếp trên GeoServer. Node không proxy tile.

> WMS/WFS/WMTS/MVT không đi qua Node.js. Frontend gọi trực tiếp GeoServer public URL cho layer công khai/chỉ đọc.

### Map APIs — `/api/v1/map-apis` *(admin)* CRUD + cấp `api_key`, `scope`.

---

## 5. Satellite — `/api/v1/satellite` *(EP-04)*

| Method | Endpoint | Role | Mô tả |
|--------|----------|------|-------|
| GET | `/search` | so_nnmt | Tìm Sentinel-2 `?bbox=&from=&to=&cloud=` |
| GET | `/indices` | so_nnmt | Tile NDVI/NDMI/NBR `?index=&bbox=&date=` |
| POST | `/compare` | so_nnmt | So sánh 2 thời điểm (swipe/diff) |
| POST | `/classify` | so_nnmt | Phân loại + tính diện tích, xuất GeoJSON |
| GET | `/images` | so_nnmt | Danh sách ảnh đã lưu |
| GET | `/images/public` | public | Ảnh công khai |

---

## 6. Weather — `/api/v1/weather` *(EP-05)*

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| GET | `/layers?type=temp\|rain\|cloud\|wind` | Raster/tile thời tiết |
| GET | `/wind-grid?bbox=` | Lưới gió cho windy streamlines |
| GET | `/point?lng=&lat=` | Thời tiết tại điểm (popup) |

---

## 7. Fire Risk — `/api/v1/fire-risk` *(EP-06, core)*

| Method | Endpoint | Role | Mô tả |
|--------|----------|------|-------|
| GET | `/latest` | public | GeoJSON bản đồ nguy cơ mới nhất |
| GET | `/history?from=&to=` | ubnd, so_nnmt | Lịch sử cảnh báo |
| GET | `/points/active` | public | Điểm cháy FIRMS đang hoạt động |
| GET | `/summary` | ubnd, so_nnmt | Tổng hợp theo huyện/cấp |
| POST | `/recompute` | admin | Chạy lại pipeline thủ công |
| POST | `/subscribe` | citizen (mobile) | Đăng ký push theo vị trí GPS |

**Ví dụ — GET `/fire-risk/latest`** (FE Mapbox dùng trực tiếp)
```jsonc
{
  "message": "OK",
  "status": 200,
  "data": {
    "type": "FeatureCollection",
    "features": [
      { "type": "Feature",
        "geometry": { "type": "Polygon", "coordinates": [[...]] },
        "properties": {
          "risk_level": 5, "risk_score": 0.78, "priority": "high",
          "lst": 39.5, "ndmi": 0.12, "wind_kmh": 18, "rainfall_7d": "low",
          "district": "Đăk Glei", "warning_time": "2026-05-24T02:00:00Z",
          "recommendation": "Kiểm tra thực địa / gửi cảnh báo MobileGIS"
        } }
    ]
  }
}
```

---

## 8. Spatial & Stats — `/api/v1/spatial`, `/api/v1/stats` *(EP-07)*

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| GET | `/stats/landcover?by=district&from=&to=` | Diện tích lớp phủ theo huyện/thời gian |
| POST | `/spatial/forest-change` | Phân tích thay đổi rừng 2 mốc |
| GET | `/spatial/residential-distance` | Khoảng cách dân cư–rừng |
| GET | `/stats/dashboard` | Số liệu dashboard điều hành (export PDF/Excel) |

---

## 9. CMS — `/api/v1/news`, `/api/v1/documents` *(EP-08)*

### News

| Method | Endpoint | Role | Mô tả |
|--------|----------|------|-------|
| GET | `/news` | public | Danh sách/tìm kiếm tin (đã published) |
| GET | `/news/:slug` | public | Chi tiết tin theo slug (lang từ query/headers) |
| GET | `/admin/news/:id` | admin, so_nnmt | Chi tiết tin kèm đầy đủ bản dịch |
| POST | `/admin/news` | admin, so_nnmt | Tạo tin mới (gồm metadata + bản dịch đầu tiên) |
| PATCH | `/admin/news/:id` | admin, so_nnmt | Cập nhật metadata chung (status, cover) |
| PUT | `/admin/news/:id` | admin, so_nnmt | Cập nhật gộp metadata + all translations |
| DELETE | `/admin/news/:id` | admin, so_nnmt | Xóa tin (soft delete) |
| GET | `/news/:id/comments` | public | Danh sách bình luận đã duyệt của tin đã published |
| POST | `/news/:id/comments` | citizen | Bình luận trên tin đã published (chờ duyệt) |
| PATCH | `/admin/comments/:id/approve` | admin, so_nnmt | Duyệt hoặc từ chối bình luận |
| DELETE | `/admin/comments/:id` | admin, so_nnmt, owner | Xóa bình luận |

### Documents

| Method | Endpoint | Role | Mô tả |
|--------|----------|------|-------|
| GET | `/documents` | public* | Danh sách tài liệu (doc_type, public only) |
| GET | `/documents/:id` | public* | Chi tiết tài liệu (lang từ query/headers) |
| GET | `/admin/documents/:id` | admin, so_nnmt | Chi tiết tài liệu kèm đầy đủ bản dịch |
| POST | `/admin/documents` | admin, so_nnmt | Upload tài liệu mới (metadata + bản dịch đầu tiên + file) |
| PATCH | `/admin/documents/:id` | admin, so_nnmt | Cập nhật metadata chung (docType, isPublic) |
| PUT | `/admin/documents/:id` | admin, so_nnmt | Cập nhật gộp metadata + all translations |
| DELETE | `/admin/documents/:id` | admin, so_nnmt | Xóa tài liệu (soft delete) |

\* tài liệu `is_public=false` yêu cầu auth + RBAC.

---

## 10. Feedback — `/api/v1/feedback` *(EP-09, đã hiện thực)*

Phản ánh hỗ trợ 2 kiểu danh tính:
- User đăng nhập: gửi `Authorization: Bearer <accessToken>`.
- Ẩn danh: gửi header `x-anonymous-id` ổn định từ thiết bị/app.

| Method | Endpoint | Auth/Permission | Mô tả |
|--------|----------|-----------------|-------|
| POST | `/feedback` | optional auth hoặc `x-anonymous-id` | Gửi phản ánh multipart, field media là `media` |
| GET | `/feedback/mine` | optional auth hoặc `x-anonymous-id` | Danh sách phản ánh của chính user/anonymous id |
| GET | `/feedback/:id` | owner | Chi tiết phản ánh của chính user/anonymous id |
| GET | `/admin/feedback/map` | `feedback.map` | GeoJSON phản ánh cho dashboard/bản đồ |
| GET | `/admin/feedback` | `feedback.read` | Danh sách quản trị, lọc/trang |
| GET | `/admin/feedback/:id` | `feedback.read` | Staff xem chi tiết phản ánh, có thêm `statusLogs` |
| PATCH | `/admin/feedback/:id/status` | `feedback.update_status` | Cập nhật trạng thái xử lý |

### POST `/feedback`

Content-Type: `multipart/form-data`.

| Field | Type | Required | Ghi chú |
|-------|------|----------|---------|
| `category` | enum | ✅ | `chay_rung`, `vi_pham`, `hien_trang` |
| `title` | string | ✅ | 5–255 ký tự |
| `description` | string | — | tối đa 2000 ký tự |
| `priority` | enum | — | `low`, `normal`, `high`, `urgent`; mặc định `normal` |
| `lng` | number | ✅ | 106–109 |
| `lat` | number | ✅ | 13–16.5 |
| `clientUuid` | string | — | chống gửi trùng từ mobile/offline |
| `media` | file[] | — | ảnh/video qua middleware upload media |

Response `201`:
```jsonc
{
  "message": "Gửi phản ánh thành công",
  "status": 201,
  "data": {
    "feedback": {
      "id": 1,
      "category": "chay_rung",
      "title": "Có khói tại khu vực rừng",
      "status": "new",
      "priority": "high",
      "mediaUrls": ["uploads/images/abc.jpg"],
      "lng": 107.92,
      "lat": 14.35,
      "createdAt": "2026-06-19T10:00:00.000Z"
    },
    "duplicated": false
  }
}
```

### GET `/feedback/mine` và GET `/admin/feedback`

Query chung: `page`, `limit`, `status`, `category`, `priority`, `q`, `from`, `to`.

### GET `/admin/feedback/map`

Query: `status`, `category`, `priority`, `bbox=minLng,minLat,maxLng,maxLat`.
Trả về `FeatureCollection`, mỗi feature có geometry point và properties phản ánh.

### PATCH `/admin/feedback/:id/status`

Body:
```jsonc
{
  "toStatus": "in_progress",
  "note": "Đã chuyển cán bộ kiểm tra"
}
```

Luồng mặc định: `new -> in_progress|rejected`, `in_progress -> resolved|rejected`; `system_admin` có thể override.

---

## 11. Mobile — `/api/v1/mobile` *(EP-10)*

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| POST | `/devices/register` | Đăng ký FCM token thiết bị |
| POST | `/field-updates` | Cập nhật đối tượng hiện trường (đo đạc) |
| GET | `/sync?since=` | Đồng bộ dữ liệu offline-first |
| GET | `/alerts/nearby?lng=&lat=&radius=` | Cảnh báo gần vị trí |

---

## 12. Realtime — WebSocket

- Endpoint: `wss://<host>/ws` (qua `realtime/websocket.server.js`).
- Kênh: `fire-alerts` (broadcast khi có cảnh báo cấp cao / FIRMS mới), `feedback` (phản ánh mới cho cơ quan).
- Message mẫu:
```jsonc
{ "channel": "fire-alerts", "type": "new_warning",
  "payload": { "id": 123, "risk_level": 5, "district": "Đăk Glei", "priority": "high" } }
```

## 13. Versioning & tài liệu hóa
- Version qua path `/api/v1`. Thay đổi phá vỡ → `/api/v2`.
- Đề xuất bổ sung OpenAPI 3.1 (`/docs/openapi.yaml`) + Swagger UI ở môi trường dev.
