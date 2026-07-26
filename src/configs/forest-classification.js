'use strict';

require('dotenv').config();

// =====================================================================
// Forest classification config — port từ kontum_forest_classification_final.js v5.3
//
// So với v3 (server cũ):
//   - RF: 200 trees → 100 trees, min leaf 2 → 3
//   - Sampling: SAMPLES_PER_CLASS cố định → SAMPLE_BUDGET + sqrt(diện tích) quotas
//   - Sample scale 30 m → 200 m (v4.1 nhấn mạnh ổn định + throughput)
//   - Cửa sổ mùa: DRY 1-4 → 3-4, thêm DEFOL 1-2 (tách cao su), rename WET → GREEN 9-11
//   - Cửa sổ nền BASE = 12 tháng "gần nhất", KHÔNG tính theo BASE_START_MONTH/END_MONTH
//     (giữ BASE_START_MONTH/END_MONTH để backwards-compat, nhưng pipeline v4.1
//      dùng WIN_BASE_MONTHS + WIN_RECENT_MONTHS làm anchor)
//   - Fix FOREST_CLASS_IDS: bỏ class 1 (Cây công nghiệp) theo QĐ 99
//   - Thêm TILE_SCALE=4 (v3 dùng 16 — bị timeout)
//   - Thêm ngưỡng metadata pre-filter (MAX_LS_CLOUD 70 %, MAX_S2_CLOUD 50 %)
//   - Thêm ROY_SLOPE/ROY_ITCP để harmonize L5/L7 → OLI
//   - Thêm GT_BLOCK_M spatial split (fix accuracy inflation của v3 random split)
//   - Thêm AREA_PRIOR, REQUIRED_CLASSES, OPTIONAL_CLASSES cho quota + gate
//   - Bỏ Dynamic World hoàn toàn (v4.1 comment: DW.trees gộp cả cao su/cà phê → không giúp)
//   - ESA WorldCover chỉ dùng đúng epoch (v100=2020, v200=2021), không lệch năm
// =====================================================================

// ── Season windows (v4.1: BASE-months anchored on monthStart) ────────────────
// v4.1 tính:
//   base   = 12 tháng gần nhất trước anchorEnd (anchor = ngày đầu tháng KẾ sau)
//   green  = cửa sổ mùa xanh gần nhất (Sept–Nov mà kết thúc ≤ anchor)
//   dry    = cửa sổ khô đỉnh (Mar–Apr, cao su ĐÃ ra lá lại)
//   defol  = cửa sổ trơ cành cao su (Jan–Feb)
//   recent = 3 tháng gần nhất
const WIN_BASE_MONTHS   = parseInt(process.env.FC_WIN_BASE_MONTHS,   10) || 12;
const WIN_RECENT_MONTHS = parseInt(process.env.FC_WIN_RECENT_MONTHS, 10) || 3;
const WIN_GREEN_START   = parseInt(process.env.FC_WIN_GREEN_START,   10) || 9;
const WIN_GREEN_END     = parseInt(process.env.FC_WIN_GREEN_END,     10) || 11;
const WIN_DRY_START     = parseInt(process.env.FC_WIN_DRY_START,     10) || 3;
const WIN_DRY_END       = parseInt(process.env.FC_WIN_DRY_END,       10) || 4;
const WIN_DEFOL_START   = parseInt(process.env.FC_WIN_DEFOL_START,   10) || 1;
const WIN_DEFOL_END     = parseInt(process.env.FC_WIN_DEFOL_END,     10) || 2;

// ── Legacy month bounds (giữ để backwards-compat với satellite util) ─────────
const BASE_START_MONTH = parseInt(process.env.FC_BASE_START_MONTH, 10) || 1;
const BASE_END_MONTH   = parseInt(process.env.FC_BASE_END_MONTH,   10) || 12;
const DRY_START_MONTH  = parseInt(process.env.FC_DRY_START_MONTH,  10) || WIN_DRY_START;
const DRY_END_MONTH    = parseInt(process.env.FC_DRY_END_MONTH,    10) || WIN_DRY_END;
const WET_START_MONTH  = parseInt(process.env.FC_WET_START_MONTH,  10) || WIN_GREEN_START;
const WET_END_MONTH    = parseInt(process.env.FC_WET_END_MONTH,    10) || WIN_GREEN_END;

