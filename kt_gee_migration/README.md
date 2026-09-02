# GEE Migration — Tổng hợp Ảnh vệ tinh · GeoServer · MinIO

> Đây là **bản sao dùng để tra cứu / migrate** của toàn bộ file phục vụ:
> - Xử lý ảnh vệ tinh trên Google Earth Engine (fire-risk EP-06, forest classification v5.3, satellite on-demand)
> - Export GeoTIFF → **GCS → MinIO** (archive) → **GeoServer** (WMS/WMTS publish)
> - Điều phối queue GEE (concurrency=1) + child-process runner
> - Raster ingest từ URL bên ngoài
>
> File gốc vẫn ở [server/src/](../src/) — mỗi khi thay đổi source, phải sync lại. Đừng chạy code trong thư mục này; require đường dẫn `../../...` sẽ không giải được.
>
> **⚠️ Bảo mật**: `service_keys/` chứa **service account JSON của Google Cloud** — không bao giờ commit lên public repo. Bản gốc đang được `require()` trực tiếp trong `configs/gge.js` bằng path relative.

---

## 1. Bố cục thư mục

```
gee_migration/
├── README.md                             ← file này
├── service_keys/                         ← ⚠️ SECRET — Google Cloud service account
│   ├── ggeServiceKey.json                    ← primary — dùng bởi configs/gge.js
│   └── anotherGgeServiceKey.json             ← backup
├── configs/                              ← runtime config (đọc ENV)
│   ├── gge.js                                ← authenticate + initialize Earth Engine (retry+backoff)
│   ├── geoserver.js                          ← URL, credentials, workspace, whitelist WMS/WFS params
│   ├── minioClient.js                        ← S3 client + auto-create bucket khi startup
│   ├── raster-ingest.js                      ← pipeline URL→MinIO→GeoServer, MAX_MB, MAX_RETRIES
│   ├── fire-risk.js                          ← toàn bộ hằng số pipeline v8.1 (RF, blend, breakpoints)
│   └── forest-classification.js              ← config schema v5.3 (13 classes, RF 100 trees, AREA_PRIOR)
├── services/                             ← business logic
│   ├── satellite.service.js                  ← GEE on-demand (5 endpoints) + publish flow
│   ├── fire-risk.service.js                  ← daily snapshot + per-district export + tile URL refresh
│   ├── fire-risk.pipeline.js                 ← GEE graph (S2/LST/ERA5/Nesterov/RF blend) — SHARED
│   ├── forest-classification.service.js      ← monthly snapshot + area stats + change alerts
│   ├── forest-classification.pipeline.js     ← GEE graph 27-band → RF → priority mosaic — SHARED
│   ├── raster-ingest.service.js              ← download URL → tmp → COG → MinIO → GeoServer
│   ├── minio.service.js                      ← wrapper putObject/presigned URL/stream download
│   ├── geo-import.service.js                 ← import shapefile/geojson upload (OGR)
│   ├── remote-sensing.service.js             ← quản lý ảnh vệ tinh upload manual + publish
│   ├── spatial.service.js                    ← query PostGIS + intersect/buffer/area
│   ├── map.service.js                        ← quản lý layer_registry + GeoServer publish (vector)
│   ├── fire-gt.service.js                    ← Fire ground-truth CRUD + xuất GEE FeatureCollection
│   ├── forest-gt.service.js                  ← Forest ground-truth (điểm điều tra 13 lớp)
│   ├── layer-series.service.js               ← time-series layers (fire monthly / forest monthly)
│   └── pdf-map.service.js                    ← render bản đồ PDF composite (GetMap + overlay)
├── utils/                                ← helper chuyên biệt GEE / GDAL / stream
│   ├── gee-satellite.util.js                 ← eeEval, getKonTumRegion/Districts, getEeMapId/DownloadUrl
│   ├── gee-processing-state.util.js          ← state machine chuẩn hoá cho pipeline
│   ├── gee-export.helper.js                  ← pollGeeTask, publishRasterToMinio
│   ├── gee-zip-rgb.util.js                   ← convert GEE zip (band files) → COG RGB (nhờ GDAL)
│   ├── geoserver.client.js                   ← REST API client (workspace, coveragestore, layer, style)
│   ├── geotiff.util.js                       ← header/CRS parse + validate
│   ├── ogr.util.js                           ← gọi ogr2ogr cho vector import
│   ├── http-stream-download.util.js          ← streaming download có checksum + size guard
│   ├── satellite-request.util.js             ← normalize/hash params + resolveClassifiedAnchor
│   ├── stage-logger.util.js                  ← makeStageLogger cho pipeline dài
│   └── optimistic-lock.util.js               ← version-based lock cho snapshot update
├── queues/
│   └── gee-task.queue.js                     ← singleton FIFO queue (concurrency=1) + dedup + cooldown
├── workers/                              ← child/thread process
│   ├── geeAnalysis.child.js                  ← chạy 1 analysis GEE trong child process riêng
│   ├── geeAnalysisProcess.worker.js          ← điều phối fork(child), enforce RSS/timeout, thu hồi RAM
│   ├── geeInterruptedRunRecovery.worker.js   ← startup recovery — đóng snapshot orphan sau restart
│   ├── districtRasterExport.worker.js        ← enqueue export per-district với priority thấp hơn
│   ├── rasterIngest.worker.js                ← cron poll + FOR UPDATE SKIP LOCKED claim job pending
│   ├── geoImport.worker.js                   ← xử lý vector import (shp/gpkg/geojson) từ user upload
│   ├── imageProcessing.worker.js             ← resize/compress/watermark ảnh (không phải GEE)
│   └── calcStats.thread.js                   ← worker_threads.pinBool để tính stats nặng
├── controllers/                          ← Express handler
│   ├── satellite.controller.js
│   ├── fire-risk.controller.js
│   ├── forest-classification.controller.js
│   ├── remote-sensing.controller.js
│   ├── raster-ingest.controller.js
│   ├── spatial.controller.js
│   ├── map.controller.js
│   ├── pdf-map.controller.js
│   ├── fire-gt.controller.js
│   ├── forest-gt.controller.js
│   └── layer-series.controller.js
├── routes/                               ← Express router (mount vào /api/v1/…)
│   ├── satellite.routes.js
│   ├── fire-risk.routes.js
│   ├── forest-classification.routes.js
│   ├── remote-sensing.routes.js
│   ├── spatial.routes.js
│   ├── map.routes.js
│   └── pdf-map.routes.js
├── repositories/                         ← PostgreSQL query layer
│   ├── fire-risk.repository.js               ← snapshot CRUD + retry state + failStaleActiveRuns
│   ├── forest-classification.repository.js
│   ├── satellite.repository.js               ← cache image_results theo hashParams
│   ├── raster-ingest.repository.js           ← claimPending (FOR UPDATE SKIP LOCKED), transition state
│   ├── remote-sensing.repository.js
│   ├── spatial.repository.js
│   ├── map-layer.repository.js               ← gis.layer_registry + gis.map_layers
│   ├── monitored-area.repository.js          ← per-district boundaries + expected count
│   ├── layer-series.repository.js
│   ├── fire-gt.repository.js
│   └── forest-gt.repository.js
├── validators/                           ← Joi/Zod schemas
│   ├── geo-import.validator.js
│   ├── layer-series.validator.js
│   ├── map-layer.validator.js
│   ├── pdf-map.validator.js
│   ├── raster-ingest.validator.js
│   ├── remote-sensing.validator.js
│   └── spatial.validator.js
├── middlewares/
│   ├── gee-rate-limit.middleware.js          ← per-user/IP throttle cho endpoint trigger GEE
│   ├── uploadGeoFile.middleware.js           ← multer + magic-byte cho shp/gpkg zip
│   └── uploadRaster.middleware.js            ← multer cho GeoTIFF upload trực tiếp
├── jobs/                                 ← các cronjob thuộc pipeline này (bản sao)
│   ├── fire-risk.job.js
│   ├── fire-risk-url-refresh.job.js
│   ├── forest-classification.job.js
│   └── satellite.job.js
├── database/
│   └── migrations/                       ← toàn bộ SQL migration thuộc domain GEE/spatial
│       └── (007, 008, 010-013, 019-024, 027, 029-035, 037, 038, 040-049)
├── scripts/
│   └── reset-fire-forest-data.js         ← script tay: xoá sạch snapshot + artifact fire+forest
└── docs/
    └── satellite-services.md             ← spec API on-demand (chuyển từ server/docs/)
```

