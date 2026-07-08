# Satellite Services — Technical Reference

> Server: `@kt_web_GIS/server` · Base path: `/api/v1/satellite`

---

## Architecture Overview

```
Client
  │
  ├─ POST /satellite/{type}      ──► satellite.service  ──► GEE (compute)
  │                                        │
  │                                        └─ satellite.image_results (cache, 6 h TTL)
  │                                                │
  ├─ GET  /satellite/tiles/:id/:z/:x/:y ◄──────────┘  proxy GEE tile server-side
  │
  └─ POST /satellite/publish     ──► GEE export task ──► GCS ──► MinIO ──► GeoServer WMS
```

### Two-phase tile access

| Phase | Endpoint | Response time | Persistence |
|-------|----------|---------------|-------------|
| Immediate | `GET /tiles/:id/:z/:x/:y` | < 1 s (proxy) | GEE token expires ~6 h |
| Persistent | `POST /publish` → GeoServer WMS layer | 5–15 min (async) | Indefinite |

---

## Endpoints

### POST `/satellite/rgb`

True-colour composite from Landsat 8/9 + Sentinel-2.

**Request body**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `startDate` | `YYYY-MM-DD` | ✓ | — | Start of acquisition window |
| `endDate` | `YYYY-MM-DD` | ✓ | — | End of acquisition window |
| `geometry` | GeoJSON geometry or `[minX, minY, maxX, maxY]` | — | Kon Tum province | Area of interest |
| `collection` | `"S2"` \| `"LANDSAT"` | — | both | Force single sensor |
| `cloudCover` | number 0–100 | — | `50` | Max cloud cover % (S2 filter) |

**Response** `200 OK`

```json
{
  "resultId": 42,
  "tileUrl": "https://api.example.com/api/v1/satellite/tiles/42/{z}/{x}/{y}",
  "geeTileUrl": "https://earthengine.googleapis.com/...",
  "geoserverLayer": null,
  "cached": false,
  "stats": { "imageCount": 12 },
  "legend": null,
  "metadata": { "startDate": "2024-01-01", "endDate": "2024-03-31", "collection": "auto" }
}
```

---

### POST `/satellite/ndvi`

NDVI (Normalized Difference Vegetation Index) composite.

**Additional fields**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ndviMinThresh` | number | `0.3` | NDVI threshold for vegetation area stats |

**Response extras**

```json
{
  "stats": {
    "imageCount": 8,
    "vegetationHa": 312450.5,
    "ndviThreshUsed": 0.3
  },
  "legend": [
    { "color": "#d73027", "label": "NDVI < 0" },
    { "color": "#fee08b", "label": "0 – 0.2" },
    { "color": "#ffffbf", "label": "0.2 – 0.4" },
    { "color": "#90ee90", "label": "0.4 – 0.6" },
    { "color": "#1a9641", "label": "> 0.6 (rừng dày)" }
  ]
}
```

---

### POST `/satellite/heat-map`

Land Surface Temperature (LST) from MODIS MOD11A1.

**Notes**
- `collection` and `cloudCover` parameters are ignored (MODIS has no cloud filter).
- Scale: 1 km/pixel.

**Response extras**

```json
{
  "stats": {
    "imageCount": 90,
    "lstMeanC": 28.4,
    "lstMinC": 18.1,
    "lstMaxC": 42.7
  },
  "metadata": { "source": "MODIS MOD11A1" }
}
```

---

### POST `/satellite/classified`

7-class threshold land-cover classification using spectral indices.

**Classes**

| ID | Name | Colour |
|----|------|--------|
| 0 | Mặt nước | `#0064ff` |
| 1 | Đô thị/Công trình | `#c0c0c0` |
| 2 | Đất trống | `#d4a017` |
| 3 | Đất nông nghiệp | `#ffeb3b` |
| 4 | Trảng cỏ/Cây bụi | `#a5d6a7` |
| 5 | Rừng trồng | `#ff9800` |
| 6 | Rừng tự nhiên | `#1b5e20` |

Classification thresholds use NDVI, NDWI, MNDWI, NDBI on a 6-band
(blue/green/red/nir/swir1/swir2) median composite.

**Response extras**

