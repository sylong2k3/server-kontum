'use strict';

require('dotenv').config();

// ── GEE pipeline settings ─────────────────────────────────────────────────────

// Year range for classification (used for composite construction).
// Month range for the base composite: January to December.
const BASE_START_MONTH = parseInt(process.env.FC_BASE_START_MONTH, 10) || 1;
const BASE_END_MONTH   = parseInt(process.env.FC_BASE_END_MONTH,   10) || 12;

// Dry season composite range (months for dryNDVI, dryMNDWI etc.)
const DRY_START_MONTH  = parseInt(process.env.FC_DRY_START_MONTH,  10) || 1;
const DRY_END_MONTH    = parseInt(process.env.FC_DRY_END_MONTH,    10) || 4;

// Wet season composite range.
const WET_START_MONTH  = parseInt(process.env.FC_WET_START_MONTH,  10) || 8;
const WET_END_MONTH    = parseInt(process.env.FC_WET_END_MONTH,    10) || 11;

// Scale for classification (m). 30 m matches Landsat; 60 m faster for area stats.
const CLASSIFY_SCALE_M = parseInt(process.env.FC_CLASSIFY_SCALE_M, 10) || 30;

// Scale for area stats (m). Larger = faster evaluate().
const AREA_STATS_SCALE_M = parseInt(process.env.FC_AREA_STATS_SCALE_M, 10) || 60;

// Random Forest parameters (mirrors lopPhuRungFinal.txt).
const RF_TREES              = parseInt(process.env.FC_RF_TREES,              10) || 200;
const RF_VARIABLES_PER_SPLIT = parseInt(process.env.FC_RF_VARS_SPLIT,        10) || 6;
const RF_MIN_LEAF_POPULATION = parseInt(process.env.FC_RF_MIN_LEAF,          10) || 2;
const RF_BAG_FRACTION       = parseFloat(process.env.FC_RF_BAG_FRACTION)        || 0.70;

// Sample points per class for training (from each pseudo-label source).
const SAMPLES_PER_CLASS     = parseInt(process.env.FC_SAMPLES_PER_CLASS,     10) || 100;
const SAMPLE_SCALE_M        = parseInt(process.env.FC_SAMPLE_SCALE_M,        10) || 30;

// ── 11-class schema ───────────────────────────────────────────────────────────

const CLASS_NAMES = [
    'Đất khác',
    'Cây công nghiệp',
    'Đất nông nghiệp',
    'Rừng hỗn giao lá rộng, lá kim',
    'Rừng lá rộng thường xanh',
    'Rừng lá kim',
    'Rừng lá rộng rụng lá',
    'Rừng tre nứa',
    'Rừng trồng',
    'Sông, suối, hồ',
    'Trảng cỏ, cây bụi',
];

const CLASS_PALETTE = [
    '#FFBEE8', // 0  Đất khác
    '#FFEBB0', // 1  Cây công nghiệp
    '#F0E442', // 2  Đất nông nghiệp
    '#FEFF73', // 3  Rừng hỗn giao
    '#AAFF03', // 4  Rừng lá rộng thường xanh
    '#D0FF73', // 5  Rừng lá kim
    '#E7E600', // 6  Rừng lá rộng rụng lá
    '#4DE600', // 7  Rừng tre nứa
    '#FFAA01', // 8  Rừng trồng
    '#73B2FF', // 9  Sông, suối, hồ
    '#55FF00', // 10 Trảng cỏ, cây bụi
];

// Forest classes (1-8) for area-change alerting.
const FOREST_CLASS_IDS = [1, 3, 4, 5, 6, 7, 8];

// ── Cron schedule ─────────────────────────────────────────────────────────────
// Chạy lúc 00:00 ngày 1 hàng tháng theo FC_CRON_TZ. Job luôn phân tích tháng
// vừa kết thúc, nên tự xử lý đúng tháng 28/29/30/31 ngày. Startup catch-up trong
// forest-classification.job.js bù kỳ bị lỡ nếu server ngừng đúng ngày 1.
const CRON = process.env.FC_CRON || '0 0 1 * *';

// ── Alerts ────────────────────────────────────────────────────────────────────
// Alert when total forest area change exceeds this % relative to previous month.
const ALERT_FOREST_CHANGE_PCT = parseFloat(process.env.FC_ALERT_CHANGE_PCT) || 2.0;

