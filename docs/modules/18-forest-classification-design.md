# 18 — Phân loại 11 lớp che phủ rừng (Kon Tum) — thiết kế chi tiết

> Random Forest 11-class classification cho tỉnh Kon Tum, chạy hàng tháng
> trên GEE + xuất GeoTIFF sang GeoServer qua raster-ingest queue.
> Nguồn gốc: port từ `lopPhuRungFinal.txt v3` sang Node.js.
>
> **Cập nhật lần cuối**: 2026-07-24 — bám sát code hiện tại
> (`server/src/services/forest-classification.*`, `services/satellite.service.js`
> `buildClassified`, `configs/forest-classification.js`, migrations
> `020/021/023/027/033/034/036`).

## 1. Code ở đâu

| Lớp | File | Mục đích |
|---|---|---|
| **Pipeline (core)** | [server/src/services/forest-classification.pipeline.js](../../src/services/forest-classification.pipeline.js) | 8 hàm chính: `buildPriorityLabel`, `buildFeatureImage`, `buildThresholdLabel`, `buildDatasetLabel`, `sampleFromLabel`, `sampleGroundTruth`, `buildExclusionMask`, `runRfClassification` |
| **Orchestrator** | [server/src/services/forest-classification.service.js](../../src/services/forest-classification.service.js) | `runAnalysis(year, month)` — dedupe active runs, gọi pipeline + persist snapshot + district stats + GT intake + auto-ingest raster |
| **Config (ngưỡng, tham số)** | [server/src/configs/forest-classification.js](../../src/configs/forest-classification.js) | Class names, palette, cửa sổ mùa, RF params (full + lite), sample quotas, GCS/MinIO, download scale |
| **On-demand `/satellite/classified`** | [server/src/services/satellite.service.js](../../src/services/satellite.service.js) → `buildClassified()` | Dùng chung `runRfClassification` với `liteMode: true` + `skipStats: true` |
| **Cron job + startup catch-up** | [server/src/jobs/forest-classification.job.js](../../src/jobs/forest-classification.job.js) | Chạy hàng tháng (VN tz), catch-up bù kỳ khi server khởi động |
| **HTTP routes** | [server/src/routes/forest-classification.routes.js](../../src/routes/forest-classification.routes.js) | `/latest`, `/query`, `/snapshot/:id`, `/history`, `/refresh`, `/published-history`, `/snapshots/:id/publish-raster`, `/ground-truth/*` |
| **Controller** | [server/src/controllers/forest-classification.controller.js](../../src/controllers/forest-classification.controller.js) | Format snapshot, build WCS URL, validate period, gọi service/repo |
| **Repository** | [server/src/repositories/forest-classification.repository.js](../../src/repositories/forest-classification.repository.js) | `upsertSnapshot`, `updateStatus`, `getLatestCompleted`, `listCompleted`, `replaceDistrictAreas`, `getPreviousCompleted` |
| **Ground truth service** | [server/src/services/forest-gt.service.js](../../src/services/forest-gt.service.js) + [controllers/forest-gt.controller.js](../../src/controllers/forest-gt.controller.js) + [repositories/forest-gt.repository.js](../../src/repositories/forest-gt.repository.js) | CRUD zones/points + `getGtForAnalysis(endDate, windowDays)` cho pipeline |
| **Raster ingest** | [server/src/services/raster-ingest.service.js](../../src/services/raster-ingest.service.js) + workers | Pull GeoTIFF từ GEE download URL → MinIO → GeoServer, back-link `geoserver_layer` vào snapshot |
| **Notification** | [server/src/services/notification.service.js](../../src/services/notification.service.js) | Broadcast completed / failed / top-3 changes tới `system_admin`, `so_nnmt`, `ubnd_tinh` |
| **Utility GEE** | [server/src/utils/gee-satellite.util.js](../../src/utils/gee-satellite.util.js) | `makeComposite`, `addIndices`, `getDemBands`, `maskS2`, `maskLandsatC2`, `prepL57/89`, `eeEval`, `eeGetInfo` |
| **Stage logger** | [server/src/utils/stage-logger.util.js](../../src/utils/stage-logger.util.js) | `makeStageLogger('FOREST-CLS', {correlationId})` — mọi bước bọc `log.run()` để trace latency + timeout |
| **Migrations** | 020_satellite (snapshot base), 021_forest_classification_logs (trigger/requested_by/duration_ms), 023_forest_data_historical (mốc 2020/2022), 027_forest_classification_v3_metrics (test_accuracy/kappa/sample_quotas), 033_forest_ground_truth (GT zones/points + gt_* cols), 034_forest_download_url (gee_download_url), 036_clear_fire_risk_forest_classification_history | Bảng snapshot + district areas + GT + audit + download URL |

## 2. Tổng quan