```json
{
  "stats": {
    "imageCount": 15,
    "areaByClass": [
      { "classId": 6, "name": "Rừng tự nhiên", "color": "#1b5e20", "areaHa": 410200.3 }
    ]
  }
}
```

---

### POST `/satellite/compare`

Two-period forest change detection via NDVI delta.

**Additional required fields**

| Field | Type | Description |
|-------|------|-------------|
| `startDate2` | `YYYY-MM-DD` | Start of period 2 |
| `endDate2` | `YYYY-MM-DD` | End of period 2 |

**Change classes**

| ID | Label | Colour |
|----|-------|--------|
| 0 | Không thay đổi | `#e0e0e0` |
| 1 | Mất rừng | `#d73027` |
| 2 | Tăng rừng | `#1a9641` |
| 3 | Thay đổi khác | `#ff9800` |

Forest threshold: NDVI ≥ 0.5. "Other change": ΔNDVI > 0.15.

**Response extras**

```json
{
  "stats": {
    "noChangeHa": 820000,
    "forestLossHa": 3200.5,
    "forestGainHa": 1100.2,
    "otherChangeHa": 8500
  },
  "metadata": {
    "period1": { "startDate": "2023-01-01", "endDate": "2023-12-31" },
    "period2": { "startDate": "2024-01-01", "endDate": "2024-12-31" },
    "forestNdviThresh": 0.5
  }
}
```

---

### GET `/satellite/tiles/:resultId/:z/:x/:y`

Proxy a single map tile. The server fetches the raw GEE tile and streams it to the
client — the GEE token is never exposed in the browser.

**URL parameters**

| Param | Description |
|-------|-------------|
| `resultId` | `satellite.image_results.id` returned by any POST endpoint |
| `z` | Zoom level |
| `x` | Tile column |
| `y` | Tile row |

**Response** — raw PNG/JPEG image bytes with `Cache-Control: public, max-age=3600`.

**Auth** — Public. No token required.

**Error codes**

| Status | Cause |
|--------|-------|
| 404 | `resultId` not found in DB |
| 504 | GEE tile fetch timed out (> 30 s) |

---

### POST `/satellite/publish`

Submit an asynchronous GEE→MinIO→GeoServer publish task for an existing cached result.

**Auth** — Requires `satellite.manage` permission (`system_admin`, `so_nnmt`, `ubnd_tinh`).

**Request body**

```json
{ "resultId": 42 }
```

**Response** `201 Created`

```json
{
  "message": "Đã gửi tác vụ xuất GeoTIFF.",
  "result": {
    "id": 42,
    "status": "exporting",
    "gee_task_id": "sat_rgb20240101_42",
    "geoserver_layer": null
  }
}
```

**Publish states**

```
ready → exporting → published
                 └→ failed
```

`pollPublishes()` runs periodically and advances `exporting` results to `published` or `failed`.

---

## Caching

All POST endpoints are keyed by a SHA-256 hash of normalised request parameters
(`imageType + collection + cloudCover + startDate + endDate + startDate2 + endDate2 + geometry`).
Cache TTL is controlled by env var `SATELLITE_CACHE_TTL_MS` (default 6 hours).
`published` results are never expired by the cleanup cron.

```
satellite.image_results
  id            BIGSERIAL PK
  request_hash  VARCHAR(64) UNIQUE  ← cache key
  image_type    VARCHAR(32)         ← rgb | ndvi | heatmap | classified | compare
  tile_url      TEXT                ← raw GEE tile URL (with {z}/{x}/{y})
  status        VARCHAR(32)         ← ready | exporting | published | failed
  geoserver_layer TEXT              ← workspace:storeName once published
  expires_at    TIMESTAMPTZ
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SATELLITE_CACHE_TTL_MS` | `21600000` (6 h) | Cache TTL for `satellite.image_results` |
| `SATELLITE_EXPORT_SCALE_M` | `30` | GeoTIFF export pixel size in metres |
| `SATELLITE_MINIO_BUCKET` | `satellite-rasters` | MinIO bucket for exported GeoTIFFs |
| `GEE_GCS_BUCKET` | — | GCS bucket for GEE export (required for publish) |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | Path to GCS service account JSON |
| `APP_URL` | — | Public server URL (used to build proxy tile URLs) |
| `GEE_TIMEOUT_MS` | `300000` (5 min) | Timeout for `eeEval()` calls |