// ── Scales (v4.1 mặc định 200 m cho sample + display) ────────────────────────
// v4.1 SCALE_SAMPLE = 200 m để đồ thị GEE ổn định. SCALE_RARE=100m dùng cho
// lớp có diện tích < 20.000 ha để đảm bảo đủ mẫu.
const SAMPLE_SCALE_M      = parseInt(process.env.FC_SAMPLE_SCALE_M,      10) || 100;
const SAMPLE_SCALE_RARE_M = parseInt(process.env.FC_SAMPLE_SCALE_RARE_M, 10) || 60;
const CLASSIFY_SCALE_M    = parseInt(process.env.FC_CLASSIFY_SCALE_M,    10) || 30;
const AREA_STATS_SCALE_M  = parseInt(process.env.FC_AREA_STATS_SCALE_M,  10) || 100;
const DISPLAY_SCALE_M     = parseInt(process.env.FC_DISPLAY_SCALE_M,     10) || 200;
const PIN_DISPLAY_SCALE   = process.env.FC_PIN_DISPLAY !== 'false';

// ── Random Forest (v4.1: 100 trees, min-leaf 3) ──────────────────────────────
const RF_TREES               = parseInt(process.env.FC_RF_TREES,        10) || 100;
const RF_VARIABLES_PER_SPLIT = parseInt(process.env.FC_RF_VARS_SPLIT,   10) || 6;
const RF_MIN_LEAF_POPULATION = parseInt(process.env.FC_RF_MIN_LEAF,     10) || 3;
const RF_BAG_FRACTION        = parseFloat(process.env.FC_RF_BAG_FRACTION)   || 0.70;

// ── Sampling budget + quotas (v4.1: sqrt(area) + min/max clamp) ──────────────
const SAMPLE_BUDGET       = parseInt(process.env.FC_SAMPLE_BUDGET,       10) || 1800;
const SAMPLE_MIN          = parseInt(process.env.FC_SAMPLE_MIN,          10) || 60;
const SAMPLE_MAX          = parseInt(process.env.FC_SAMPLE_MAX,          10) || 450;
const MIN_TRAIN_PER_CLASS = parseInt(process.env.FC_MIN_TRAIN_PER_CLASS, 10) || 40;
// Số lớp tối thiểu có đủ mẫu để RF được train. Dưới ngưỡng này chỉ xuất
// nhãn ngưỡng (không train RF) để tránh model degenerate.
const GATE_NO_TRAIN       = parseInt(process.env.FC_GATE_NO_TRAIN,       10) || 8;

// v3 compat — không dùng trong pipeline v4.1 nhưng vẫn giữ để không đổi API
// công cộng của config module.
const SAMPLES_PER_CLASS   = parseInt(process.env.FC_SAMPLES_PER_CLASS,   10) || 100;

// ── Ground-truth spatial split (v4.1: KHÔNG random điểm) ─────────────────────
// v4.1 chia GT theo KHỐI KHÔNG GIAN — random điểm khiến train/test cùng lô,
// cùng cây, cách nhau vài chục mét → accuracy "ảo".
const GT_BLOCK_M          = parseInt(process.env.FC_GT_BLOCK_M,      10) || 5000;
const GT_TRAIN_FRAC       = parseFloat(process.env.FC_GT_TRAIN_FRAC)      || 0.7;
const GT_BUFFER_M         = parseInt(process.env.FC_GT_BUFFER_M,     10) || 150;

// ── GEE runtime tuning (v4.1: TILE_SCALE 4, cloud pre-filter) ────────────────
const TILE_SCALE          = parseInt(process.env.FC_TILE_SCALE,      10) || 8;
const MAX_LS_CLOUD        = parseInt(process.env.FC_MAX_LS_CLOUD,    10) || 70;
const MAX_S2_CLOUD        = parseInt(process.env.FC_MAX_S2_CLOUD,    10) || 50;
// Texture chỉ nên bật cho vùng nhỏ (< 100 km²) vì reduceNeighborhood đắt.
const USE_TEXTURE         = process.env.FC_USE_TEXTURE === 'true';
const USE_DW_BUILT        = process.env.FC_USE_DW_BUILT !== 'false';
const DW_BUILT_MIN        = parseFloat(process.env.FC_DW_BUILT_MIN) || 0.12;
const OTHER_LAND_ASSET    = process.env.FC_OTHER_LAND_ASSET || '';
const MIN_SCORE           = parseFloat(process.env.FC_MIN_SCORE) || 0.70;

