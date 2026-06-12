# Design — WebGIS/MobileGIS Kon Tum

## Overview

Tài liệu thiết kế kỹ thuật cho nền tảng giám sát rừng/môi trường và dự báo cháy rừng tỉnh Kon Tum. Thiết kế mở rộng trên codebase Node.js + Express 5 hiện có (module Auth + RBAC đã hoàn thiện), bổ sung PostGIS, GeoServer, pipeline GEE/FIRMS, CMS, phản ánh hiện trường, realtime/push.

Nguyên tắc thiết kế:
- Giữ nguyên pattern hiện tại: `migrations(SQL) → repository → service → controller → routes`, validator Joi, i18n song ngữ, `core/*.response`, middleware `verifyToken`/`requireRole`.
- Tách domain theo schema PostgreSQL: `auth` (đã có), `gis`, `fire`, `cms`, `field`.
- PostGIS là single source of truth; GeoServer đọc trực tiếp PostGIS để phục vụ OGC; Express xử lý nghiệp vụ + điều khiển/proxy GeoServer.

## Architecture

```
            GEE (Sentinel-2, MODIS LST, ERA5)   NASA FIRMS   OpenWeather
                          │                          │            │
                          ▼                          ▼            ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  Ingestion Layer (node-cron, singleton worker)                 │
        │   fire-risk.job · firms.job · weather.job                      │
        └──────────────────────────────┬─────────────────────────────────┘
                                        ▼ ghi
        ┌──────────────┐  đọc trực tiếp  ┌─────────────┐  WMS/WMTS/WFS (nội bộ)
        │ PostgreSQL   │◄───────────────►│  GeoServer  │◄──────────────┐
        │ + PostGIS    │                 └─────────────┘               │
        │ auth/gis/    │◄────┐                  ▲ REST publish          │ proxy
        │ fire/cms/    │     │ business          │ (control)            │
        │ field        │     ▼                   │                      │
        └──────────────┘  ┌─────────────────────────────┐              │
              ▲           │  Express API /api/v1/*       │──────────────┘
              │           │  RBAC · CRUD · pipeline ctrl │
              │           │  geoserver proxy + control   │───► WebGIS (Mapbox/OpenLayers)
              │           └──────────────┬───────────────┘───► MobileGIS (Flutter/RN)
              │                          ▼
              └───────────────  WebSocket /ws  +  FCM push
```

### Phân chia trách nhiệm

| Thành phần | Trách nhiệm |
|------------|-------------|
| PostGIS | Lưu mọi dữ liệu không gian + nghiệp vụ; index GiST; nguồn dữ liệu chung |
| GeoServer | Render & phục vụ lớp bản đồ chuẩn OGC (WMS/WMTS/WFS), style SLD, cache tile (GeoWebCache), tái chiếu CRS |
| Express API | Auth/RBAC, CRUD nghiệp vụ, điều khiển GeoServer (publish/style), proxy có phân quyền, chạy pipeline ingestion |
| Ingestion jobs | GEE/FIRMS/weather theo lịch, ghi PostGIS, kích hoạt cảnh báo |
| Realtime | WebSocket đẩy cảnh báo; FCM push cho mobile |

## Data Models

Bật `CREATE EXTENSION postgis`. `search_path` mở rộng: `public,auth,gis,fire,cms,field`.

### Schema `gis`

- `gis.map_layers` — metadata lớp: `id, code, name_vi, name_en, geometry_type, source_table, geoserver_layer, style_name, access_level (public|internal|specialized), category, is_published, created_by, timestamps`.
- `gis.features` — đối tượng không gian generic (cho lớp nhập từ shapefile/excel): `id, layer_id FK, properties JSONB, geom GEOMETRY(Geometry,4326)`; index GiST trên `geom`, index trên `layer_id`.
- `gis.boundaries` — ranh giới: `id, level (province|district|commune|forest|subzone), name, parent_id, geom GEOMETRY(MultiPolygon,4326)`; GiST.
- `gis.satellite_images` — catalog ảnh: `id, source, captured_at, region, image_type, cloud_percent, url/asset_id, is_public, metadata JSONB`.
- `gis.weather_data` — `id, station_or_cell, observed_at, temperature, rainfall, wind_speed, wind_dir, humidity, source, geom GEOMETRY(Point,4326)`; index theo thời gian (cân nhắc partition theo tháng).
- `gis.map_apis` — `id, name, api_key (hash), scopes JSONB (layers/actions), is_active, expires_at, created_by`.