> Nhiều file cross-domain: `fire-risk.job.js`, `forest-classification.job.js`, `satellite.job.js` cũng có bản sao trong [../corn_migration/jobs/](../corn_migration/README.md) — vì chúng vừa là cron **vừa là entry point của pipeline GEE**.

---

## 2. Kiến trúc tổng thể (Data Flow)

```
    ┌───────────────────────────────────────────────────────────────────┐
    │  CLIENT (Admin UI / Public map)                                   │
    │  - Tile URL trực tiếp từ GEE (Google CDN)                         │
    │  - WMS/WMTS từ GeoServer (tile đã publish)                        │
    │  - REST API /api/v1/{satellite,fire-risk,forest-classification}   │
    └────────────────────────────────┬──────────────────────────────────┘
                                     │
                       ┌─────────────┴─────────────┐
                       │  Express app + auth       │
                       │  gee-rate-limit           │
                       │  routes/ → controllers/   │
                       └─────────────┬─────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
        ┌──────────────────┐ ┌──────────────┐ ┌─────────────────┐
        │ services/*       │ │ pipelines/*  │ │ repositories/*  │
        │ (business logic) │ │ (GEE graphs) │ │ (PostgreSQL)    │
        └────────┬─────────┘ └──────┬───────┘ └─────────────────┘
                 │                  │
                 ▼                  ▼
        ┌───────────────────────────────────┐
        │   queues/gee-task.queue           │  concurrency=1, FIFO
        │   + workers/geeAnalysisProcess    │  fork child process
        └────────────────┬──────────────────┘
                         │
                         ▼
        ┌───────────────────────────────────┐
        │  Google Earth Engine (GEE)        │
        │  - authenticateViaPrivateKey      │
        │  - ee.Image / Feature graphs      │
        │  - Export.image.toCloudStorage()  │  → GCS bucket (GEE_GCS_BUCKET)
        │  - image.getDownloadURL()         │  → short-lived HTTPS
        │  - image.getMapId()               │  → tile CDN
        └──────────┬───────────────┬────────┘
                   │               │
                   ▼               ▼
        ┌────────────────┐ ┌──────────────────────┐
        │ Tile CDN       │ │ raster-ingest worker │
        │ (Google)       │ │ - stream download    │
        │ - front-end    │ │ - COG conversion     │
        │   dùng trực    │ │ - putObject MinIO    │
        │   tiếp         │ └───────┬──────────────┘
        └────────────────┘         │
                                   ▼
                     ┌───────────────────────────┐
                     │ MinIO (S3-compatible)     │  ← archive nguồn
                     │ buckets:                  │
                     │  - remote-sensing-images  │
                     │  - fire-risk-rasters      │
                     │  - forest-classification  │
                     │  - gee-rasters (ingest)   │
                     │  - satellite-rasters      │
                     │  - field-measurement-…    │
                     └───────────┬───────────────┘
                                 │
                                 ▼
                     ┌───────────────────────────┐
                     │ GeoServer                 │
                     │ workspace = kontum        │
                     │ - GeoTIFF CoverageStore   │  (FileSystem, đọc từ
                     │   /data/gee-rasters/*.tif │   GEOSERVER_DATA_DIR)
                     │ - PostGIS DataStore       │  (vector: monitored_area,
                     │   kontum_postgis          │   districts, map_layers)
                     └───────────┬───────────────┘
                                 │
                                 ▼
                       WMS / WMTS / WFS
                       → client (basemap overlay)
```

**Vì sao lại là 3 lớp storage (GEE → GCS → MinIO → GeoServer)?**

1. GEE `Export.image.toCloudStorage()` **bắt buộc** ghi vào GCS bucket — không cho ghi trực tiếp MinIO/S3 khác.
2. GCS là **transient** — không quản được RBAC nội bộ, giá lưu trữ đắt hơn MinIO.
3. **MinIO** = archive nội bộ, cấu hình S3-compatible, có ở data center Kon Tum.
4. **GeoServer** cần file trong `GEOSERVER_DATA_DIR` để phục vụ WMS. Ban đầu định dùng `gs-s3-geotiff` để GeoServer đọc trực tiếp MinIO (không cần copy 2 lần), nhưng **GeoServer 3.0.0 chưa port extension này** → fallback FileSystem: copy `/tmp/*.tif` → `${GEOSERVER_DATA_DIR}/gee-rasters/<store>.tif` → tạo CoverageStore.

---

## 3. Chi tiết các pipeline

### 3.1 Fire-Risk Pipeline (EP-06)

**Entry**: cron `fire-risk.job` 06:00 VN → `fire-risk.service.runAnalysis(date)`
**GEE graph**: `fire-risk.pipeline.js` (999 dòng) — mirror `docs/kontum_fire_warning_final.js` v8.1.

**Predictors** (30-day window, fallback 180-day):
- Sentinel-2: NDVI, NDMI, NBR
- MODIS LST (temp °C = LST × 0.02 − 273.15)
- ERA5-Land daily: rainfall + temp
- SRTM DEM: elevation, slope, aspect (southwest 180°-300° = drier)
- Fuel type raster (LOCAL_FUEL_TYPE_ASSET_ID → remap → fuelK ∈ [0, 1.35])

**Nesterov P Index**:
- 30-day lookback, daily accumulation `P += ((T + T_dew) × T)` với reset khi mưa > 5mm
- Breakpoints: `[5000, 10000, 15000, 20000]` — QĐ 25/2022/QĐ-UBND Phụ lục II
- Cho ra risk level 1-5 (ngưỡng threshold-based)

**Random Forest** (optional, `ENABLE_RF=true`):
- 100 trees, min-leaf 2, bag fraction 0.7, seed 42
- Training: 20 dry-season months (Jan-Apr 2019-2023)
- Labels: MCD64A1 burned (uncertainty ≤ 30 days) + FireCCI51 (confidence ≥ 50) + FIRMS (confidence ≥ 60, T21 ≥ 330K)
- Negative eligible mode: `relaxed_land_mask` (Tây Nguyên mây quá dày → strict mode ra 0 negative)