// ── 13-class schema: 0 no-data, 1-11 land cover, 12 unknown ──────────────────
const CLASS_NAMES = [
    'Không có ảnh',
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
    'Không xác định',
];

const CLASS_PALETTE = [
    '#D9D9D9', '#FFBEE8', '#FFEBB0', '#F0E442', '#FEFF73',
    '#AAFF03', '#D0FF73', '#E7E600', '#4DE600', '#FFAA01',
    '#73B2FF', '#55FF00', '#8C8C8C',
];

// AREA_PRIOR (ha) từ QĐ 99/QĐ-UBND 28/02/2025 — dùng để phân bổ quota mẫu
// theo sqrt(diện tích). Index tương ứng với ID lớp 0-10.
const AREA_PRIOR = [0, 58775, 115311, 181136, 15881, 448517, 13337, 516, 74101, 23839, 9035, 26971, 8000];

// Lớp 6 (rừng lá rộng rụng lá) chỉ có 515,55 ha ≈ 13 pixel ở 200 m — tùy chọn.
// Đủ 10 lớp bắt buộc thì mới xuất diện tích chính thức.
const REQUIRED_CLASSES = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11];
const OPTIONAL_CLASSES = [0, 7, 12];
const NO_TRAIN_CLASSES = [0];
const NODATA_ID = 0;
const UNKNOWN_ID = 12;

// Tổng diện tích Kon Tum (ha) — dùng để log tỷ lệ lệch của tổng classify.
const PROVINCE_TOTAL_HA = 967417;

// FIX AUDIT I.1: Forest classes theo QĐ 99 = {3,4,5,6,7,8}. Class 1 (Cây công
// nghiệp) KHÔNG được tính là rừng dù cao su có ~40.000 ha được lâm nghiệp kiểm
// kê là "rừng trồng" — quy ước schema này để phi rừng nhất quán.
const FOREST_CLASS_IDS = [4, 5, 6, 7, 8, 9];

// Chỉ số theo dõi thảm cây thân gỗ mở rộng (bao gồm cây công nghiệp).
// Không được gọi là "diện tích rừng" theo QĐ 99 — chỉ dùng cho báo cáo tổng
// hợp mở rộng nếu cần.
const TREE_DOMINATED_CLASS_IDS = [2, 4, 5, 6, 7, 8, 9];

// ── Landsat harmonization coefficients (Roy et al. 2016) ─────────────────────
// TM/ETM+ → OLI hệ số cho 6 band [blue, green, red, nir, swir1, swir2].
// Không có bước này thì chuỗi 1991→nay gãy tại 2013 (chuyển L7→L8).
const ROY_SLOPE = [0.8474, 0.8483, 0.9047, 0.8462, 0.8937, 0.9071];
const ROY_ITCP  = [0.0003, 0.0088, 0.0061, 0.0412, 0.0254, 0.0172];

// FALLBACK reflectance (áp cuối chuỗi — tránh NaN lan sang mọi chỉ số).
const FALLBACK_REFLECTANCE = [0.045, 0.065, 0.055, 0.28, 0.16, 0.085];

// ── Cron schedule ────────────────────────────────────────────────────────────
const CRON = process.env.FC_CRON || '0 0 1 * *';

// ── Alerts ───────────────────────────────────────────────────────────────────
const ALERT_FOREST_CHANGE_PCT = parseFloat(process.env.FC_ALERT_CHANGE_PCT) || 2.0;

// ── GCS export ───────────────────────────────────────────────────────────────
const GCS_BUCKET    = process.env.GEE_GCS_BUCKET || '';
const GCS_KEY_FILE  = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
const MINIO_BUCKET  = process.env.FC_MINIO_BUCKET || 'forest-classification';
const EXPORT_SCALE_M = parseInt(process.env.FC_EXPORT_SCALE_M, 10) || 30;
// DOWNLOAD_SCALE_M — mặc định 100m sau migration 040. Pipeline mới gọi
// getDownloadURL PER district (loop RanhGioiHuyen_Polygon.geojson), không phải
// 1 URL toàn tỉnh, nên 100m fit ~1e9 maxPixels cho từng huyện nhỏ.
const DOWNLOAD_SCALE_M = parseInt(process.env.FC_DOWNLOAD_SCALE_M, 10) || 100;