// ── GCS export ────────────────────────────────────────────────────────────────
const GCS_BUCKET    = process.env.GEE_GCS_BUCKET || '';
const GCS_KEY_FILE  = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
const MINIO_BUCKET  = process.env.FC_MINIO_BUCKET || 'forest-classification';
const EXPORT_SCALE_M = parseInt(process.env.FC_EXPORT_SCALE_M, 10) || 30;

// Scale riêng cho getDownloadURL (preview/publish raster clip theo tỉnh).
// Mặc định 500m, đồng bộ với scale tính toán ổn định của fire-risk để GEE không
// vượt memory limit khi materialize graph RF 11 lớp. Có thể override bằng
// FC_DOWNLOAD_SCALE_M khi hạ tầng/quota cho phép xuất chi tiết hơn.
const DOWNLOAD_SCALE_M = parseInt(process.env.FC_DOWNLOAD_SCALE_M, 10) || 500;

// ── Cleanup ───────────────────────────────────────────────────────────────────
const SNAPSHOT_GRACE_MONTHS = parseInt(process.env.FC_SNAPSHOT_GRACE_MONTHS, 10) || 24;

// ── GEE timeout ──────────────────────────────────────────────────────────────
const GEE_TIMEOUT_MS = parseInt(process.env.GEE_TIMEOUT_MS, 10) || 5 * 60 * 1000;
// OOB materializes the complete sampling + RF training graph. Keep a separate
// budget so admin snapshots can collect model diagnostics without relaxing
// every other synchronous GEE operation.
const OOB_TIMEOUT_MS = parseInt(process.env.FC_OOB_TIMEOUT_MS, 10) || 10 * 60 * 1000;

// ── Lite mode (on-demand /satellite/classified) ──────────────────────────────
// The full v3 pipeline (dry+wet composites × 8 indices × 4 Landsat + S2 + DW +
// WorldCover + JRC + 100 samples × 11 classes + 200 trees) is too heavy for
// interactive tile rendering — getMapId consistently hits GEE "Please try
// again" around 200 s. Lite mode preserves the essence (11-class RF from
// Landsat/S2 + threshold pseudo-labels) but drops the expensive parts.
const LITE_SAMPLES_PER_CLASS = parseInt(process.env.FC_LITE_SAMPLES_PER_CLASS, 10) || 30;
const LITE_SAMPLE_SCALE_M    = parseInt(process.env.FC_LITE_SAMPLE_SCALE_M,    10) || 100;
const LITE_RF_TREES          = parseInt(process.env.FC_LITE_RF_TREES,          10) || 80;
// Skip Dynamic World + ESA WorldCover + JRC GSW dataset labels in lite mode.
// The threshold pseudo-label alone still yields all 11 classes.
const LITE_USE_DATASET_LABELS = process.env.FC_LITE_USE_DATASET_LABELS === 'true';

const isGcsConfigured = () => Boolean(GCS_BUCKET);

module.exports = {
    BASE_START_MONTH,
    BASE_END_MONTH,
    DRY_START_MONTH,
    DRY_END_MONTH,
    WET_START_MONTH,
    WET_END_MONTH,
    CLASSIFY_SCALE_M,
    AREA_STATS_SCALE_M,
    RF_TREES,
    RF_VARIABLES_PER_SPLIT,
    RF_MIN_LEAF_POPULATION,
    RF_BAG_FRACTION,
    SAMPLES_PER_CLASS,
    SAMPLE_SCALE_M,
    CLASS_NAMES,
    CLASS_PALETTE,
    FOREST_CLASS_IDS,
    CRON,
    ALERT_FOREST_CHANGE_PCT,
    GCS_BUCKET,
    GCS_KEY_FILE,
    MINIO_BUCKET,
    EXPORT_SCALE_M,
    DOWNLOAD_SCALE_M,
    SNAPSHOT_GRACE_MONTHS,
    GEE_TIMEOUT_MS,
    OOB_TIMEOUT_MS,
    LITE_SAMPLES_PER_CLASS,
    LITE_SAMPLE_SCALE_M,
    LITE_RF_TREES,
    LITE_USE_DATASET_LABELS,
    isGcsConfigured,
};