**Blend công thức**:
```
Without input:  Final = 0.60 × RF_score + 0.40 × Threshold_score
With input:     Final = 0.50 × Input_score + 0.30 × RF_score + 0.20 × Threshold_score
```

**Priority warning**:
- Level 3: model risk cao
- Level 4: có FIRMS hotspot trong 7 ngày qua (buffer 500m)
- Level 5: input asset `confirmed=1` (do cán bộ xác nhận)

**Data quality**:
- Level 0 (masked) khi cửa sổ không có S2 lẫn LST → nodata → GeoServer transparent

**Server-side after graph**:
1. `evaluate()` stats theo tỉnh + 10 huyện (reduceRegions)
2. `getEeMapId({ bands: RiskLevel, palette: 5-color })` → tile URL Google CDN
3. Nếu `GEE_GCS_BUCKET` set → `Export.image.toCloudStorage()` → task ID lưu vào snapshot
4. Nếu không có GCS: per-district `getDownloadURL()` → enqueue raster-ingest jobs (10 huyện)
5. Snapshot lưu `gis.fire_risk_snapshots` với `status ∈ {pending, computing, exporting, published, failed}`

**Poll (30′ tick)**: `svc.pollExports()` scan snapshot `exporting`, gọi `pollGeeTask(taskId)`:
- Nếu COMPLETED: download từ GCS → putObject MinIO → copy vào GeoServer data dir → tạo coverage store → UPDATE `status=published`, `geoserver_store`, `geoserver_layer`
- Nếu FAILED: `status=failed`, giữ nguyên gee_task_id để debug

**URL refresh (5′ tick)**: xem `fire-risk-url-refresh.job` — regen URL nếu worker gặp 401.

### 3.2 Forest Classification Pipeline (v5.3 — 13 classes)

**Entry**: cron `forest-classification.job` 00:00 ngày 1 mỗi tháng → `runAnalysis(prevYear, prevMonth)`
**GEE graph**: `forest-classification.pipeline.js` (1028 dòng).

**Schema 13 lớp** (0-12):
```
 0 Không có ảnh (nodata)
 1 Đất khác (bare/rangeland)
 2 Cây công nghiệp (rubber/coffee)
 3 Đất nông nghiệp
 4 Rừng hỗn giao lá rộng/lá kim
 5 Rừng lá rộng thường xanh
 6 Rừng lá kim
 7 Rừng lá rộng rụng lá  (chỉ ~516 ha)
 8 Rừng tre nứa
 9 Rừng trồng
10 Sông, suối, hồ
11 Trảng cỏ, cây bụi
12 Không xác định
```

**Forest classes** (theo QĐ 99/QĐ-UBND 28/02/2025): `{4, 5, 6, 7, 8, 9}` — class 2 (cao su) **không tính là rừng**.

**Cửa sổ mùa** (anchor = `monthStart` = ngày 1 tháng kế sau):
- `base`   — 12 tháng gần nhất
- `green`  — 3 tháng xanh gần nhất (Sept-Nov)
- `dry`    — Mar-Apr (cao su đã ra lá lại)
- `defol`  — Jan-Feb (cao su trơ cành)
- `recent` — 3 tháng gần nhất

**Master collection** (v4.1 khác biệt then chốt): dựng MỘT LẦN per `(startDate, endDate, year)` từ Landsat 5/7/8/9 + Sentinel-2, sau đó filter theo season → tránh materialize graph 5 lần.

**Landsat harmonization** (Roy et al. 2016): TM/ETM+ → OLI reflectance bằng slope + intercept 6-band → chuỗi 1991→nay không gãy tại 2013.

**Feature image**: 27 bands (v3 là 26) gồm indices (NDVI/NDWI/MNDWI/NDMI/NBR/BSI/EVI), amplitude drop/recov, dNBR, terrain sin/cos aspect.

**Random Forest**: 100 trees, min-leaf 3, 6 vars/split, bag 0.7.

**Sampling budget** (v4.1: sqrt-based quotas):
- `SAMPLE_BUDGET = 1800` mẫu tổng
- Quota per class = `clamp(sqrt(AREA_PRIOR[class]) × factor, SAMPLE_MIN=60, SAMPLE_MAX=450)`
- Lớp hiếm (< 20,000 ha) lấy mẫu ở `SAMPLE_SCALE_RARE_M = 60m` (thay vì 100m default)

**Ground-truth split spatial** (v4.1 fix): chia GT theo block 5000m, train:test = 70:30 — random điểm ở v3 khiến train/test cùng lô → accuracy ảo.

**Gate**: nếu < 8 classes có ≥ MIN_TRAIN_PER_CLASS=40 → KHÔNG train RF, fallback threshold-only.

**Priority mosaic** (v4.1-F fix): rừng (8/4/7/3/6/5) đè cây công nghiệp (class 1) → fix nguyên nhân class 1 dư +223,850 ha ở v3.

**Naturalness two-way exclusion**: naturalCore ⊥ {class 1, 2, 10}.

**Server-side after graph**:
1. Province summary + per-district reduceRegions
2. Diff với snapshot tháng trước → alert nếu Δ > `FC_ALERT_CHANGE_PCT = 2.0%`
3. `getDownloadURL()` per district (bắt buộc, không dùng GCS export theo v3 lite mode) → enqueue 10 raster-ingest jobs
4. Snapshot lưu `gis.forest_classification_snapshots`

**Lite mode** (`/satellite/classified`): `LITE_SAMPLE_BUDGET = 1260` (0.7×), `LITE_RF_TREES = 80`, skip OOB accuracy (nguyên nhân 5-min timeout ở v3).

### 3.3 Satellite On-Demand (5 endpoints)

`POST /api/v1/satellite/{imageType}` — user request → GEE compute → trả tile URL hoặc download URL.

Image types + service key routing (xem `satellite.service.js`):
- `rgb` — S2/Landsat RGB composite (median trong window)
- `ndvi` / `ndwi` / `ndbi` / `evi` — chỉ số phổ (band arithmetic)
- `classified` — chạy `forest-classification.pipeline` **lite mode** (không cần snapshot)
- `fire-risk` — chạy `fire-risk.pipeline` cho ngày cụ thể (không lưu snapshot)

**Cache**: `hashParams(params)` = SHA256 của `{imageType, collection, cloudCover, startDate, endDate, month, geometry, groundTruth, analysisDate, enableRf}` → `image_results.hash_key`. Cache hit → trả `geeTileUrl` cũ trong window `GEE_TEMPORARY_URL_MAX_AGE_MS = 4h`.

**Publish** (`POST /satellite/publish`): tách 2 pha — user gọi 1 lần để **submit** GEE export task, poll 30′ (satellite.job) để harvest và publish. Response async, không block request.

**Tile flow**: KHÔNG proxy qua Node.js — client gọi thẳng `https://earthengine.googleapis.com/…` bằng `geeTileUrl`. Giấu API key nhưng lộ mapId (chỉ handle, không phải secret cá nhân). Ưu điểm: tile qua Google CDN nhanh, Node.js không thành bottleneck.

