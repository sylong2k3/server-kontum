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

// Random Forest config (GEE-side, kept here for documentation / log).
const RF_TREES                    = 100;
const RF_BAG_FRACTION             = 0.70;
const TRAIN_SCALE_M               = 500;
const TRAIN_SAMPLES_PER_CLASS     = 100;

// GEE export settings.
const EXPORT_SCALE_M              = 250;
const EXPORT_FOLDER               = 'GEE_FireWarning';

// ── GCS (Google Cloud Storage) for raster export ─────────────────────────────
const GCS_BUCKET                  = process.env.GEE_GCS_BUCKET || '';
const GCS_KEY_FILE                = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';

// ── Cron & cache ──────────────────────────────────────────────────────────────
// Default: hàng ngày lúc 06:00 giờ VN = 23:00 UTC ngày hôm trước.
const CRON                        = process.env.FIRE_RISK_CRON || '0 23 * * *';

// Thời gian cache cho /latest (giây). Mặc định 6 giờ vì GEE tính ~5-10 phút.
const CACHE_TTL_SECONDS           = parseInt(process.env.FIRE_RISK_CACHE_TTL, 10) || 6 * 3600;

// Xóa snapshot cũ hơn N ngày khi dọn dẹp.
const SNAPSHOT_GRACE_DAYS         = parseInt(process.env.FIRE_RISK_SNAPSHOT_GRACE_DAYS, 10) || 90;

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
const WEIGHT_THRESHOLD            = 0.40;
const WEIGHT_RF                   = 0.60;

// Trọng số các chỉ số trong threshold score.
const WEIGHT_P_NESTEROV           = 0.45;
const WEIGHT_NDVI_DROUGHT         = 0.25;
const WEIGHT_NDMI_DROUGHT         = 0.20;
const WEIGHT_LST                  = 0.10;

// ── Bounding region (FAO GAUL level 1 filter) ─────────────────────────────────
const GAUL_L1_ADM0 = 'Viet Nam';
const GAUL_L1_ADM1 = 'Kon Tum';
const GAUL_L2_ADM1 = 'Kon Tum'; // Tên ADM1 trong level-2 dataset.

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
    TRAIN_SCALE_M,
    TRAIN_SAMPLES_PER_CLASS,
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
    WEIGHT_P_NESTEROV,
    WEIGHT_NDVI_DROUGHT,
    WEIGHT_NDMI_DROUGHT,
    WEIGHT_LST,
    GAUL_L1_ADM0,
    GAUL_L1_ADM1,
    GAUL_L2_ADM1,
    isGcsConfigured,
};