---

## Forest Classification Service

> Base path: `/api/v1/forest-classification`

Runs a monthly Landsat 5/7/8/9 + Sentinel-2 11-class Random Forest classification
for Kon Tum province. Cron: `0 0 1 * *` (1st of each month, analyses previous month).

Each run is recorded in `forest.forest_snapshots` with a `trigger` (`cron` / `manual` / `user`),
optional `requested_by` (user ID), and `duration_ms`.

---

### Endpoint summary

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/latest` | Public | Most recent completed snapshot |
| POST | `/query` | Public (optionalAuth) | On-demand: return cached or trigger background run |
| GET | `/snapshot/:id` | Public (optionalAuth) | Poll a specific run by ID |
| GET | `/history` | `forest_classification.manage` | Paginated completed-run history |
| GET | `/logs` | `forest_classification.manage` | Full admin audit log (all statuses) |
| POST | `/refresh` | `forest_classification.manage` | Manually trigger a run |

---

### GET `/forest-classification/latest`

Returns the most recent completed (`completed` or `published`) snapshot with district-level area breakdown.

**Auth** — Public.

**Response**

```json
{
  "snapshot": {
    "id": 42,
    "year": 2024, "month": 5,
    "status": "completed",
    "trigger": "cron",
    "provinceSummary": { "1": 12345.6, "2": 8901.2 },
    "oobAccuracy": 94.7,
    "durationMs": 183000,
    "geoserverLayer": "forest_2024_05",
    "computedAt": "2024-06-01T00:14:03Z",
    "publishedAt": null
  },
  "districtAreas": [
    {
      "districtCode": "608",
      "districtName": "Tp. Kon Tum",
      "classes": [
        { "classId": 4, "className": "Rừng lá rộng thường xanh", "areaHa": 5432.1 }
      ]
    }
  ],
  "stale": false,
  "computing": false
}
```

`stale: true` means the last completed snapshot is from a prior month (a new run may be in progress).
`computing: true` means a run is currently active.

---

### POST `/forest-classification/query`

On-demand query for a specific year/month. Cache-first: returns immediately if a completed result exists;
triggers a background analysis if not. Client polls `GET /snapshot/:id` while `computing: true`.

**Auth** — Public (optionalAuth — authenticated users are recorded as `requested_by`).

**Request body**

```json
{ "year": 2024, "month": 6 }
```

**Response — cache hit (`cached: true`)**

```json
{
  "snapshot": { "id": 38, "year": 2024, "month": 6, "status": "completed", "trigger": "user", ... },
  "districtAreas": [ ... ],
  "cached": true,
  "computing": false
}
```

**Response — background run triggered (`computing: true`)**

```json
{
  "snapshot": { "id": 39, "year": 2024, "month": 6, "status": "computing", ... },
  "districtAreas": [],
  "cached": false,
  "computing": true
}
```

**On-demand query flow**

```
POST /query
  │
  ├─ completed/published snapshot exists? ──► return immediately  (cached: true)
  │
  ├─ computing/exporting in progress? ──────► return snapshot ID  (computing: true)
  │                                            client polls GET /snapshot/:id
  ├─ failed / not found?
  │     └─ fire-and-forget runAnalysis()
  │          └─ returns after upsert ──────► return snapshot ID  (computing: true)
  │                                            client polls GET /snapshot/:id
  └─ background: runAnalysis completes → status = "completed"
