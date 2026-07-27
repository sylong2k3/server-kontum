'use strict';

require('dotenv').config();

// ── GEE pipeline windows (mirrors GEE script v8.1 CONFIG) ────────────────────
const FEATURE_WINDOW_DAYS      = parseInt(process.env.FIRE_RISK_FEATURE_WINDOW_DAYS, 10) || 30;
const S2_FALLBACK_DAYS         = parseInt(process.env.FIRE_RISK_S2_FALLBACK_DAYS,    10) || 180;
const LST_FALLBACK_DAYS        = parseInt(process.env.FIRE_RISK_LST_FALLBACK_DAYS,   10) || 180;
const NESTEROV_LOOKBACK_DAYS   = parseInt(process.env.FIRE_RISK_NESTEROV_LOOKBACK_DAYS, 10) || 30;

// P Nesterov risk level breaks (QĐ 25/2022/QĐ-UBND Phụ lục II).
const NESTEROV_P_BREAKS = [5000, 10000, 15000, 20000];

// Risk score thresholds for level assignment.
const RISK_SCORE_BREAKS = [0.20, 0.40, 0.60, 0.80];

// Random Forest config (mirrors GEE v8.1 CONFIG).
const RF_TREES                    = parseInt(process.env.FIRE_RISK_RF_TREES,             10) || 100;
const RF_BAG_FRACTION             = parseFloat(process.env.FIRE_RISK_RF_BAG_FRACTION)        || 0.70;
const RF_MIN_LEAF_POPULATION      = parseInt(process.env.FIRE_RISK_RF_MIN_LEAF,          10) || 2;
const RF_VARIABLES_PER_SPLIT      = process.env.FIRE_RISK_RF_VARS_SPLIT
    ? parseInt(process.env.FIRE_RISK_RF_VARS_SPLIT, 10)
    : null;
const RANDOM_SEED                 = parseInt(process.env.FIRE_RISK_RANDOM_SEED,          10) || 42;
const TRAIN_SCALE_M               = parseInt(process.env.FIRE_RISK_TRAIN_SCALE_M,        10) || 500;
const TRAIN_SAMPLES_PER_CLASS     = parseInt(process.env.FIRE_RISK_TRAIN_SAMPLES,        10) || 100;
const TRAIN_HEAVY_TILE_SCALE      = parseInt(process.env.FIRE_RISK_TILE_SCALE,           10) || 16;

// Training months for the fire RF (mirrors CONFIG.TRAIN_MONTHS v8.1 —
// dry-season months Jan-Apr across 2019-2023). Can be overridden via env
// as a JSON array or comma-separated list of YYYY-MM-DD dates.
function parseTrainMonths() {
    const raw = process.env.FIRE_RISK_TRAIN_MONTHS;
    if (!raw) return null;
    try {
        const parsed = raw.trim().startsWith('[') ? JSON.parse(raw) : raw.split(',');
        return parsed.map((s) => String(s).trim()).filter(Boolean);
    } catch {
        return null;
    }
}
const TRAIN_MONTHS = parseTrainMonths() || [
    '2019-01-01','2019-02-01','2019-03-01','2019-04-01',
    '2020-01-01','2020-02-01','2020-03-01','2020-04-01',
    '2021-01-01','2021-02-01','2021-03-01','2021-04-01',
    '2022-01-01','2022-02-01','2022-03-01','2022-04-01',
    '2023-01-01','2023-02-01','2023-03-01','2023-04-01',
];

// Do not build the 180-day fallback graph for each training month
// (would explode graph size × 20 months). Only current predictors use fallback.
const TRAIN_USE_FALLBACK          = process.env.FIRE_RISK_TRAIN_USE_FALLBACK === 'true';

// Nesterov P daily-reset rain threshold (mm). Days above this reset P to 0.
const RAIN_RESET_MM               = parseFloat(process.env.FIRE_RISK_RAIN_RESET_MM) || 5;

// Minimum stratified samples per class required before RF training proceeds.
// Guards against degenerate one-class training when a month yields few
// positive or negative samples. Checked in service.js after evaluate().
const MIN_SAMPLES_PER_CLASS       = parseInt(process.env.FIRE_RISK_MIN_SAMPLES_PER_CLASS, 10) || 20;

// MCD64A1 max acceptable Uncertainty (days) for burned-label training samples.
const MCD_MAX_UNCERTAINTY_DAY     = parseInt(process.env.FIRE_RISK_MCD_MAX_UNCERTAINTY, 10) || 30;
const FIRECCI_MIN_CONFIDENCE      = parseInt(process.env.FIRE_RISK_FIRECCI_MIN_CONFIDENCE, 10) || 50;
const FIRMS_MIN_CONFIDENCE        = parseInt(process.env.FIRE_RISK_FIRMS_MIN_CONFIDENCE,   10) || 60;
const FIRMS_MIN_T21_K             = parseInt(process.env.FIRE_RISK_FIRMS_MIN_T21,          10) || 330;