### 3.4 Raster Ingest Pipeline (URL → GeoServer)

**Entry**: `raster-ingest.service.enqueue({ sourceUrl, layerCode, requestParams, user })` — được gọi bởi:
- Fire-risk service (10 huyện × 1 URL mỗi lần chạy analysis)
- Forest service (tương tự)
- Admin manual publish
- Reprocess sau `url_expired`

**State machine** (`raster_ingest_jobs.status`):
```
pending  →  downloading  →  validating  →  uploading  →  publishing  →  completed
    │                                                                          │
    ├── url_expired  ← HTTP 401 → xử lý bởi fire-risk-url-refresh.job         │
    │                                                                          │
    └── failed (sau MAX_RETRIES=3 với exponential backoff 15s→2min)           ┘
```

**Worker**: `rasterIngest.worker` — `node-cron` poll `*/15 * * * * *` (mỗi 15s):
1. `rasterRepo.claimPending({ batchSize=1 })` — `SELECT … FOR UPDATE SKIP LOCKED` — race-safe với nhiều instance
2. Với mỗi job:
   - **downloading**: `http-stream-download.util` → `/tmp/kontum_gee_ingest/<uuid>.zip` với size guard `RASTER_INGEST_MAX_MB = 3072`
   - **validating**: detect zip (GEE zip có nhiều band files) vs tiff (single); nếu zip + có `gdal_merge.py` → merge → COG; nếu không có GDAL → passthrough
   - **uploading**: `minio.putObject('gee-rasters', <key>, stream)` với multipart tự động
   - **publishing**: `fs.copyFileSync(tmp, $GEOSERVER_DATA_DIR/gee-rasters/<store>.tif)` → `geoserver.createGeoTiffCoverageStore()` → upsert `gis.layer_registry` + `gis.map_layers`
   - **completed**: `fs.unlink(tmp)` best-effort

**Concurrency**: hard-coded `CONCURRENCY = 1` — GEE Restricted Mode không cho song song `getPixels()`, và merge GDAL RSS ~1-2GB.

**Retry backoff**: DB column `next_attempt_at` (migration 035) với `backoff = base × 2^attempt`, capped 2 phút.

### 3.5 Weather (không GEE nhưng chung stack)