```

---

### GET `/forest-classification/snapshot/:id`

Poll a specific run by primary key. Used after `POST /query` returns `computing: true`.

**Auth** — Public.

**Response**

```json
{
  "snapshot": { "id": 39, "status": "computing", ... },
  "districtAreas": [],
  "computing": true
}
```

`computing: false` once `status` is `completed` or `published`. `districtAreas` is populated at that point.

---

### GET `/forest-classification/history`

Paginated list of completed runs. Omits failed/pending/computing entries.

**Auth** — `forest_classification.manage`.

**Query params** — `page` (default 1), `limit` (default 24).

---

### GET `/forest-classification/logs`

Full admin audit log — all runs, all statuses, with timing, trigger, requester, and error details.

**Auth** — `forest_classification.manage`.

**Query params** — `page` (default 1), `limit` (default 24), `status` (optional filter).

**Response item shape**

```json
{
  "id": 39,
  "year": 2024, "month": 6,
  "status": "failed",
  "trigger": "user",
  "requestedBy": 7,
  "oobAccuracy": null,
  "s2ImageCount": null,
  "lsImageCount": null,
  "durationMs": null,
  "geoserverLayer": null,
  "errorMessage": "EE computation timed out",
  "computedAt": null,
  "publishedAt": null,
  "createdAt": "2024-06-15T09:32:11Z"
}
```

---

### POST `/forest-classification/refresh`

Manually trigger a run for a specific period. Creates a new snapshot with `trigger: "manual"`.

**Auth** — `forest_classification.manage`.

**Request body**

```json
{ "year": 2024, "month": 6 }
```

**Response** — `201 Created` with the new snapshot object.

---

### Database schema additions (migration `021`)

```sql
ALTER TABLE forest.forest_snapshots
    ADD COLUMN trigger       VARCHAR(16) NOT NULL DEFAULT 'cron',  -- 'cron'|'manual'|'user'
    ADD COLUMN requested_by  BIGINT REFERENCES core.users(id) ON DELETE SET NULL,
    ADD COLUMN duration_ms   INTEGER;
```

---

### 11 Forest Classes

| ID | Name |
|----|------|
| 0 | Đất khác |
| 1 | Cây công nghiệp |
| 2 | Đất nông nghiệp |
| 3 | Rừng hỗn giao |
| 4 | Rừng lá rộng thường xanh |
| 5 | Rừng lá kim |
| 6 | Rừng lá rộng rụng lá |
| 7 | Rừng tre nứa |
| 8 | Rừng trồng |
| 9 | Sông/suối/hồ |
| 10 | Trảng cỏ/cây bụi |

Area-change alerts fire when any class changes > `FC_ALERT_CHANGE_PCT`% (default 2%) vs previous month.

---

## Fire Risk Service (EP-06)

> Cron: daily. Base path: `/api/v1/fire-risk`

Pipeline: S2 NDVI/NDMI/NBR + MODIS LST + ERA5 weather → P-Nesterov index → risk score 1–5
→ district stats → `fire.fire_risk_snapshots` + high-risk polygons → GeoServer harvest.

---

## Shared GEE Utilities (`gee-satellite.util.js`)

| Export | Description |
|--------|-------------|
| `eeEval(eeObject, timeoutMs?)` | Promisify `ee.Object.evaluate()` with timeout |
| `getEeMapId(eeImage, vizParams?)` | Get `{ mapId, tileUrl }` for display |
| `getKonTumRegion()` | FAO GAUL level-1 Kon Tum FeatureCollection |
| `getKonTumDistricts()` | FAO GAUL level-2 Kon Tum districts |
| `toEeGeometry(geometry)` | Parse GeoJSON or bbox → `ee.Geometry` |
| `maskLandsatC2(image)` | Landsat C2 L2 QA_PIXEL cloud mask |
| `prepL57(image)` | Landsat 5/7 band rename + scale |
| `prepL89(image)` | Landsat 8/9 band rename + scale |
| `maskS2(image)` | S2 SCL cloud mask + band rename (→ blue/green/red/nir/swir1/swir2) |
| `maskS2FireRisk(image)` | S2 SCL mask, keeps original B2–B12 names |
| `makeComposite(year, startMonth, endMonth, region?)` | Cloud-free median composite L5/7/8/9+S2 |
| `addIndices(image, prefix)` | Add NDVI/NDWI/MNDWI/NDMI/NDBI/NBR/BSI/EVI bands |
| `medianOrFallback(col, bands, fallbackValues)` | Median or constant fallback if collection empty |
| `getDemBands(region?)` | SRTM elevation/slope/aspect |
| `todayUtc()` | Current date as `YYYY-MM-DD` (UTC) |
| `fmtDate(d)` | Format Date/string as `YYYY-MM-DD` |
