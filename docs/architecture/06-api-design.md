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
- Phân quyền: middleware `requireRole('system_admin', 'so_nnmt', ...)`.
- Validate: Joi qua `validate(schema)` / `validate(schema, 'query')`.
- Phân trang: query `?page=&limit=` → `metadata.pagination`.
- Rate-limit: áp `/api/`; endpoint nhạy cảm có limiter riêng.
- Dữ liệu không gian trả **GeoJSON** (`FeatureCollection`) hoặc **MVT** (vector tile).

### Mã trạng thái dùng chung
`200 OK`, `201 Created`, `400 Bad Request`, `401 Unauthorized`, `403 Forbidden`, `404 Not Found`, `409 Conflict`, `422 Validation`, `429 Too Many Requests`, `500 Server Error`.

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

### GeoServer proxy — `/api/v1/map`
| Method | Endpoint | Mô tả |
|--------|----------|-------|
| GET | `/wms` | Proxy WMS (ẩn credential, cache) |
| GET | `/wfs` | Proxy WFS |

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
| GET | `/news/admin/:id` | admin, so_nnmt | Chi tiết tin kèm đầy đủ bản dịch |
| POST | `/news` | admin, so_nnmt | Tạo tin mới (gồm metadata + bản dịch đầu tiên) |
| PATCH | `/news/admin/:id` | admin, so_nnmt | Cập nhật metadata chung (status, cover) |
| PUT | `/news/admin/:id` | admin, so_nnmt | Cập nhật gộp metadata + all translations |
| DELETE | `/news/:id` | admin | Xóa tin (soft delete) |
| POST | `/news/:id/comments` | citizen | Bình luận (chờ duyệt) |

### Documents

| Method | Endpoint | Role | Mô tả |
|--------|----------|------|-------|
| GET | `/documents` | public* | Danh sách tài liệu (doc_type, public only) |
| GET | `/documents/:id` | public* | Chi tiết tài liệu (lang từ query/headers) |
| GET | `/documents/admin/:id` | admin, so_nnmt | Chi tiết tài liệu kèm đầy đủ bản dịch |
| POST | `/documents` | admin, so_nnmt | Upload tài liệu mới (metadata + bản dịch đầu tiên + file) |
| PATCH | `/documents/admin/:id` | admin, so_nnmt | Cập nhật metadata chung (docType, isPublic) |
| PUT | `/documents/admin/:id` | admin, so_nnmt | Cập nhật gộp metadata + all translations |
| DELETE | `/documents/:id` | admin, so_nnmt | Xóa tài liệu (soft delete) |

\* tài liệu `is_public=false` yêu cầu auth + RBAC.

---

## 10. Feedback — `/api/v1/feedback` *(EP-09)*

| Method | Endpoint | Role | Mô tả |
|--------|----------|------|-------|
| POST | `/` | citizen (cả ẩn danh `x-anonymous-id`) | Gửi phản ánh + ảnh + GPS (multipart) |
| GET | `/mine` | citizen | Phản ánh của tôi |
| GET | `/` | ubnd, so_nnmt | Danh sách toàn tỉnh (lọc trạng thái/khu vực) |
| GET | `/:id` | so_nnmt | Chi tiết |
| PATCH | `/:id/status` | so_nnmt | Cập nhật trạng thái (new→in_progress→resolved) |
| GET | `/map` | ubnd, so_nnmt | GeoJSON phản ánh cho bản đồ |

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