### Schema `fire`

DDL theo đúng tài liệu nghiệp vụ:

```sql
CREATE TABLE fire.forest_fire_warning (
  id SERIAL PRIMARY KEY,
  risk_level INTEGER,
  risk_score NUMERIC,
  source VARCHAR(50),
  province VARCHAR(100),
  district VARCHAR(100),
  commune VARCHAR(100),
  forest_type VARCHAR(100),
  warning_time TIMESTAMP,
  geom GEOMETRY(Polygon, 4326)
);

CREATE TABLE fire.active_fire_point (
  id SERIAL PRIMARY KEY,
  latitude NUMERIC,
  longitude NUMERIC,
  brightness NUMERIC,
  confidence VARCHAR(50),
  satellite VARCHAR(50),
  acq_date DATE,
  acq_time VARCHAR(10),
  geom GEOMETRY(Point, 4326)
);
```

Bổ sung: index GiST trên `geom` cả hai bảng; `forest_fire_warning` thêm cột chỉ số phụ (`lst, ndmi, ndvi, nbr, wind, rainfall_7d`) phục vụ popup; cờ `is_priority` khi gần điểm FIRMS.

### Schema `cms`

- `cms.news` — `id, title, slug, content, cover_url, category, status, author_id, published_at, timestamps`.
- `cms.news_comments` — `id, news_id FK, user_id, content, created_at`.
- `cms.documents` — `id, title, type (report|document), scope (public|internal|specialized), file_url, uploaded_by, timestamps`.
- `cms.pdf_maps` — `id, title, file_url, category, is_public, uploaded_by, timestamps`.

### Schema `field`

- `field.feedback` — `id, user_id (nullable cho ẩn danh), content, status (new|checking|resolved), geom GEOMETRY(Point,4326), created_at`.
- `field.feedback_media` — `id, feedback_id FK, file_url, kind`.
- `field.feedback_history` — `id, feedback_id FK, from_status, to_status, actor_id, note, created_at`.
- `field.field_updates` — `id, user_id, type, note, geom GEOMETRY(Point,4326), created_at`.
- `field.device_tokens` — `id, user_id, token, platform, last_lat, last_lng, updated_at`.

### Migrations kế tiếp (từ 008)

| File | Nội dung |
|------|----------|
| 008_postgis_and_schemas.sql | `CREATE EXTENSION postgis`; tạo schema gis/fire/cms/field |
| 009_gis_layers_features.sql | `gis.map_layers`, `gis.features` + GiST |
| 010_gis_boundaries_satellite.sql | `gis.boundaries`, `gis.satellite_images` |
| 011_gis_weather.sql | `gis.weather_data` |
| 012_fire_tables.sql | `fire.forest_fire_warning`, `fire.active_fire_point` |
| 013_cms_tables.sql | `cms.news`, `cms.news_comments`, `cms.documents`, `cms.pdf_maps` |
| 014_field_tables.sql | `field.*` |
| 015_gis_map_apis.sql | `gis.map_apis` |

## Components and Interfaces

### GeoServer Integration

### Service: `src/services/gis/geoserver.service.js`

Bọc GeoServer REST API (Basic Auth qua biến môi trường). Hàm chính:
- `ensureWorkspace()`, `ensurePostgisDatastore()` — idempotent, tạo nếu chưa có.
- `publishLayer({ tableName, layerName, srs })` — publish feature type từ datastore PostGIS.
- `unpublishLayer(layerName)`.
- `applyStyle(layerName, sldName)` / `uploadStyle(sldName, sldXml)`.

### Proxy có phân quyền: `src/controllers/gis/geoserver-proxy.controller.js`