// FIRMS recent hotspot window & buffer for priority warning layer.
const FIRMS_RECENT_DAYS           = parseInt(process.env.FIRE_RISK_FIRMS_RECENT_DAYS, 10) || 7;
const FIRMS_BUFFER_M              = parseInt(process.env.FIRE_RISK_FIRMS_BUFFER_M,    10) || 500;

// Optional user-supplied fire input asset (GEE FeatureCollection).
// Rows must carry `input_score` in [0,1]; rows with `confirmed=1` upgrade
// the priority warning to level 5.
const INPUT_FIRE_ASSET_ID         = process.env.FIRE_RISK_INPUT_FIRE_ASSET_ID || '';
const INPUT_BUFFER_M              = parseInt(process.env.FIRE_RISK_INPUT_BUFFER_M, 10) || 500;

// Optional local fuel-type asset (GEE Image with class band 1-11).
const LOCAL_FUEL_TYPE_ASSET_ID    = process.env.FIRE_RISK_LOCAL_FUEL_TYPE_ASSET_ID || '';

// Negative-sample eligibility mode: 'strict_observed' | 'relaxed_land_mask'.
// v8.1 default is 'relaxed_land_mask' — cloudy Tây Nguyên months would
// otherwise yield zero negative samples under 'strict_observed'.
const NEGATIVE_ELIGIBLE_MODE      = process.env.FIRE_RISK_NEGATIVE_ELIGIBLE_MODE
    || 'relaxed_land_mask';

// Enable Random Forest scoring. When false, DatasetModelScore falls back to
// a scaled ThresholdScore (fast, but no learned signal).
const ENABLE_RF                   = process.env.FIRE_RISK_ENABLE_RF !== 'false';

// Compute OOB accuracy via `classifier.explain().getInfo()`. Chỉ có ý nghĩa
// khi ENABLE_RF=true. Cost ~30-90s (force RF training materialize trên EE)
// nên default OFF; bật để admin xem chất lượng model qua snapshot metadata.
const COMPUTE_OOB                 = process.env.FIRE_RISK_COMPUTE_OOB === 'true';

// Timeout riêng cho OOB getInfo (ms). Mặc định 10 phút giống forest-classification.
const OOB_TIMEOUT_MS              = parseInt(process.env.FIRE_RISK_OOB_TIMEOUT_MS, 10) || 10 * 60 * 1000;

// GEE export settings.
// EXPORT_SCALE_M — mặc định 150m (fallback từ 100m sau khi huyện lớn hit
// GEE HTTP 400 "User memory limit exceeded" khi raster-ingest download).
// 150m giảm số pixel khoảng 2,25 lần so với 100m để giảm áp lực bộ nhớ.
// Đồng bộ với forest classify FC_DOWNLOAD_SCALE_M.
const EXPORT_SCALE_M              = parseInt(process.env.FIRE_RISK_EXPORT_SCALE_M, 10) || 150;
const EXPORT_FOLDER               = process.env.FIRE_RISK_EXPORT_FOLDER || 'GEE_FireWarning';

// ── GCS (Google Cloud Storage) for raster export ─────────────────────────────
const GCS_BUCKET                  = process.env.GEE_GCS_BUCKET || '';
const GCS_KEY_FILE                = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';

// ── Cron & cache ──────────────────────────────────────────────────────────────
// Default: hàng ngày lúc 06:00 giờ VN = 23:00 UTC ngày hôm trước.
// Mặc định 06:00 sáng VN (job đã set timezone Asia/Ho_Chi_Minh). Env override
// giữ nguyên nếu bạn cố ý muốn UTC-based schedule.
const CRON                        = process.env.FIRE_RISK_CRON || '0 6 * * *';

// Thời gian cache cho /latest (giây). Mặc định 6 giờ vì GEE tính ~5-10 phút.
const CACHE_TTL_SECONDS           = parseInt(process.env.FIRE_RISK_CACHE_TTL, 10) || 6 * 3600;

// DEPRECATED — cleanup cron đã bị bỏ (032). Chính sách hiện tại: giữ TOÀN
// BỘ lịch sử snapshot để phục vụ audit + so sánh long-term. Export = 0 để
// backward compat với `repo.deleteOld()` (nếu vẫn được gọi ngoài dự kiến,
// sẽ trả 0 → no-op).
const SNAPSHOT_GRACE_DAYS         = 0;