Xem [../corn_migration/README.md §4.7](../corn_migration/README.md#47-weatherjob) — chỉ nêu ở đây để tránh trùng.

---

## 4. Queue GEE — concurrency=1 dùng chung

Nguồn: `queues/gee-task.queue.js`.

**Vì sao concurrency=1?**
- GEE Node.js SDK không thread-safe cho evaluate() song song
- Restricted Mode API quota: `getPixels`/`getDownloadURL` giới hạn ~1 concurrent request/service account
- Fork child process: RSS ~1.5-2GB per graph → 2 song song đủ OOM VPS 4GB

**API**:
```js
geeQueue.enqueue({
  key:        'fire-risk:2026-08-04',   // dedup key — cùng key → return promise cũ
  label:      'Fire risk analysis 2026-08-04',
  priority:   0,                         // higher = chạy trước; district export dùng -10
  cooldownMs: 10 * 60 * 1000,            // sau khi xong, key này bị chặn 10′
  run: async () => { … }                 // async task
});
```

**Preflight lỗi**:
- `PROCESSING_QUEUE_STOPPING` (503) — server đang shutdown
- `PROCESSING_REQUEST_COOLDOWN` (429) — key vừa xong, còn trong cooldown
- `PROCESSING_QUEUE_FULL` (503) — `MAX_PENDING = 6` (env `GEE_QUEUE_MAX_PENDING`)

**Cooldown**: `MANUAL_TASK_COOLDOWN_MS = 10 phút` — chặn user admin retry liên tục cùng ngày → tránh spam GEE quota.

**Dedup**: cùng key trong lúc còn active → trả về Promise gốc thay vì enqueue mới.

---

## 5. GeoServer client

Nguồn: `utils/geoserver.client.js` — thin wrapper cho GeoServer REST API `/geoserver/rest`.

**Auth**: HTTP Basic (`GEOSERVER_USER` / `GEOSERVER_PASSWORD`).

**Ops được implement**:
- `createGeoTiffCoverageStore(store, filePath)` — POST `/workspaces/{ws}/coveragestores`
- `deleteCoverageStore(store)` — DELETE với `recurse=true` (xoá luôn layer, style bind)
- `publishLayer(dataStore, table, layerName)` — cho vector từ PostGIS
- `unpublishLayer(layer)` — DELETE `/layers/{layer}` (không xoá store)
- `applyStyle(layer, styleName)` — set default SLD
- `healthCheck()` — GET `/rest/about/version` với timeout 3s

**Timeout**: `GEOSERVER_TIMEOUT_MS = 15000` (default).

**Whitelist WMS params**: `configs/geoserver.js` giới hạn param client có thể pass-through proxy WMS/WFS để chống SSRF.

---

## 6. MinIO buckets — quy hoạch

| Bucket                        | Purpose                                          | Config env                                |
|-------------------------------|--------------------------------------------------|-------------------------------------------|
| `remote-sensing-images`       | Ảnh vệ tinh admin upload trực tiếp               | `MINIO_BUCKET_REMOTE_SENSING`             |
| `field-measurement-photos`    | Ảnh điều tra hiện trường (mobile app)            | `MINIO_BUCKET_FIELD_MEASUREMENTS`         |
| `gee-rasters`                 | Ingest từ GEE download URL (raster-ingest)       | `MINIO_BUCKET_GEE_RASTER`                 |
| `fire-risk-rasters`           | Snapshot fire-risk hàng ngày (GCS harvest)       | `FIRE_RISK_MINIO_BUCKET`                  |
| `forest-classification`       | Snapshot forest hàng tháng                       | `FC_MINIO_BUCKET`                         |
| `satellite-rasters`           | Publish từ on-demand satellite                   | `SATELLITE_MINIO_BUCKET`                  |

Bucket tự tạo trong `configs/minioClient.js:initMinio()` khi server startup (3 bucket đầu). Các bucket còn lại tạo bằng tay hoặc lần đầu ingest.

**Presigned URL**: `MINIO_PRESIGNED_EXPIRE_SECONDS = 900` (15′) cho download, `MINIO_UPLOAD_PRESIGNED_EXPIRE_SECONDS = 3600` (1h) cho upload.

---

## 7. Child process runner (bảo vệ RAM)

**Vấn đề**: một GEE analysis (`fire-risk` full pipeline) evaluate() giữ heap ~1.5GB. Nếu chạy trong process HTTP chính → không thu hồi được (GEE SDK giữ reference qua native buffers). Sau vài chục lần chạy → PM2 kill vì OOM.

**Giải pháp**: `workers/geeAnalysisProcess.worker.js` — `fork('geeAnalysis.child.js')` mỗi lần chạy analysis:
- Child chỉ chứa 1 Earth Engine graph
- Chạy xong → `process.exit(0)` → OS thu hồi TOÀN BỘ heap/native buffers
- Enforce `--max-old-space-size = GEE_CHILD_MAX_OLD_SPACE_MB = 1536MB`
- Enforce RSS: parent poll `pidusage`, kill child nếu RSS > `GEE_CHILD_MAX_RSS_MB = 2048MB`
- Timeout `GEE_CHILD_TIMEOUT_MS = 30′`

Kết quả stats truyền về parent qua `process.send(payload)` (JSON serializable — không truyền EE object).

---

## 8. Recovery sau restart

`workers/geeInterruptedRunRecovery.worker` chạy **1 lần** ngay sau khi runtime lấy được advisory lock (trước khi start bất kỳ cron nào):

1. `fireRepo.failInterruptedActiveRuns()` — `UPDATE fire_risk_snapshots SET status='failed' WHERE status IN ('pending','computing','exporting')` — vì process cũ chắc chắn đã chết
2. Tương tự cho `forestRepo.failInterruptedActiveRuns()` và `failInterruptedDistrictExports()`
3. Với mỗi snapshot vừa fail: gom theo `analysis_date` / `(year, month)` → tạo attempt MỚI qua `svc.runAnalysis()` — không cần chờ watchdog

**Migration 040 (reset_fire_forest_v2)**: đổi schema từ 1 dòng/period → nhiều attempts/period (mỗi lần chạy = 1 dòng). Các guard `hasCompletedAttempt(date)` / `countFailedAttempts(date)` được thêm để tránh watchdog trigger lại khi có attempt failed mới đè lên completed cũ.

---

## 9. Danh sách migrations SQL liên quan

Đã copy vào `database/migrations/`:

```
007_remote_sensing.sql                          — bảng ảnh vệ tinh upload
008_gis_layer_registry.sql                      — registry cho tất cả layer
010_map_layer_crud_import.sql                   — CRUD layer + import shp/geojson
011_map_layer_backfill_geometry_column.sql
012_layer_registry_classification.sql
013_layer_edit_history_nullable_layer_id.sql
013_pdf_maps.sql                                — pdf-map service tables
019_fire_risk.sql                               — snapshots + retry state
020_satellite.sql                               — image_results cache
021_forest_classification_logs.sql
022_remote_sensing_geoserver_publish.sql
023_forest_data_historical.sql
024_revoke_so_nnmt_upload_publish.sql
027_forest_classification_v3_metrics.sql
029_gee_tile_url_columns.sql
030_fire_risk_download_url.sql
031_raster_ingest_jobs.sql                      — pipeline URL→MinIO→GeoServer
032_fire_ground_truth.sql
033_forest_ground_truth.sql
034_add_soft_delete_to_gis_and_notifications.sql
034_forest_download_url.sql
035_raster_ingest_backoff.sql                   — exponential backoff column
036_clear_fire_risk_forest_classification_history.sql
037_fire_risk_oob_accuracy.sql
038_forest_classification_v53_schema.sql        — schema 13-class v5.3
040_reset_fire_forest_v2.sql                    — multi-attempt schema
041_dashboard_uses_forest_snapshots.sql
042_fire_risk_scale_defaults_150.sql            — EXPORT_SCALE_M 100→150
043_raster_ingest_url_expired.sql               — status url_expired
044_raster_ingest_layer_code_index.sql
045_layer_series.sql                            — time-series layers
046_clear_forest_classification_history.sql
047_clear_fire_risk_history.sql
048_clear_fire_risk_seed_field_measurements.sql
049_forest_fire_role_permissions.sql
```

Chạy migrations bằng `node server/src/database/migrate.js up`. Baseline schema (đã squash) ở `server/src/database/baseline_schema_20260728.sql`.

---

## 10. Env vars — bảng nhanh

```dotenv
# ── Google Earth Engine ─────────────────────────────────────────────────────
# Service key path đọc bởi configs/gge.js (require relative)
# ⚠️ FILE THẬT phải nằm ở server/ggeServiceKey.json (không phải trong gee_migration)
GOOGLE_APPLICATION_CREDENTIALS=./ggeServiceKey.json    # dùng cho @google-cloud/storage

# ── GCS (raster export) ─────────────────────────────────────────────────────
GEE_GCS_BUCKET=                          # để trống → skip GCS export path
                                          # fire-risk fallback dùng per-district getDownloadURL

# ── MinIO ───────────────────────────────────────────────────────────────────
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_USE_SSL=false
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_REGION=us-east-1
MINIO_BUCKET_REMOTE_SENSING=remote-sensing-images
MINIO_BUCKET_FIELD_MEASUREMENTS=field-measurement-photos
MINIO_BUCKET_GEE_RASTER=gee-rasters
FIRE_RISK_MINIO_BUCKET=fire-risk-rasters
FC_MINIO_BUCKET=forest-classification
SATELLITE_MINIO_BUCKET=satellite-rasters
MINIO_PRESIGNED_EXPIRE_SECONDS=900
MINIO_UPLOAD_PRESIGNED_EXPIRE_SECONDS=3600

# ── GeoServer ───────────────────────────────────────────────────────────────
GEOSERVER_URL=http://localhost:8080/geoserver
GEOSERVER_USER=admin
GEOSERVER_PASSWORD=geoserver
GEOSERVER_WORKSPACE=kontum
GEOSERVER_NAMESPACE_URI=https://gis.kontum.gov.vn/kontum
GEOSERVER_DATASTORE=kontum_postgis
GEOSERVER_DATA_DIR=/var/lib/geoserver/data       # required cho raster-ingest publish
GEOSERVER_TIMEOUT_MS=15000

# ── Raster ingest pipeline ──────────────────────────────────────────────────
RASTER_INGEST_ENABLED=true
RASTER_INGEST_MAX_MB=3072
RASTER_INGEST_FETCH_TIMEOUT_MS=900000
RASTER_INGEST_MAX_RETRIES=3
RASTER_INGEST_CONCURRENCY=1               # KHÔNG nâng — hard-clamped
RASTER_INGEST_TMP_DIR=/tmp/kontum_gee_ingest
RASTER_INGEST_WORKER_POLL_CRON=*/15 * * * * *
RASTER_INGEST_DEBUG=false
GDAL_CACHEMAX_MB=512

# ── GEE queue + child process ──────────────────────────────────────────────
GEE_QUEUE_MAX_PENDING=6
GEE_QUEUE_RECENT_RETENTION_MS=3600000
GEE_MANUAL_COOLDOWN_MS=600000              # 10′ cooldown giữa 2 request cùng key
GEE_CHILD_MAX_RSS_MB=2048
GEE_CHILD_MAX_OLD_SPACE_MB=1536
GEE_CHILD_TIMEOUT_MS=1800000               # 30′

# ── Fire-risk pipeline ──────────────────────────────────────────────────────
FIRE_RISK_FEATURE_WINDOW_DAYS=30
FIRE_RISK_S2_FALLBACK_DAYS=180
FIRE_RISK_LST_FALLBACK_DAYS=180
FIRE_RISK_NESTEROV_LOOKBACK_DAYS=30
FIRE_RISK_ENABLE_RF=true
FIRE_RISK_RF_TREES=100
FIRE_RISK_RF_BAG_FRACTION=0.70
FIRE_RISK_RF_MIN_LEAF=2
FIRE_RISK_TRAIN_SCALE_M=500
FIRE_RISK_TRAIN_SAMPLES=100
FIRE_RISK_TILE_SCALE=16
FIRE_RISK_MIN_SAMPLES_PER_CLASS=20
FIRE_RISK_EXPORT_SCALE_M=150               # 100→150 sau khi HTTP 400 memory limit
FIRE_RISK_INPUT_FIRE_ASSET_ID=             # optional GEE FC với input_score
FIRE_RISK_LOCAL_FUEL_TYPE_ASSET_ID=        # optional GEE Image lớp phủ 11-class
FIRE_RISK_COMPUTE_OOB=false                # bật để đo accuracy — cost 30-90s
FIRE_RISK_OOB_TIMEOUT_MS=600000
FIRE_RISK_RF_GUARD_TIMEOUT_MS=180000
FIRE_RISK_GEE_TIMEOUT_MS=300000
FIRE_RISK_GEE_POLL_MS=30000
FIRE_RISK_GEE_POLL_MAX=40
FIRE_RISK_ACTIVE_RUN_MAX_AGE_MS=2700000    # 45′ — sau đó snapshot bị mark stale
FIRE_RISK_GEE_TEMPORARY_URL_MAX_AGE_MS=14400000   # 4h
FIRE_RISK_EXPECTED_DISTRICT_COUNT=10

# ── Forest classification pipeline ─────────────────────────────────────────
FC_RF_TREES=100
FC_RF_MIN_LEAF=3
FC_RF_VARS_SPLIT=6
FC_RF_BAG_FRACTION=0.70
FC_SAMPLE_BUDGET=1800
FC_SAMPLE_MIN=60
FC_SAMPLE_MAX=450
FC_MIN_TRAIN_PER_CLASS=40
FC_GATE_NO_TRAIN=8
FC_SAMPLE_SCALE_M=100
FC_SAMPLE_SCALE_RARE_M=60
FC_CLASSIFY_SCALE_M=30
FC_AREA_STATS_SCALE_M=100
FC_DISPLAY_SCALE_M=200
FC_TILE_SCALE=8
FC_MAX_LS_CLOUD=70
FC_MAX_S2_CLOUD=50
FC_GT_BLOCK_M=5000
FC_GT_TRAIN_FRAC=0.7
FC_GT_BUFFER_M=150
FC_ALERT_CHANGE_PCT=2.0
FC_EXPORT_SCALE_M=150
FC_DOWNLOAD_SCALE_M=150
FC_EXPECTED_DISTRICT_COUNT=10
FC_GEE_TEMPORARY_URL_MAX_AGE_MS=14400000
FC_OOB_TIMEOUT_MS=600000
FC_LITE_SAMPLE_BUDGET=1260
FC_LITE_RF_TREES=80

# ── Satellite on-demand ─────────────────────────────────────────────────────
SATELLITE_EXPORT_SCALE_M=30
SATELLITE_DEBUG=false
```

---

## 11. Các script vận hành

- `scripts/reset-fire-forest-data.js` — xoá sạch snapshot fire+forest + artifact MinIO + GeoServer coverage. **NGUY HIỂM** — dùng khi bootstrap môi trường mới hoặc thay schema. Đọc code trước khi chạy.
- Trong repo còn có `server/scripts/diag-districts.js` và `repair-district-names.js` không được copy vì thuộc data-repair one-off, không phải pipeline.

---

## 12. Tài liệu tham chiếu

- [docs/satellite-services.md](./docs/satellite-services.md) — spec API on-demand chi tiết
- `server/docs/modules/*.md` (không copy) — 08 modules design docs (weather, fire, forest, spatial, mobile…)
- `docs/kontum_fire_warning_final.js` (GEE Code Editor script v8.1) — reference gốc của `fire-risk.pipeline.js`
- `docs/kontum_forest_classification_final.js` (GEE Code Editor script v5.3) — reference gốc của `forest-classification.pipeline.js`
- Memory: `project_fire_risk_ep06`, `project_satellite_forest_modules`, `project_satellite_geoserver_tests`, `project_fire_risk_per_district`

---

## 13. Đánh giá hiện trạng — điểm mạnh & điểm yếu

### 13.1 Điểm mạnh (nên GIỮ)

| # | Pattern                                                                          | Vì sao hợp lý                                                                                                                     |
|---|----------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------|
| 1 | **Concurrency=1 cho GEE queue**                                                  | GEE SDK Node.js không thread-safe cho evaluate() song song; quota Restricted Mode ~1 concurrent request/service account            |
| 2 | **Child process isolation cho analysis** (`geeAnalysisProcess.worker`)           | OS thu hồi 100% heap/native buffers khi child exit — không leak vào runtime HTTP chính                                             |
| 3 | **State machine rõ ràng** cho raster ingest (pending → downloading → … → completed) | Dễ debug: nhìn 1 dòng DB biết job đang ở đâu, có bao nhiêu lần retry                                                              |
| 4 | **`FOR UPDATE SKIP LOCKED`** trong `rasterRepo.claimPending`                     | Race-safe với nhiều worker instance, không dùng lock table hay Redis                                                              |
| 5 | **Dedup key + cooldown 10′** trong GEE queue                                     | User bấm nút chạy lại 5 lần liên tiếp không tạo 5 GEE task — tiết kiệm quota + tránh spam                                          |
| 6 | **Pipeline tách khỏi service** (`fire-risk.pipeline.js` shared với `satellite.service`) | Không duplicate GEE graph — cron snapshot và on-demand `/satellite/fire-risk` dùng chung 1 source of truth                          |
| 7 | **Tile CDN Google trực tiếp** — không proxy qua Node.js                          | Node.js không thành bottleneck; user latency thấp; giấu được API key (mapId chỉ là handle)                                        |
| 8 | **Hash params cho cache** (`satellite.service.hashParams`)                       | 5 endpoints on-demand không double-compute nếu cùng bbox/date; hit cache trong 4h                                                 |
| 9 | **Startup recovery** (`geeInterruptedRunRecovery`)                               | Không phải chờ watchdog 45′ khi restart giữa run — user thấy status update trong ≤ 60s                                            |
|10 | **GCS optional + fallback per-district**                                         | Deploy được ở môi trường không có Google Cloud (chỉ MinIO nội bộ); trade-off: 10× getDownloadURL calls chấp nhận được              |
|11 | **Migration 040 multi-attempt schema**                                           | Cho phép retry mà không ghi đè kết quả completed cũ — audit trail đầy đủ                                                          |

### 13.2 Điểm yếu — cần khắc phục

| # | Vấn đề                                                                                                     | Rủi ro thực tế                                                                                                       | Ưu tiên |
|---|------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------|---------|
| A | **Service key JSON commit vào repo** (`ggeServiceKey.json`, `anotherGgeServiceKey.json`)                   | Leak GCP credentials nếu repo public — attacker chạy được GEE task với quota của tổ chức                             | **P0**  |
| B | **Không có GEE quota monitoring**                                                                          | Đến khi user gọi mới biết đã hết quota; không có early warning "còn 20% quota"                                        | **P0**  |
| C | **`RASTER_INGEST_MAX_RETRIES=3` cứng, không có dead-letter queue**                                          | Sau 3 fail: `status='failed'`, DB row nằm im, ops phải phát hiện thủ công qua query                                   | P1      |
| D | **GeoServer & DB không có sync check** — snapshot `status='published'` nhưng layer có thể đã bị xoá tay     | User click layer → 404, admin không biết đến khi user complain                                                        | P1      |
| E | **Poll cron 15s cho raster-ingest** — không event-driven                                                    | Latency: job enqueue rồi đợi 15s mới xử lý; nhiều tick idle waste CPU (dù nhẹ)                                        | P2      |
| F | **URL expiration hardcoded 4h** cho GEE                                                                    | Nếu GEE thay đổi ngầm về 2h → mọi worker gặp 401, cần patch lại constant                                              | P2      |
| G | **Concurrency=1 GEE queue là bottleneck**                                                                  | 1 fire-risk analysis ~7-10′ + 1 forest ~15-20′ + 10 district export ~30s each → user chờ tối đa 30′+ trong peak       | P1      |
| H | **Không có "warm compile" cho GEE graph**                                                                  | Mỗi request rebuild toàn bộ graph — cache image `Export.image.toCloudStorage()` là possible nhưng chưa làm            | P2      |
| I | **MinIO bucket tạo ad-hoc** — 6 bucket, chỉ 3 auto-create trong `initMinio`                                | Deploy môi trường mới: 3 bucket còn lại cần tạo tay, lần đầu ingest sẽ fail                                           | P1      |
| J | **`GEE_CHILD_MAX_RSS_MB = 2048` cứng** cho mọi child                                                       | Forest v5.3 có thể spike > 2GB tạm thời (materialize 27-band feature); nếu kill giữa training → mất dữ liệu           | P1      |
| K | **Không có structured metrics cho GEE latency**                                                            | Không biết trung bình fire-risk mất bao lâu, so sánh v5 vs v6 sau upgrade                                             | P1      |
| L | **`gs-s3-geotiff` không dùng được → phải copy 2 lần** (MinIO + local FS)                                    | Disk usage 2× cần thiết cho `GEOSERVER_DATA_DIR`, sync issue nếu copy fail giữa chừng                                 | P2      |
| M | **Không có blue/green pipeline version**                                                                   | v3→v4→v5.3 upgrade từng đau: schema đổi, class ID đổi, tính toán khác — không rollback được không lịch                | P2      |
| N | **`districtRasterExport.worker` priority=-10** cứng                                                        | Không tune được: đôi khi cần huyện quan trọng (Sa Thầy) chạy trước — không có UI đổi priority                          | P3      |
| O | **Test coverage thấp** cho pipeline (`utils/__tests__/*.test.js` chỉ 2 file)                               | Refactor pipeline v5→v6 sẽ risk regression cao; không có golden dataset để so sánh output                             | P1      |
| P | **`fire-risk.pipeline` 999 dòng + `forest.pipeline` 1028 dòng** — monolithic                               | Khó review PR nhỏ; ai đọc mới mất 2 giờ để nắm; hàm quá dài không unit-testable từng bước                              | P2      |
| Q | **GCS bucket không có lifecycle policy trong code** — chỉ trong console GCP                                | Nếu ops quên set → GCS bill tăng vô hạn                                                                                | P2      |
| R | **`geoserver.client.js` không có retry** — 1 network glitch → job fail                                     | Reliability thấp không cần thiết cho ops nội bộ                                                                        | P2      |
| S | **`raster-ingest` không validate CRS của GeoTIFF** trước khi publish                                       | Nếu GEE trả CRS lạ (không phải EPSG:4326/32648) → GeoServer publish thành công nhưng layer render sai                 | P1      |
| T | **Không có audit log** cho manual trigger `POST /satellite/publish`                                        | Ai bấm publish, khi nào, tham số gì → không truy được sau incident                                                    | P2      |
| U | **`geeAnalysis.child.js` communication qua stdin/stdout JSON** — payload size limit không rõ              | Nếu stats trả về > 1MB (VD 100 districts × 20 fields) → có thể fail                                                    | P3      |

---

## 14. Kế hoạch cải thiện (roadmap)

### 14.1 P0 — Trong 2 tuần (security + operational visibility)

#### 14.1.1 Di dời service key ra khỏi repo
- **Đề xuất**:
  - Ngắn hạn: `.gitignore` `ggeServiceKey.json`, đưa vào **1Password Secrets** hoặc **HashiCorp Vault**
  - Runtime: mount volume `/run/secrets/gee.json` (Docker secret) → `configs/gge.js` đọc bằng `fs.readFileSync(process.env.GEE_KEY_PATH)`
  - Rotate key: revoke key cũ trên GCP console sau khi confirm deploy mới ổn (1 tuần grace)
- **Effort**: 2 ngày + review IAM
- **Rủi ro**: nếu key đã commit lâu → giả định leaked, phải rotate ngay

#### 14.1.2 GEE quota dashboard + alert sớm
- **Đề xuất**:
  - Cron 15′ gọi GCP Monitoring API để đọc:
    - `earthengine.googleapis.com/quota/requests/rate` (per minute)
    - `storage.googleapis.com/storage/total_bytes` (bucket size)
  - Lưu vào Postgres bảng `gee_quota_history(ts, metric, value)`
  - Alert khi:
    - Rate > 80% quota trong 5′ liên tiếp → warn
    - Rate > 95% → critical (block user request thủ công)
    - GCS bucket > 90% budget → warn
- **Effort**: 4-5 ngày
- **Phụ thuộc**: cần service account có quyền `roles/monitoring.viewer`

### 14.2 P1 — Trong 1-2 tháng (reliability + observability)

#### 14.2.1 Dead-letter queue cho raster-ingest
- Sau `MAX_RETRIES` fail: chuyển sang bảng `raster_ingest_dlq` (giữ nguyên payload)
- Admin UI list DLQ items, cho phép:
  - **Retry**: chuyển lại `raster_ingest_jobs.status='pending'`
  - **Discard**: xoá + xoá artifact MinIO liên quan
  - **Diagnose**: xem log full stack trace từ `job_run_history`
- **Effort**: 5-7 ngày

#### 14.2.2 GeoServer ↔ DB sync check
- Cron hàng ngày (VD 04:00 VN):
  - Lấy list layer từ GeoServer REST API
  - Lấy list `layer_registry` với `status='published'` từ DB
  - Report diff:
    - **Orphan GeoServer layer** (không có DB record) → xoá
    - **Orphan DB record** (không có GeoServer layer) → mark `status='deleted_upstream'` + alert
- **Effort**: 4-5 ngày

#### 14.2.3 GEE metrics + Grafana dashboard
- Bảng `gee_run_history(id, kind, snapshot_id, started_at, finished_at, status, error_code, elapsed_ms, gee_task_id, cost_units)`
- Ghi từ `fire-risk.service` và `forest.service` sau mỗi run
- Dashboard row: fire-risk, forest, satellite on-demand (× success rate, p50/p95 latency, cost/day)
- **Effort**: 5-7 ngày

#### 14.2.4 Concurrency=2 với affinity theo pipeline kind
- Queue thứ 2 riêng cho `district-export` (priority thấp, không xung đột analysis heavy)
- Analysis fire + forest vẫn concurrency=1 chung
- Cần benchmark GEE quota để confirm không hit 429
- **Effort**: 3-4 ngày + 1 tuần soak test
- **Rủi ro**: nếu GEE quota strict hơn hình dung → phải rollback về 1

#### 14.2.5 Auto-create tất cả MinIO buckets tại startup
- Move bucket list vào `configs/minio-buckets.js`:
  ```js
  module.exports = [
    { name: 'remote-sensing-images',   public: false },
    { name: 'field-measurement-photos', public: false },
    { name: 'gee-rasters',             public: false },
    { name: 'fire-risk-rasters',       public: false, lifecycle: { expireDays: 180 } },
    { name: 'forest-classification',   public: false, lifecycle: { expireDays: 730 } },
    { name: 'satellite-rasters',       public: true,  cache: { maxAgeSec: 3600 } },
  ];
  ```
- `initMinio()` loop tạo hết + set policy
- **Effort**: 2-3 ngày

#### 14.2.6 CRS validation trước khi publish
- Sau download COG: `gdalinfo --json` → parse `coordinateSystem.wkt`
- Nếu không phải `EPSG:4326` hoặc `EPSG:32648/32649` (UTM Kon Tum) → reproject bằng `gdalwarp` trước khi publish
- Log warn để ops biết pipeline có drift từ GEE
- **Effort**: 3 ngày

#### 14.2.7 Auto-tune `GEE_CHILD_MAX_RSS_MB` per pipeline kind
- Fire-risk: 2GB (OK hiện tại)
- Forest v5.3: 3GB (materialize 27-band + RF sampling)
- Satellite on-demand: 1.5GB (nhẹ, không train RF)
- Set qua `configs/gee-child-limits.js` map by kind
- **Effort**: 1 ngày

#### 14.2.8 Test suite golden dataset
- Snapshot output fire-risk cho 1 ngày cố định (VD 2026-01-15) làm baseline
- Regression test: sau mỗi refactor, chạy pipeline → so sánh histogram RiskLevel với baseline, tolerance ±2%
- Chạy trong CI (Jest + fixture GeoTIFF)
- **Effort**: 5-7 ngày setup + 3-5 ngày cho forest

#### 14.2.9 OpenTelemetry cho pipeline
- Trace mỗi analysis run: span cho từng stage (`compute_predictors`, `train_rf`, `evaluate_stats`, `export_gcs`, `poll_task`, `harvest`)
- Duration + attributes (num_districts, num_features, cache_hit)
- Ship về Jaeger hoặc Tempo
- **Effort**: 3-4 ngày

### 14.3 P2 — 3-6 tháng (architecture polish)

#### 14.3.1 Refactor pipeline monolith → modules
- `fire-risk.pipeline.js` chia thành:
  - `pipeline/fire-risk/predictors.js` (S2, LST, ERA5, terrain, fuel)
  - `pipeline/fire-risk/nesterov.js`
  - `pipeline/fire-risk/rf.js`
  - `pipeline/fire-risk/blend.js`
  - `pipeline/fire-risk/index.js` (orchestrate)
- Mỗi module unit-testable với GEE mock
- **Effort**: 2 tuần

#### 14.3.2 Event-driven raster ingest (Postgres LISTEN/NOTIFY)
- Thay poll 15s: `INSERT INTO raster_ingest_jobs` → trigger `NOTIFY new_ingest_job`
- Worker `LISTEN new_ingest_job` → wake ngay
- Giảm latency 7.5s (trung bình) → < 100ms; giảm 4 poll/phút idle
- **Effort**: 3-4 ngày + đảm bảo LISTEN/NOTIFY reliability

#### 14.3.3 Blue/green pipeline version
- `PIPELINE_VERSION_FIRE_RISK=v8.1` env → route sang `pipeline/fire-risk/v8.1/index.js`
- Ghi vào snapshot: `pipeline_version` column
- Rollback: đổi env + rerun analysis → có thể so sánh v8.1 vs v9.0 side-by-side
- **Effort**: 5-7 ngày architecture + retrofit v8.1 code

#### 14.3.4 Retry với backoff cho GeoServer client
- `p-retry` với `retries=3`, `factor=2`, `minTimeout=1000`
- Only retry với network errors + 5xx (không retry 4xx)
- **Effort**: 1 ngày

#### 14.3.5 GCS lifecycle policy as code
- `scripts/setup-gcs-lifecycle.sh`: gọi `gsutil lifecycle set lifecycle.json gs://$GEE_GCS_BUCKET`
- `lifecycle.json`: delete objects > 30d, transition to NEARLINE > 7d
- Chạy 1 lần khi bootstrap môi trường
- **Effort**: 1 ngày

#### 14.3.6 Audit log cho manual GEE trigger
- Middleware: log mỗi POST tới `/satellite/publish`, `/fire-risk/rerun`, `/forest/rerun`
- Ghi: user_id, timestamp, params, resulting_snapshot_id
- Retention 1 năm — dùng cho incident review
- **Effort**: 2 ngày

#### 14.3.7 Convert copy MinIO+FS thành single-source
Chọn 1:
- **A**: Chờ GeoServer 3.x port `gs-s3-geotiff` → dùng MinIO làm authoritative store, GeoServer đọc trực tiếp
- **B**: FUSE mount MinIO vào `GEOSERVER_DATA_DIR/gee-rasters/` bằng `rclone mount` hoặc `s3fs` — GeoServer thấy như local FS
- **C**: Chấp nhận copy 2 lần nhưng thêm checksum verify sau copy
- Đề xuất **A** khi có patch, **C** ngắn hạn
- **Effort**: A: chờ upstream (không effort); C: 2 ngày

### 14.4 P3 — Long-term

- **Migrate GEE Node.js SDK → REST direct**: cho phép concurrency > 1 (mỗi request có session riêng); loại `evaluate()` callback hell
- **Cache warmed GEE Image** (`Export.image.toAsset()` cho intermediate feature stack, reuse trong 24h)
- **Multi-tenant**: mỗi tỉnh 1 workspace GeoServer + prefix bucket riêng — hỗ trợ bán product cho tỉnh khác
- **Streaming COG với `--stream`** cho raster-ingest — không dùng disk trung gian, giảm 500ms/job

---

## 15. Nguyên tắc khi triển khai roadmap

1. **P0 chặn feature khác**: leaked GCP key + không có quota monitor = risk cao. Fix trước mọi thứ.
2. **GEE quota là finite** — mọi thay đổi tăng call rate (concurrency > 1, event-driven, retry) phải monitor 1 tuần trước khi rollout full.
3. **Golden dataset test là bắt buộc** trước khi refactor `fire-risk.pipeline` hoặc `forest.pipeline`. Không có test → không refactor.
4. **Backward-compat schema**: nếu thay đổi `snapshot` schema → migration additive (add column NULL) + code đọc cả 2 dạng ít nhất 2 release.
5. **Feature flag** cho mọi behavior change — VD `USE_EVENT_DRIVEN_INGEST=false` mặc định, bật 20% traffic, monitor 1 tuần, mới bật 100%.
6. **Rollback plan** cho mỗi deploy GEE-related: giữ được previous pipeline version 30 ngày để rerun snapshot cũ nếu output bất thường.
7. **Không dùng library "hot" mới** cho critical path (GEE queue, raster ingest, GeoServer client) — chỉ chọn library có > 1M downloads/month, > 2 năm tuổi.