// ── Cleanup ──────────────────────────────────────────────────────────────────
const SNAPSHOT_GRACE_MONTHS = parseInt(process.env.FC_SNAPSHOT_GRACE_MONTHS, 10) || 24;

// ── GEE timeout ──────────────────────────────────────────────────────────────
const GEE_TIMEOUT_MS = parseInt(process.env.GEE_TIMEOUT_MS, 10) || 5 * 60 * 1000;
const OOB_TIMEOUT_MS = parseInt(process.env.FC_OOB_TIMEOUT_MS, 10) || 10 * 60 * 1000;

// ── Lite mode (on-demand /satellite/classified) ──────────────────────────────
// v4.1 base pipeline đã nhẹ hơn v3 rất nhiều (200 m sample, 100 trees, 1 master
// collection). Lite mode chỉ dùng để bỏ external priors (WorldCover epoch,
// JRC water) và giảm sample budget khoảng 30 %.
const LITE_SAMPLE_BUDGET     = parseInt(process.env.FC_LITE_SAMPLE_BUDGET,     10) || Math.round(SAMPLE_BUDGET * 0.7);
const LITE_SAMPLES_PER_CLASS = parseInt(process.env.FC_LITE_SAMPLES_PER_CLASS, 10) || 30;
const LITE_SAMPLE_SCALE_M    = parseInt(process.env.FC_LITE_SAMPLE_SCALE_M,    10) || SAMPLE_SCALE_M;
const LITE_RF_TREES          = parseInt(process.env.FC_LITE_RF_TREES,          10) || 80;
const LITE_USE_DATASET_LABELS = process.env.FC_LITE_USE_DATASET_LABELS === 'true';

const isGcsConfigured = () => Boolean(GCS_BUCKET);

module.exports = {
    // Windows (v4.1)
    WIN_BASE_MONTHS,
    WIN_RECENT_MONTHS,
    WIN_GREEN_START,
    WIN_GREEN_END,
    WIN_DRY_START,
    WIN_DRY_END,
    WIN_DEFOL_START,
    WIN_DEFOL_END,

    // Legacy month bounds (v3 compat)
    BASE_START_MONTH,
    BASE_END_MONTH,
    DRY_START_MONTH,
    DRY_END_MONTH,
    WET_START_MONTH,
    WET_END_MONTH,

    // Scales
    SAMPLE_SCALE_M,
    SAMPLE_SCALE_RARE_M,
    CLASSIFY_SCALE_M,
    AREA_STATS_SCALE_M,
    DISPLAY_SCALE_M,
    PIN_DISPLAY_SCALE,

    // RF
    RF_TREES,
    RF_VARIABLES_PER_SPLIT,
    RF_MIN_LEAF_POPULATION,
    RF_BAG_FRACTION,

    // Sampling
    SAMPLE_BUDGET,
    SAMPLE_MIN,
    SAMPLE_MAX,
    MIN_TRAIN_PER_CLASS,
    GATE_NO_TRAIN,
    SAMPLES_PER_CLASS,      // v3 compat

    // GT spatial split
    GT_BLOCK_M,
    GT_TRAIN_FRAC,
    GT_BUFFER_M,

    // GEE tuning
    TILE_SCALE,
    MAX_LS_CLOUD,
    MAX_S2_CLOUD,
    USE_TEXTURE,
    USE_DW_BUILT,
    DW_BUILT_MIN,
    OTHER_LAND_ASSET,
    MIN_SCORE,

    // 11-class schema
    CLASS_NAMES,
    CLASS_PALETTE,
    AREA_PRIOR,
    REQUIRED_CLASSES,
    OPTIONAL_CLASSES,
    NO_TRAIN_CLASSES,
    NODATA_ID,
    UNKNOWN_ID,
    PROVINCE_TOTAL_HA,
    FOREST_CLASS_IDS,
    TREE_DOMINATED_CLASS_IDS,

    // Landsat harmonization
    ROY_SLOPE,
    ROY_ITCP,
    FALLBACK_REFLECTANCE,

    // Ops
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

    // Lite
    LITE_SAMPLE_BUDGET,
    LITE_SAMPLES_PER_CLASS,
    LITE_SAMPLE_SCALE_M,
    LITE_RF_TREES,
    LITE_USE_DATASET_LABELS,

    isGcsConfigured,
};