- **11 class** đầu ra (class_id 0-10):

  | ID | Tên | Màu hex | Nhóm |
  |---|---|---|---|
  | 0 | Đất khác | `#FFBEE8` | Phi rừng |
  | 1 | Cây công nghiệp | `#FFEBB0` | Phi rừng* |
  | 2 | Đất nông nghiệp | `#F0E442` | Phi rừng |
  | 3 | Rừng hỗn giao lá rộng, lá kim | `#FEFF73` | **Rừng** |
  | 4 | Rừng lá rộng thường xanh | `#AAFF03` | **Rừng** |
  | 5 | Rừng lá kim | `#D0FF73` | **Rừng** |
  | 6 | Rừng lá rộng rụng lá | `#E7E600` | **Rừng** |
  | 7 | Rừng tre nứa | `#4DE600` | **Rừng** |
  | 8 | Rừng trồng | `#FFAA01` | **Rừng** |
  | 9 | Sông, suối, hồ | `#73B2FF` | Nước |
  | 10 | Trảng cỏ, cây bụi | `#55FF00` | Phi rừng |

  \* `FOREST_CLASS_IDS = [1, 3, 4, 5, 6, 7, 8]` trong code — hiện đang **gộp
  cả class 1 vào tổng "rừng"** khi tính notification/comparison. Xem file
  [19-forest-classification-model-analysis.md § 4.5](19-forest-classification-model-analysis.md#45-tổng-rừng-trong-code-đang-gồm-cả-cây-công-nghiệp)
  cho lý do đây là bug semantic.

- **Model**: Random Forest (`ee.Classifier.smileRandomForest`)
  - Full mode (dự trù, hiện KHÔNG chạy): 200 trees, `bagFraction=0.7`, `varsPerSplit=6`, `minLeaf=2`, 100 samples/class ở 30m, có Dataset labels
  - **Lite mode (đang chạy cho cả admin + on-demand)**: 80 trees, cùng bag/vars/leaf, 30 samples/class ở 100m, KHÔNG Dataset labels

- **Cadence**: cron `0 0 1 * *` = ngày 1 hàng tháng lúc 00:00 giờ VN
  (`FC_CRON` env override). Job lấy kỳ tháng vừa kết thúc (`resolveTargetPeriod`
  qua `Intl.DateTimeFormat` với timezone `FC_CRON_TZ`), nên không phụ thuộc
  tháng có 28/29/30/31 ngày.

  Khi server khởi động sau ngày chạy, **startup catch-up**
  (`FC_CATCHUP_ENABLED=true`, delay `FC_CATCHUP_DELAY_MS=60_000` ms)
  kiểm tra kỳ đầy đủ mới nhất và chạy bù nếu chưa `completed/published`.
  Force chạy lại một kỳ (bất chấp status): `FC_FORCE_ANALYSIS=true`.

- **Vệ tinh nguồn**: Landsat 5/7/8/9 (Collection 2 Tier 1 L2) + Sentinel-2
  (SR Harmonized, chỉ áp dụng khi `year >= 2017`)
  - Landsat cloud mask: bit 0 (fill), 1 (dilated cloud), 3 (cloud), 4 (cloud shadow), 5 (snow) của `QA_PIXEL`
  - Sentinel-2 cloud mask: `SCL != {3, 8, 9, 10, 11}` + filter `CLOUDY_PIXEL_PERCENTAGE < 60`
  - Fallback masked constant image khi collection rỗng (mùa tương lai / thiếu ảnh)

- **Concurrency**: `runAnalysis` dùng `activeRuns` Map — nếu 2 caller
  (cron/manual/user) cùng kỳ chạm cùng thời điểm, caller thứ 2 nhận lại
  cùng Promise (dedupe). Đảm bảo không materialize hai graph GEE trùng.

## 3. Pipeline chi tiết

```
runAnalysis(year, month)
  ├─ Init Earth Engine session (JWT service-account)
  ├─ Upsert snapshot(status='computing', model_params={version:'v3-lite', ...})
  ├─ Query GT (window 180d, PostGIS)          ← try/catch, migration 033 optional
  │    zones + points → inline GeoJSON FeatureCollection
  ├─ Load Kon Tum region + districts (FC)
  ├─ runRfClassification():
  │   ├─ Stage 1  Build feature image     ← 26 bands (composite × 3 mùa + indices + DEM) [LAZY]
  │   ├─ Stage 2  Build threshold label   ← 11 mask theo ngưỡng cứng, priority mosaic [LAZY]
  │   ├─ Stage 3  Build dataset label     ← DW + WorldCover + JRC blend  (SKIPPED khi liteMode) [LAZY]
  │   ├─ Stage 4  Split GT (70/30) + build exclusion mask (60m buffer)
  │   ├─ Stage 5  sampleFromLabel(threshold, 30 pts/class @100m) [LAZY]
  │   │           sampleFromLabel(dataset,   ...) — nếu useDatasetLabels
  │   ├─ Stage 6  Merge trainSet = input ∪ threshold ∪ dataset
  │   ├─ Stage 7  Train RF classifier (deferred, không getInfo ngay) [LAZY]
  │   ├─ Stage 8  GETINFO OOB accuracy       ← evaluate() ĐẦU TIÊN, force cả graph
  │   ├─ Stage 9  EVALUATE test accuracy + kappa  ← chỉ khi hasGT + computeTestMetrics
  │   └─ Stage 10 Classify + JRC water correction  [LAZY]
  ├─ EVALUATE province area stats (reduceRegion @200m coarse)
  ├─ EVALUATE district area stats (reduceRegions @200m coarse)
  ├─ getEeMapId(classified) → geeTileUrl  (non-fatal)
  ├─ getDownloadURL(classified.visualize().updateMask(class>0)) → geeDownloadUrl
  │    timeout 300s, scale=DOWNLOAD_SCALE_M (500m default), maxPixels=1e9
  ├─ Update snapshot(status='completed', all fields)
  ├─ Persist district_areas rows
  ├─ Top-3 changes alert  (nếu class top-1 vượt FC_ALERT_CHANGE_PCT %)
  ├─ [async] _autoIngestSnapshot(snapshot, geeDownloadUrl, ...)
  │    → raster-ingest queue → MinIO → GeoServer → back-link geoserver_layer
  └─ [async] _notifyForestClassificationCompleted (broadcast 3 roles)
```

### 3.1 Feature image (26 bands)

```
6  band optical base    (blue, green, red, nir, swir1, swir2)
+  8 base indices        (NDVI, NDWI, MNDWI, NDMI, NDBI, NBR, BSI, EVI)
+  4 dry-season indices  (dry_NDVI, dry_MNDWI, dry_BSI, dry_EVI)
+  3 wet-season indices  (wet_NDVI, wet_MNDWI, wet_EVI)
+  2 amplitude bands     (NDVI_amp = wet-dry, EVI_amp = wet-dry)
+  3 terrain bands       (elevation, slope, aspect  ← SRTMGL1_003)
─────────────────────────
= 26 bands total
```

Cửa sổ mùa (env override được):
- `BASE`: tháng 1-12 (composite cả năm)
- `DRY`: tháng **1-4**
- `WET`: tháng **8-11**

Dry/wet composite dùng `unmask(base)` để lấp pixel thiếu bằng giá trị mùa cả năm.

**Lưu ý (bug hiện tại)**: `buildFeatureImage(year, region)` KHÔNG nhận `month`.
Do đó mọi snapshot trong cùng một năm sẽ dùng chung một feature image. So
sánh liên tháng vì vậy kém ý nghĩa (xem file 19 § 4.6).

### 3.2 Ngưỡng phân loại (threshold pseudo-label)

Đây là nhãn "giả" (không phải ground truth), làm cơ sở để **stratified sample**
rồi train RF. Ngưỡng lấy từ `lopPhuRungFinal v3` — bám thực địa Kon Tum.

| Class | Điều kiện AND |
|---|---|
| **0 · Đất khác** | `bsi > 0.18` AND `ndvi < 0.28` AND `mndwi < 0.05` AND `ndbi > -0.05` |
| **1 · Cây công nghiệp** | `wetNDVI ∈ [0.60, 0.88]` AND `dryNDVI ≥ 0.45` AND `NDVI_amp ≤ 0.24` AND `elev ∈ [300, 1300]` AND `slope ≤ 18°` AND `mndwi < 0.05` AND `bsi < -0.02` |
| **2 · Đất nông nghiệp** | `wetNDVI ∈ [0.40, 0.85]` AND `dryNDVI ≤ 0.58` AND `NDVI_amp ≥ 0.18` AND `elev < 1000` AND `slope < 15°` AND `mndwi < 0.10` |
| **3 · Rừng hỗn giao** | `wetNDVI ∈ [0.62, 0.85]` AND `dryNDVI ≥ 0.55` AND `NDVI_amp ≤ 0.17` AND `elev ≥ 650` AND `slope ≥ 8°` AND `nbr ≥ 0.30` AND `ndmi ≥ 0.08` |
| **4 · Rừng lá rộng thường xanh** | `wetNDVI ≥ 0.72` AND `dryNDVI ≥ 0.65` AND `NDVI_amp ≤ 0.12` AND `evi ≥ 0.38` AND `ndmi ≥ 0.10` AND `nbr ≥ 0.35` AND `bsi < -0.10` AND `elev ≥ 450` |
| **5 · Rừng lá kim** | `wetNDVI ∈ [0.48, 0.78]` AND `dryNDVI ∈ [0.45, 0.74]` AND `evi ∈ [0.20, 0.45]` AND `elev ≥ 900` AND `slope ≥ 8°` AND `swir1 ≥ 0.07` AND `nbr ≥ 0.22` |
| **6 · Rừng lá rộng rụng lá** | `wetNDVI ≥ 0.55` AND `dryNDVI ≤ 0.50` AND `NDVI_amp ≥ 0.22` AND `elev ∈ [300, 900]` AND `slope ≥ 6°` AND `dry_BSI ≥ -0.02` AND `wet_EVI ≥ 0.25` AND `mndwi < 0.05` |
| **7 · Rừng tre nứa** | `wetNDVI ∈ [0.55, 0.78]` AND `dryNDVI ∈ [0.45, 0.72]` AND `NDVI_amp ∈ [0.04, 0.22]` AND `elev ∈ [300, 1100]` AND `slope ∈ [5°, 30°]` AND `evi ∈ [0.22, 0.45]` AND `ndmi ≥ 0.05` AND `bsi < -0.05` |
| **8 · Rừng trồng** | `wetNDVI ∈ [0.60, 0.85]` AND `dryNDVI ≥ 0.45` AND `NDVI_amp ≤ 0.23` AND `elev < 1000` AND `slope < 22°` AND `nbr ≥ 0.24` AND `ndmi ≥ 0.06` AND `bsi < -0.05` |
| **9 · Sông, suối, hồ** | `mndwi ≥ 0.10 AND ndvi ≤ 0.22` **OR** `mndwi ≥ 0.02 AND ndvi ≤ 0.30 AND dry_MNDWI ≥ -0.05` |
| **10 · Trảng cỏ, cây bụi** | `wetNDVI ∈ [0.35, 0.65]` AND `dryNDVI ∈ [0.18, 0.50]` AND `NDVI_amp ≥ 0.06` AND `bsi < 0.15` AND `mndwi < 0.05` AND `slope < 30°` |

**Priority mosaic** — thứ tự `buildPriorityLabel` (later overwrites earlier):

```
Priority từ THẤP → CAO (index cuối trong array thắng):
  0 Đất khác  →  3 Hỗn giao  →  4 Thường xanh  →  8 Rừng trồng  →
  7 Tre nứa  →  6 Lá rộng rụng lá  →  5 Lá kim  →  10 Trảng cỏ  →
  2 Nông nghiệp  →  1 Cây công nghiệp  →  9 Nước ⬅ cao nhất
```

Với các class **rừng tự nhiên (3/4/5/6/7)**: mask threshold PHẢI đi kèm
`nonNatural.NOT()` (`nonNatural = tOtherLand | tIndCrop | tAgri | tGrassShrub | tWater`)
để không đè lên các lớp phi rừng "hard" trước khi priority mosaic ưu tiên
lớp phi rừng lên trên.

### 3.3 Dataset pseudo-label (blend 3 external datasets)

Chỉ chạy trong **full mode** hoặc khi `FC_LITE_USE_DATASET_LABELS=true`.
Lite mode mặc định bỏ để giảm graph size ~3× và tránh timeout `getMapId`.

**Nguồn**:

| Dataset | Điều kiện dùng | Cửa sổ thời gian |
|---|---|---|
| **Dynamic World v1** (`GOOGLE/DYNAMICWORLD/V1`) | year ≥ 2016 | `BASE_START_MONTH` → `BASE_END_MONTH + 1 tháng`, `.mean()` |
| **ESA WorldCover v200** | 2019 ≤ year ≤ 2023 | Snapshot annual (ImageCollection first) |
| **JRC Global Surface Water 1.4** | Luôn dùng | Multi-year composite |

**Ngưỡng blend**:

```
publicWater  = dw.water ≥ 0.55      OR  worldCover == 80  OR  jrcStable  OR  jrcSeasonal
publicTree   = dw.trees ≥ 0.65      OR  worldCover == 10
publicCrop   = dw.crops ≥ 0.60      OR  worldCover == 40
publicOther  = dw.built ≥ 0.60      OR  worldCover ∈ {50, 60}
publicGrass  = dw.grass ≥ 0.55      OR  worldCover ∈ {20, 30}

jrcStable    = jrc.occurrence ≥ 70  AND  jrc.recurrence ≥ 70
jrcSeasonal  = jrc.occurrence ≥ 25  AND  jrc.seasonality ≥ 3  AND  jrc.max_extent == 1

publicNonNat  = publicOther | publicCrop | publicGrass | publicWater
naturalForest = publicTree  AND  NOT(publicNonNat)
```

**Ưu tiên**: dataset label chỉ được gán khi threshold label CÙNG class →
phải thoả CẢ 2 nguồn (giao). Ví dụ:
- Class 4 (Rừng lá rộng thường xanh): `naturalForest AND thresholdLabel == 4`
- Class 9 (Nước): `publicWater AND thresholdLabel == 9`
- Class 8 (Rừng trồng): `publicTree AND thresholdLabel == 8 AND NOT publicWater AND NOT publicOther`

### 3.4 Ground truth intake (migration 033)

Nếu có nhãn thực địa trong `forest.forest_gt_zones` (polygon) +
`forest.forest_gt_points` (point) — nhập qua endpoint
`POST /forest-classification/ground-truth/{zones|points}` (permission
`forest_classification.ground_truth`):

- **Nguồn ưu tiên**: `groundTruthGeoJson` (inline từ PostGIS) > `groundTruthAssetId` (GEE asset backup)
- **Cửa sổ query**: 180 ngày trước ngày cuối tháng phân tích (`FC_GT_WINDOW_DAYS`)
- **Split**: 70% training / 30% test (`randomColumn` với seed `rfSeed + 101`)
- **Exclusion mask**: buffer 60m quanh GT features → không lấy Dataset/Threshold samples chồng lấn (`FC_GT_BUFFER_M`)
- **Class field**: mỗi feature phải có property `class` (hoặc `classId`/`class_id`, service convert tự động)
- **Graceful degrade**: nếu migration 033 chưa chạy (table thiếu, error code 42P01), pipeline log warning và fallback về `hasGT=false` — không throw

### 3.5 Sample quotas (`§14.1 lopPhuRungFinal v3`)

| Mode | Nguồn | Quota per class | Tổng train samples |
|---|---|---|---|
| **Full + có GT** | Input 50% + Dataset 30% + Threshold 20% | 100 × 11 × 3 nguồn = **3300** | ~3300 |
| **Full + không GT** | Dataset 60% + Threshold 40% | 100 × 11 × 2 nguồn = **2200** | ~2200 |
| **Lite + có GT** | Input 50% + Threshold 50% (Dataset skip) | 30 × 11 × 2 nguồn = **660** | ~660 |
| **Lite + không GT** | Threshold 100% | 30 × 11 = **330** | ~330 |

Input test quota: `max(minFieldTest=10, 20% × total)`.

**Seed clamping**: `Image.stratifiedSample` yêu cầu seed là int32 signed
(≤ 2^31-1). Pipeline derived seed = `rfSeed × 2000 + 1`, nên caller
truyền `rfSeed = year` (~2026), sau khi clamp qua `Math.abs(seed) % MAX_INT32`
mới truyền vào GEE.

### 3.6 Random Forest config

| Tham số | Full mode | Lite mode (đang dùng) | Env override |
|---|---|---|---|
| `numberOfTrees` | 200 | **80** | `FC_RF_TREES` / `FC_LITE_RF_TREES` |
| `variablesPerSplit` | 6 | 6 | `FC_RF_VARS_SPLIT` |
| `minLeafPopulation` | 2 | 2 | `FC_RF_MIN_LEAF` |
| `bagFraction` | 0.7 | 0.7 | `FC_RF_BAG_FRACTION` |
| `sample scale` | 30m | **100m** | `FC_SAMPLE_SCALE_M` / `FC_LITE_SAMPLE_SCALE_M` |
| `samples/class/source` | 100 | **30** | `FC_SAMPLES_PER_CLASS` / `FC_LITE_SAMPLES_PER_CLASS` |
| `classify scale` | 30m | 30m | `FC_CLASSIFY_SCALE_M` |
| `useDatasetLabels` | true | **false** | `FC_LITE_USE_DATASET_LABELS` |

### 3.7 JRC stable water post-correction

Sau khi RF phân loại xong, có 1 bước override cưỡng bức:

```js
Pixel bị đè về class 9 (Nước) khi:
  jrc.occurrence ≥ 70  AND  jrc.recurrence ≥ 70  AND  mndwi ≥ -0.05
```

Mục đích: sửa các trường hợp RF nhầm sông/hồ lớn thành rừng ven bờ do
phản xạ SWIR bất thường.

### 3.8 Visualization + Download

- **Tile URL**: `getEeMapId(classified, CLASSIFIED_VIZ)` — palette 11 màu,
  min=0, max=10. Client GIS render trực tiếp không cần GeoServer.
  Non-fatal: nếu fail, snapshot vẫn `completed`, `gee_tile_url = null`.
- **Download URL**: `classified.updateMask(class > 0).visualize(CLASSIFIED_VIZ).clip(region).getDownloadURL()`
  - Mask class 0 (Đất khác) → pixel trong suốt trên WMS overlay
  - `.visualize()` → GeoTIFF RGB 3-band (mở ra là ảnh MÀU, không cần palette)
  - Scale = `FC_DOWNLOAD_SCALE_M` default **500m** (khớp fire-risk stability limit)
  - Format = GEO_TIFF, `filePerBand: false`, `maxPixels: 1e9`, `crs: EPSG:4326`
  - Timeout 300s (fire-risk dùng 30s, forest graph nặng hơn nhiều)
  - Non-fatal: nếu timeout/null → snapshot vẫn `completed` nhưng KHÔNG
    auto-ingest (không có URL). Admin có thể `POST /snapshots/:id/publish-raster`
    sau khi refresh lại để tạo URL mới.

## 4. Metrics đánh giá

| Metric | Nguồn | Ý nghĩa | Column DB |
|---|---|---|---|
| `oobAccuracy` | `classifier.explain().outOfBagErrorEstimate` qua `getInfo(callback)` | Accuracy nội tại RF (0-100%). Admin snapshot bật riêng OOB với `FC_OOB_TIMEOUT_MS` (10 phút); on-demand vẫn bỏ qua | `oob_accuracy NUMERIC(5,2)` |
| `testAccuracy` | `errorMatrix.accuracy()` trên 30% GT holdout | Accuracy độc lập (chỉ có khi `hasGT=true` VÀ `computeTestMetrics=true`) | `test_accuracy NUMERIC(5,2)` (migration 027) |
| `testKappa` | `errorMatrix.kappa()` | Cohen's Kappa 0-1 (>0.6 = tốt, >0.8 = xuất sắc) | `test_kappa NUMERIC(6,3)` |
| `province_summary.byClass` | `reduceRegion(sum, groupBy class)` @200m | Diện tích (ha) từng class toàn tỉnh | `province_summary JSONB` |
| `district_areas` | `reduceRegions(FC districts, sum, groupBy class)` @200m | Diện tích từng class per huyện | `forest.forest_district_areas` table |
| `sample_quotas` | pipeline return `{inputQuota, datasetQuota, thresholdQuota, inputTestQuota}` | Số mẫu thực tế đã dùng | `sample_quotas JSONB` (migration 027) |
| `duration_ms` | Wall-clock `Date.now() - startMs` | Latency tổng cả run | `duration_ms INTEGER` |
| `gt_zone_count` / `gt_point_count` / `gt_window_days` | Số feature GT dùng | `SMALLINT/INT` (migration 033) |

**Đang bật trong admin snapshot**: `computeOob: true`, `computeTestMetrics: false`.
Khi ground truth đủ tin cậy, bật `computeTestMetrics: true` để populate
`test_accuracy` + `test_kappa`.

## 5. Cảnh báo biến động rừng (Top-3 changes)

Sau khi snapshot mới complete, so sánh **từng class** giữa kỳ hiện tại vs
snapshot completed trước đó (`repo.getPreviousCompleted`):

```
Δ%_i = (curr[i] - prev[i]) / prev[i] × 100    // với mỗi class i
       (nếu prev[i] == 0 và curr[i] > 0 → Δ%_i = 100, class "mới xuất hiện")

top3 = sort(|Δ%_i|, desc).take(3)

if top3[0].absPct >= FC_ALERT_CHANGE_PCT (default 2.0%)
   → broadcast notification tới system_admin, so_nnmt, ubnd_tinh
     channel='alert', type='forest_change_alert'
```

Payload notification:
```
title: "Cảnh báo biến động rừng YYYY/MM"
body:  "So sánh với YYYY/MM_prev. Top 3 lớp biến động mạnh nhất:
        1. <name>: +X.X% (a → b ha)
        2. <name>: -Y.Y% (a → b ha)
        3. <name>: +Z.Z% (a → b ha)"
```

## 6. Chế độ chạy hiện tại

Full mode vẫn có trong pipeline nhưng **hiện không được ai sử dụng** vì đồ
thị 200 cây + Dataset labels từng vượt timeout GEE (~5 phút) khi cron chạy.
Admin (`runAnalysis`) và on-demand (`/satellite/classified`) cùng dùng lite
model để có raster nhất quán; khác biệt chính là admin lấy thêm OOB
diagnostics.

| Khía cạnh | Admin snapshot | On-demand `/satellite/classified` |
|---|---|---|
| Trigger | Cron ngày 1/manual/user query | User POST request (cache-first) |
| Sample per class | 30 | 30 |
| Sample scale | 100m | 100m |
| RF trees | 80 | 80 |
| Dataset labels | Bỏ (threshold only) | Bỏ (threshold only) |
| OOB | ✅ Có, qua `getInfo(callback)` timeout 10 phút | ❌ Bỏ để giảm latency |
| Test accuracy/kappa | ❌ Bỏ (chưa có GT holdout đủ tin cậy) | ❌ Bỏ |
| Area stats | 200m (`AREA_SCALE_M` hardcode) | 200m |
| Download URL | ✅ Sinh 500m GeoTIFF RGB, tự auto-ingest | ❌ Không |
| Publish GeoServer | ✅ Qua raster-ingest queue | ❌ Không |
| Cache | Snapshot DB (unique `year, month`) | SHA-256 request hash, TTL ~6h |
| Concurrency guard | `activeRuns` Map (dedupe same period) | Cache hit trả ngay |

## 7. Env vars

| Env | Default | Mô tả |
|---|---|---|
| **Cron/schedule** | | |
| `FC_CRON` | `0 0 1 * *` | Cron schedule |
| `FC_CRON_TZ` | `Asia/Ho_Chi_Minh` | Múi giờ dùng để xác định kỳ tháng |
| `FC_CATCHUP_ENABLED` | `true` | Chạy kiểm tra bù khi server khởi động |
| `FC_CATCHUP_DELAY_MS` | `60000` | Độ trễ trước khi kiểm tra bù |
| `FC_FORCE_ANALYSIS` | `false` | Bỏ qua check status → chạy lại bất chấp `completed/published` |
| **Composite window** | | |
| `FC_BASE_START_MONTH` / `FC_BASE_END_MONTH` | 1 / 12 | Cửa sổ base composite |
| `FC_DRY_START_MONTH` / `FC_DRY_END_MONTH` | 1 / 4 | Cửa sổ dry season |
| `FC_WET_START_MONTH` / `FC_WET_END_MONTH` | 8 / 11 | Cửa sổ wet season |
| **RF params (full)** | | |
| `FC_RF_TREES` | 200 | Số cây RF |
| `FC_RF_VARS_SPLIT` | 6 | Vars per split |
| `FC_RF_MIN_LEAF` | 2 | Min leaf population |
| `FC_RF_BAG_FRACTION` | 0.70 | Bag fraction |
| `FC_SAMPLES_PER_CLASS` | 100 | Sample training/class/nguồn |
| `FC_SAMPLE_SCALE_M` | 30 | Sample scale full mode |
| **Lite mode (đang chạy)** | | |
| `FC_LITE_SAMPLES_PER_CLASS` | 30 | Lite sample/class |
| `FC_LITE_SAMPLE_SCALE_M` | 100 | Lite sample scale |
| `FC_LITE_RF_TREES` | 80 | Lite RF trees |
| `FC_LITE_USE_DATASET_LABELS` | `false` | Bật DW+WC+JRC trong lite (rất chậm) |
| **Scale** | | |
| `FC_CLASSIFY_SCALE_M` | 30 | Scale phân loại |
| `FC_AREA_STATS_SCALE_M` | 60 | Scale mặc định (svc override 200m) |
| `FC_DOWNLOAD_SCALE_M` | **500** | Scale GEE getDownloadURL (đồng bộ fire-risk) |
| `FC_EXPORT_SCALE_M` | 30 | Scale export GeoTIFF (legacy — GCS path đã bỏ) |
| **Ground truth** | | |
| `FC_GT_WINDOW_DAYS` | 180 | Cửa sổ query GT PostGIS |
| `FC_GT_BUFFER_M` | 60 | Exclusion buffer quanh GT |
| `FC_MIN_FIELD_TEST` | 10 | Min GT test samples/class |
| `FC_GROUND_TRUTH_ASSET_ID` | (rỗng) | GEE asset backup (nếu không dùng inline PostGIS) |
| **Alerts / notification** | | |
| `FC_ALERT_CHANGE_PCT` | 2.0 | Ngưỡng Δ% class top-1 để trigger top-3 alert |
| **GEE / timeout** | | |
| `GEE_TIMEOUT_MS` | 300000 | Timeout mỗi eeEval() |
| `FC_OOB_TIMEOUT_MS` | 600000 | Timeout riêng cho `classifier.explain().getInfo(callback)` |
| **Storage / publish** | | |
| `FC_MINIO_BUCKET` | `forest-classification` | Bucket lưu GeoTIFF |
| `FC_SNAPSHOT_GRACE_MONTHS` | 24 | Số tháng giữ snapshot trước khi cleanup |
| `GEE_GCS_BUCKET` | (rỗng) | Bucket GCS (legacy — flow mới không dùng) |
| `GOOGLE_APPLICATION_CREDENTIALS` | (rỗng) | Path service-account JSON |
| `GEOSERVER_PUBLIC_URL` | (rỗng) | Base URL GeoServer để build WCS GetCoverage download |
| `GEOSERVER_WORKSPACE` | `kontum` | Workspace GeoServer chứa raster |
| **Debug** | | |
| `FC_DEBUG` | `false` | Bật log `[FOREST-CLS:DBG:*]` cho debug entry/exit |

## 8. Output artifacts

### 8.1 Response `GET /api/v1/forest-classification/latest`

```jsonc
{
  "snapshot": {
    "id": 42,
    "year": 2026,
    "month": 5,
    "status": "completed",              // pending|computing|completed|failed|published
    "provinceSummary": {
      "byClass": { "0": 4260, "1": 339161, "4": 236289, ... },
      "totalHa": 963915.0
    },
    "oobAccuracy": 94.7,
    "testKappa": null,                  // null vì computeTestMetrics=false
    "geoserverLayer": "kontum:forest_class_202605",
    "geeTileUrl": "https://earthengine.googleapis.com/.../tiles/{z}/{x}/{y}",
    "geeDownloadUrl": "https://earthengine.googleapis.com/.../download...",
    "geoserverDownloadUrl": "https://.../geoserver/kontum/wcs?service=WCS&version=2.0.1&...",
    "downloadFilename": "forest_class_kontum_202605.tif",
    "computedAt": "2026-06-01T00:14:03Z"
  },
  "districtAreas": [
    { "districtCode": "608", "districtName": "Tp. Kon Tum",
      "classes": [ { "classId": 4, "className": "Rừng lá rộng thường xanh", "areaHa": 5432.1 }, ... ] }
  ],
  "comparison": {
    "previousSnapshot": { "id": 41, "year": 2026, "month": 4, ... },
    "province": {
      "total":   { "currentHa": 963915.0, "previousHa": 964012.3, "deltaHa": -97.3, "changePct": -0.01 },
      "forest":  { "currentHa": 831180.5, "previousHa": 830952.1, "deltaHa": 228.4,  "changePct":  0.03 },
      "classes": [ { "classId": 0, "className": "Đất khác", "currentHa": ..., "changePct": ... }, ... ]
    },
    "districts": [ { "districtCode": "608", "forest": { "currentHa": ..., "changePct": ... } }, ... ]
  },
  "stale": false,
  "computing": false
}
```

### 8.2 Response `POST /api/v1/satellite/classified` (on-demand lite)

```jsonc
{
  "resultId": 61,
  "geeTileUrl": "...",
  "downloadUrl": "...",                    // GeoTIFF signed URL (TTL ~24h)
  "downloadFilename": "satellite_classified_YYYYMMDD.zip",
  "stats": {
    "year": 2026,
    "oobAccuracyPct": 0,                   // 0 vì skipStats=true trong lite on-demand
    "testAccuracyPct": null,
    "testKappa": null,
    "hasGroundTruth": false,
    "sampleQuotas": { "inputQuota": 0, "datasetQuota": 0, "thresholdQuota": 30, "inputTestQuota": 10 },
    "areaByClass": [
      { "classId": 0, "name": "Đất khác",   "color": "#FFBEE8", "areaHa": 11719.52 },
      { "classId": 4, "name": "Rừng lá rộng thường xanh", ..., "areaHa": 246052.25 },
      ...
    ]
  },
  "legend": [
    { "color": "#FFBEE8", "label": "0 – Đất khác", "areaHa": 11719.52, "classId": 0 },
    ...
  ],
  "metadata": {
    "year": 2026,
    "classCount": 11,
    "model": "RandomForest v3-lite (Landsat 5/7/8/9 + S2 + threshold labels)",
    "blendRule": "Threshold 100%"
  }
}
```

## 9. Vòng đời snapshot + publish (raster-ingest queue)

Flow **hiện tại** (từ 2026-05): bỏ hoàn toàn GCS Export API,
dùng `getDownloadURL()` + raster-ingest queue giống fire-risk.

```
     ┌─────────────┐
     │  pending    │  (không dùng thực tế — upsert tạo ngay 'computing')
     └──────┬──────┘
            │
     ┌─────────────┐
     │  computing  │  ← INSERT khi runAnalysis bắt đầu
     └──────┬──────┘
            │
    ┌───────┴───────┐
    ↓               ↓
completed        failed
    │            (error_message set + notify system_admin)
    │
    ↓ [async] _autoIngestSnapshot(geeDownloadUrl):
    │      ingestSvc.enqueue({ sourceUrl, layerCode='forest_class_YYYYMM',
    │                          category='forest', linkedResource={type,id} })
    │
    ↓ raster-ingest worker (poll 15s):
    │      1. Download GeoTIFF từ GEE signed URL
    │      2. Upload MinIO bucket = FC_MINIO_BUCKET
    │      3. Publish GeoServer coverage store + layer
    │      4. Back-link snapshot.geoserver_layer = 'kontum:forest_class_YYYYMM'
    │
    ↓
published (semantic: có geoserver_layer, status vẫn là 'completed' trong DB
           trừ khi worker set 'published' — tuỳ implementation)
```

State `exporting` từ schema cũ vẫn tồn tại nhưng KHÔNG dùng nữa
(GCS export path đã xoá — xem comment cuối `forest-classification.service.js`).

### Idempotency + retry

- Snapshot đã có `geoserver_layer` → auto-ingest SKIP.
- Admin bấm `POST /snapshots/:id/publish-raster` khi `snapshot.geoserver_layer`
  đã có → trả `alreadyPublished: true` trừ khi `?force=1`.
- `raster-ingest.service` dedupe theo `sourceUrl` — 2 job cùng URL nhận job cũ.

## 10. API endpoints

Prefix: `/api/v1/forest-classification`

| Method | Path | Auth | Mô tả |
|---|---|---|---|
| GET | `/latest` | optionalAuth | Snapshot completed mới nhất + district areas + comparison |
| POST | `/query` | optionalAuth | On-demand user query: cached=true trả ngay, cached=false trigger background analysis |
| GET | `/snapshot/:id` | optionalAuth | Poll snapshot theo id (dùng sau `/query`) |
| GET | `/published-history` | optionalAuth | List snapshot đã publish GeoServer (subset field an toàn, không leak error/URL) |
| GET | `/history` | `forest_classification.manage` | List tất cả snapshot completed/published với filter `hasGeoserverLayer` |
| POST | `/refresh` | `forest_classification.manage` | Manual trigger `runAnalysis(year, month)` |
| POST | `/snapshots/:id/publish-raster` | `map_layers.ingest_raster` | Re-enqueue raster-ingest job (idempotent, `?force=1` để bỏ qua guard) |
| POST | `/ground-truth/zones` | `forest_classification.ground_truth` | Thêm 1 polygon zone (MultiPolygon auto-wrap) |
| POST | `/ground-truth/zones/bulk` | `forest_classification.ground_truth` | Bulk từ FeatureCollection |
| GET | `/ground-truth/zones` | `forest_classification.ground_truth` | List (paginate) |
| DELETE | `/ground-truth/zones/:id` | `forest_classification.ground_truth` | Soft delete |
| POST | `/ground-truth/points` | `forest_classification.ground_truth` | Thêm 1 point (lng/lat + class 0-10) |
| POST | `/ground-truth/points/bulk` | `forest_classification.ground_truth` | Bulk points |
| GET | `/ground-truth/points` | `forest_classification.ground_truth` | List |
| DELETE | `/ground-truth/points/:id` | `forest_classification.ground_truth` | Soft delete |

**Permission mapping** (migration 020 + 033):
- `system_admin`, `so_nnmt`, `ubnd_tinh` — `forest_classification.{read, manage}`
- `system_admin`, `so_nnmt` — `forest_classification.ground_truth`
- `citizen` — `forest_classification.read` (chỉ endpoint public)

## 11. DB schema evolution

| Migration | Bảng / Column thêm | Ghi chú |
|---|---|---|
| **020_satellite** | `forest.forest_snapshots` (base: id, year, month, status, model_params, province_summary, oob_accuracy, geoserver_layer, ...), `forest.forest_district_areas` | Schema gốc, unique `(year, month)` |
| **021_forest_classification_logs** | `+ trigger VARCHAR(16)`, `+ requested_by BIGINT FK auth.users`, `+ duration_ms INTEGER` | Audit — biết run do ai/gì trigger |
| **023_forest_data_historical** | `gis.landcover_statistics` seed 2020/2022 Kon Tum (QĐ 1558, QĐ 156) | Mốc benchmark cấp tỉnh cho comparison |
| **027_forest_classification_v3_metrics** | `+ test_accuracy NUMERIC(5,2)`, `+ test_kappa NUMERIC(6,3)`, `+ sample_quotas JSONB` | Metrics độc lập khi có GT holdout |
| **029_gee_tile_url_columns** | `+ gee_map_id TEXT`, `+ gee_tile_url TEXT`, `+ gee_tile_generated_at TIMESTAMPTZ` | Client render tile trực tiếp không qua GeoServer |
| **033_forest_ground_truth** | `forest.forest_gt_zones` (MULTIPOLYGON + class_id 0-10 + soft-delete), `forest.forest_gt_points` (POINT + class_id + lng/lat CHECK Kon Tum range), triggers auto ST_Area + ST_MakePoint, `+ gt_zone_count`, `+ gt_point_count`, `+ gt_window_days` trên snapshot, RBAC `ground_truth` permission | GT intake cho RF training |
| **034_forest_download_url** | `+ gee_download_url TEXT` | Persist URL từ GEE getDownloadURL, valid ~24h, cho auto-ingest job |
| **036_clear_fire_risk_forest_classification_history** | TRUNCATE snapshots + related tables | One-off cleanup khi đổi schema/model lớn |

## 12. Cách debug khi phân loại lỗi

| Triệu chứng | Kiểm tra |
|---|---|
| `status: failed` trong DB | `SELECT error_message FROM forest.forest_snapshots WHERE id = X` |
| Log dừng ở stage nào | Grep `[FOREST-CLS#YYYY-MM]` (correlation id) — thấy `▶` không có `✓` = timeout ở stage đó |
| OOB accuracy quá thấp (< 60%) | Threshold labels sai (không đủ mẫu 1 class) → xem `sample_quotas` JSON |
| Snapshot completed nhưng `geoserver_layer=null` | Nếu `gee_download_url IS NULL` → getDownloadURL timeout, refresh lại. Nếu có URL → check raster-ingest worker log (`raster_ingest_jobs` table) |
| GT count = 0 dù đã nhập | Migration 033 đã chạy? Table `forest.forest_gt_zones` tồn tại? `observed_at` có nằm trong window 180d? |
| Test accuracy = null khi có GT | `computeTestMetrics: false` hiện đang bật cứng — cần đổi trong `forest-classification.service.js` khi GT holdout đủ tin cậy |
| Diện tích tổng ≠ diện tích Kon Tum (~967,417 ha) | Scale AREA_STATS = 200m hardcode; sai số ±3% chấp nhận được. Nếu >5% → xem `bestEffort:true` + `tileScale` |
| Snapshot mới stuck ở `computing` | `activeRuns` Map bị leak. Restart server, hoặc `UPDATE ... SET status='failed'` manual |
| Cron không chạy đúng giờ | `FC_CRON_TZ` (default `Asia/Ho_Chi_Minh`). Log `[FOREST] STARTED analysis=...` để xác nhận cron đăng ký |
| Notification top-3 alert không gửi | `sendTop3ChangesAlert` yêu cầu có `prevSnapshot` completed. Kiểm tra `getPreviousCompleted(year, month)` |

## Nguồn tham chiếu

- `lopPhuRungFinal.txt v3` (script GEE gốc — port sang Node.js)
- Google Dynamic World v1: <https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_DYNAMICWORLD_V1>
- ESA WorldCover v200: <https://developers.google.com/earth-engine/datasets/catalog/ESA_WorldCover_v200>
- JRC Global Surface Water 1.4: <https://developers.google.com/earth-engine/datasets/catalog/JRC_GSW1_4_GlobalSurfaceWater>
- Sentinel-2 SR Harmonized: `COPERNICUS/S2_SR_HARMONIZED`
- Landsat 5/7/8/9 C02 T1 L2: `LANDSAT/LT05|LE07|LC08|LC09/C02/T1_L2`
- SRTM DEM: `USGS/SRTMGL1_003`
- QĐ 99/QĐ-UBND ngày 28/02/2025 (hiện trạng rừng Kon Tum 31/12/2024)
- QĐ 1558/QĐ-BNN-TCLN ngày 13/4/2021 (2020) — seed migration 023
- QĐ 156/QĐ-UBND ngày 25/4/2023 (2022) — seed migration 023
- File song hành: [19-forest-classification-model-analysis.md](19-forest-classification-model-analysis.md) — phân tích sai lệch mô hình