- Route `GET /api/v1/map/wms` và `/api/v1/map/wfs`.
- Dùng `optionalAuth`; phân giải lớp được yêu cầu từ query (`LAYERS`/`typeName`) → tra `gis.map_layers.access_level`.
- `public` → cho qua; `internal`/`specialized` → yêu cầu role phù hợp, nếu không trả 403.
- Forward tới `GEOSERVER_URL` nội bộ bằng `fetch`/stream, truyền lại `content-type`, set cache header cho tile.
- Không bao giờ trả URL/credential GeoServer cho client.

### Biến môi trường bổ sung (.env)

```
GEOSERVER_URL=http://localhost:8080/geoserver
GEOSERVER_USER=admin
GEOSERVER_PASSWORD=...
GEOSERVER_WORKSPACE=kontum
GEOSERVER_DATASTORE=kontum_postgis
# GEE
GEE_SERVICE_ACCOUNT=...
GEE_KEY_FILE=...
GEE_REGION_ASSET=users/.../kon_tum_boundary
# FIRMS / Weather
FIRMS_MAP_KEY=...
OPENWEATHER_API_KEY=...
# Cron
FIRE_RISK_CRON=0 2 * * *
FIRMS_CRON=0 */2 * * *
WEATHER_CRON=0 * * * *
# FCM
FCM_SERVICE_ACCOUNT=...
```

## Fire-Risk Pipeline

### GEE service (`src/services/fire/gee.service.js`)
- Bật lại `configs/gge.js` (đang scaffold), xác thực bằng service account.
- Chạy script tính NDVI/NDMI/NBR (Sentinel-2 S2_SR_HARMONIZED) + LST (MODIS MOD11A1).
- Tổng hợp `FireRisk` theo trọng số tài liệu; phân 5 cấp.
- Export GeoJSON (vùng nhỏ: `getInfo`; vùng lớn: export task bất đồng bộ qua hàng đợi).

### FIRMS service (`src/services/fire/firms.service.js`)
- Gọi FIRMS API (VIIRS/MODIS) theo bbox Kon Tum, parse CSV → ghi `fire.active_fire_point`.

### Weather service (`src/services/fire/weather.service.js`)
- Lấy gió/mưa/độ ẩm (OpenWeather/ERA5) → `gis.weather_data`.

### Jobs (`src/jobs/`)
- `fire-risk.job.js` (1 ngày), `firms.job.js` (2 giờ), `weather.job.js` (1 giờ) — chạy ở singleton worker (theo `IS_SINGLETON_WORKER` trong `server.js`).
- Sau khi ghi warning: chạy truy vấn không gian gắn `is_priority` nếu có điểm FIRMS gần (`ST_DWithin`); phát WebSocket + FCM.

### API (`/api/v1/fire-risk`)
- `GET /latest` → GeoJSON warning mới nhất (public, `optionalAuth`).
- `GET /history?from&to` → lịch sử.
- `GET /firms` → điểm cháy thực tế.
- `GET /:id/popup` → chi tiết popup.

## Module/Route Map

Mount thêm vào `src/routes/index.js` (đã có placeholder):

| Mount | Router | Quyền chính |
|-------|--------|-------------|
| `/users` | user.routes | system_admin; so_nnmt (giới hạn) |
| `/map/layers` | layer.routes | admin, so_nnmt |
| `/map/wms`,`/map/wfs` | geoserver-proxy.routes | optionalAuth + layer ACL |
| `/satellite` | satellite.routes | admin, so_nnmt; public xem ảnh public |
| `/weather` | weather.routes | all |
| `/fire-risk` | fire-risk.routes | all xem; admin cấu hình |
| `/stats` | stats.routes | theo role |
| `/spatial` | spatial.routes | so_nnmt, ubnd |
| `/news` | news.routes | đăng: admin/so_nnmt; đọc/bình luận: all |
| `/documents` | document.routes | theo role |
| `/feedback` | feedback.routes | citizen gửi; so_nnmt/admin xử lý |
| `/mobile` | mobile.routes | so_nnmt, citizen |
| `/map-apis` | map-api.routes | system_admin |

## RBAC nâng cao