// Thời gian tối đa (ms) chờ GEE evaluate() trả kết quả stats.
const GEE_TIMEOUT_MS              = parseInt(process.env.FIRE_RISK_GEE_TIMEOUT_MS, 10) || 5 * 60 * 1000;

// Khoảng polling task GEE export (ms).
const GEE_POLL_INTERVAL_MS        = parseInt(process.env.FIRE_RISK_GEE_POLL_MS, 10) || 30_000;

// Số lần poll tối đa trước khi báo lỗi export.
const GEE_POLL_MAX_ATTEMPTS       = parseInt(process.env.FIRE_RISK_GEE_POLL_MAX, 10) || 40;

// MinIO bucket cho raster cháy rừng.
const MINIO_BUCKET                = process.env.FIRE_RISK_MINIO_BUCKET || 'fire-risk-rasters';

// Kon Tum bounding box [minLng, minLat, maxLng, maxLat].
const KONTUM_BBOX                 = [107.0, 13.8, 108.6, 15.5];

// MODIS hệ số LST (K → °C): LST_Day_1km * 0.02 – 273.15.
const LST_SCALE_FACTOR            = 0.02;
const LST_KELVIN_OFFSET           = 273.15;

// Nhiệt độ tối thiểu để P Nesterov có giá trị (< 0°C → bỏ qua ngày đó).
const MIN_TEMP_FOR_NESTEROV_C     = 0;

// Trọng số blend điểm ngưỡng và RF trong FinalFireRiskScore.
//   Without INPUT: 60% dataset (RF) + 40% threshold.
//   With INPUT:    50% input + 30% dataset + 20% threshold.
const WEIGHT_THRESHOLD            = 0.40;
const WEIGHT_RF                   = 0.60;
const WEIGHT_INPUT_WITH_INPUT     = 0.50;
const WEIGHT_RF_WITH_INPUT        = 0.30;
const WEIGHT_THRESHOLD_WITH_INPUT = 0.20;

// Trọng số các chỉ số trong threshold score.
const WEIGHT_P_NESTEROV           = 0.45;
const WEIGHT_NDVI_DROUGHT         = 0.25;
const WEIGHT_NDMI_DROUGHT         = 0.20;
const WEIGHT_LST                  = 0.10;

const isGcsConfigured = () => Boolean(GCS_BUCKET);

module.exports = {
    FEATURE_WINDOW_DAYS,
    S2_FALLBACK_DAYS,
    LST_FALLBACK_DAYS,
    NESTEROV_LOOKBACK_DAYS,
    NESTEROV_P_BREAKS,
    RISK_SCORE_BREAKS,
    RF_TREES,
    RF_BAG_FRACTION,
    RF_MIN_LEAF_POPULATION,
    RF_VARIABLES_PER_SPLIT,
    RANDOM_SEED,
    TRAIN_SCALE_M,
    TRAIN_SAMPLES_PER_CLASS,
    TRAIN_HEAVY_TILE_SCALE,
    TRAIN_MONTHS,
    TRAIN_USE_FALLBACK,
    RAIN_RESET_MM,
    MCD_MAX_UNCERTAINTY_DAY,
    MIN_SAMPLES_PER_CLASS,
    FIRECCI_MIN_CONFIDENCE,
    FIRMS_MIN_CONFIDENCE,
    FIRMS_MIN_T21_K,
    FIRMS_RECENT_DAYS,
    FIRMS_BUFFER_M,
    INPUT_FIRE_ASSET_ID,
    INPUT_BUFFER_M,
    LOCAL_FUEL_TYPE_ASSET_ID,
    NEGATIVE_ELIGIBLE_MODE,
    ENABLE_RF,
    COMPUTE_OOB,
    OOB_TIMEOUT_MS,
    EXPORT_SCALE_M,
    EXPORT_FOLDER,
    GCS_BUCKET,
    GCS_KEY_FILE,
    CRON,
    CACHE_TTL_SECONDS,
    SNAPSHOT_GRACE_DAYS,
    GEE_TIMEOUT_MS,
    GEE_POLL_INTERVAL_MS,
    GEE_POLL_MAX_ATTEMPTS,
    MINIO_BUCKET,
    KONTUM_BBOX,
    LST_SCALE_FACTOR,
    LST_KELVIN_OFFSET,
    MIN_TEMP_FOR_NESTEROV_C,
    WEIGHT_THRESHOLD,
    WEIGHT_RF,
    WEIGHT_INPUT_WITH_INPUT,
    WEIGHT_RF_WITH_INPUT,
    WEIGHT_THRESHOLD_WITH_INPUT,
    WEIGHT_P_NESTEROV,
    WEIGHT_NDVI_DROUGHT,
    WEIGHT_NDMI_DROUGHT,
    WEIGHT_LST,
    isGcsConfigured,
};