Bổ sung middleware `requirePermission(resource, action)` đọc `auth.roles.permissions` (JSONB) cho kiểm soát mịn, dùng cùng `requireRole` hiện có. Lớp ACL bản đồ dựa trên `gis.map_layers.access_level`.

## Error Handling

Tái sử dụng `core/error.response.js` (`Api401Error`, `Api403Error`, `Api404Error`, ...) và `middlewares/error-handler.js`. Lỗi tích hợp ngoài (GeoServer/GEE/FIRMS) được bắt trong service, log chi tiết, và ánh xạ sang lỗi API thân thiện; pipeline lỗi KHÔNG làm sập tiến trình (chỉ bỏ qua chu kỳ + log).

## Realtime & Push

- WebSocket: bật lại `realtime/websocket.server.js` trong `server.js`, kênh `alerts`.
- FCM: service `src/services/notification/fcm.service.js` + `field.device_tokens`; gửi khi cảnh báo gần `last_lat/last_lng`.

## Testing Strategy

- Migrations: chạy tuần tự trên DB sạch, kiểm tra PostGIS extension và GiST index tồn tại.
- Unit: service GeoServer (mock REST), tính FireRisk (input chỉ số → cấp đúng), parser FIRMS CSV.
- Integration: proxy WMS phân quyền (public/internal/403), `/fire-risk/latest` trả GeoJSON hợp lệ.
- Endpoint nghiệp vụ: kiểm RBAC (đúng/sai quyền), validate Joi.

## Correctness Properties

### Property 1: Phân quyền lớp bản đồ
Mọi request proxy WMS/WFS tới lớp `internal`/`specialized` mà thiếu quyền PHẢI trả 403; lớp `public` luôn truy cập được kể cả ẩn danh.
**Validates: Requirements 3.1, 3.2, 3.3**

### Property 2: Không lộ hạ tầng
Phản hồi proxy KHÔNG bao giờ chứa URL/credential GeoServer nội bộ.
**Validates: Requirements 3.4, 14.3**

### Property 3: Toàn vẹn dữ liệu không gian
Mọi geometry lưu ở EPSG:4326; mọi cột `geom` có index GiST.
**Validates: Requirements 2.1, 14.5**

### Property 4: Bất biến phân cấp cháy
`risk_level` luôn nằm trong {1,2,3,4,5} và nhất quán với ngưỡng `risk_score`.
**Validates: Requirements 7.2, 7.3**

### Property 5: An toàn pipeline
Lỗi GEE/FIRMS/GeoServer trong một chu kỳ ingestion KHÔNG làm sập tiến trình; chỉ log và bỏ qua chu kỳ.
**Validates: Requirements 7.6, 2.6**

### Property 6: Singleton job
Tại một thời điểm, mỗi cronjob ingestion chỉ chạy trên đúng một worker.
**Validates: Requirements 14.4**

### Property 7: Idempotent publish
Gọi `ensureWorkspace`/`ensureDatastore`/`publishLayer` nhiều lần không tạo trùng lặp.
**Validates: Requirements 2.2**

### Property 8: Bảo mật ghi
Mọi endpoint thay đổi dữ liệu yêu cầu JWT hợp lệ + kiểm quyền vai trò.
**Validates: Requirements 14.1, 1.6**

## Bảo mật & Vận hành

- **Soft delete bắt buộc**: KHÔNG hard-delete bản ghi người dùng. Xóa tài khoản chỉ set `auth.users.deleted_at = NOW()` (+ `is_active = false`); mọi truy vấn đọc/đăng nhập đều loại bản ghi có `deleted_at IS NOT NULL`. Áp dụng nguyên tắc này cho các thực thể nghiệp vụ quan trọng khác khi cần lưu vết.

- `.env` phải nằm trong `.gitignore`; xoay vòng các secret đã từng commit (DB, Google, sắp tới GeoServer/GEE/FIRMS/FCM).
- GeoServer chỉ bind nội bộ; ra ngoài qua proxy Express.
- Mọi endpoint ghi: `verifyToken` + kiểm quyền.
- Cronjob chỉ chạy ở singleton worker.
- Index GiST bắt buộc trên mọi cột `geom`.
