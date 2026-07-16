-- ============================================================================
-- Migration 019: FIRE RISK / CẢNH BÁO CHÁY RỪNG (EP-06)
--
-- Lưu trữ kết quả tính toán từ Google Earth Engine:
--   - fire_risk_snapshots: mỗi lần chạy cronjob → 1 snapshot tổng hợp
--   - fire_risk_features:  vùng cháy rủi ro cao (level 4-5) dưới dạng geometry
--
-- GEE Pipeline:
--   Sentinel-2 (NDVI/NDMI/NBR) + MODIS LST + ERA5-Land (thời tiết) + P Nesterov
--   → FinalFireRiskScore (0-1) → RiskLevel (1-5)
--   → reduceRegions per district → stats JSON → DB
--   → Xuất GeoTIFF → MinIO → GeoServer harvest (async)
--
-- Idempotent: IF NOT EXISTS + ON CONFLICT + || merge JSONB cho RBAC.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE SCHEMA IF NOT EXISTS fire;

-- ── 1. fire_risk_snapshots ────────────────────────────────────────────────────
-- Mỗi hàng = 1 lần chạy GEE (thường daily lúc 06:00 VN).
-- status:
--   pending   → job đã tạo, chưa tính
--   computing → đang gọi GEE
--   completed → tính xong, district_stats và province_summary sẵn sàng
--   failed    → lỗi GEE hoặc timeout
--   exporting → đang export raster sang GCS/MinIO
--   published → raster đã harvest vào GeoServer
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fire.fire_risk_snapshots (
    id                   BIGSERIAL PRIMARY KEY,

    -- Ngày kết thúc cửa sổ phân tích (ANALYSIS_END trong GEE script).
    analysis_date        DATE        NOT NULL,

    -- Trạng thái pipeline.
    status               VARCHAR(20) NOT NULL DEFAULT 'pending'
                         CHECK (status IN (
                             'pending', 'computing', 'completed', 'failed',
                             'exporting', 'published'
                         )),

    -- Tham số model được dùng khi tính toán (version, window, thresholds…).
    model_params         JSONB       NOT NULL DEFAULT '{}',

    -- Tổng hợp toàn tỉnh: { maxLevel, avgRiskLevel, riskLevelDist:{0..5},
    --   pNesterovProvMean, s2CoverageRatio, blendCaseHa, confidenceHa }
    province_summary     JSONB,

    -- Thống kê theo huyện: [{unitCode, name, riskLevelDist:{0..5},
    --   pNesterovMean, s2Coverage, blendCaseHa, confidenceHa}]
    district_stats       JSONB,

    -- Phân phối P Nesterov toàn tỉnh: {mean, max, pctBelow5k, pctAbove20k}
    p_nesterov_stats     JSONB,

    -- Tỷ lệ phủ Sentinel-2 (0-1): pixel có ảnh hợp lệ / tổng pixel rừng.
    s2_coverage_ratio    NUMERIC(5,4),

    -- Raster export (async flow sau khi stats xong).
    gee_task_id          VARCHAR(200),      -- GEE Export task ID
    minio_key            VARCHAR(500),      -- Object key trong MinIO
    geoserver_layer      VARCHAR(255),      -- VD: "kontum:fire_risk_20260706"
    geoserver_store      VARCHAR(120),      -- VD: "fire_risk_20260706"

    error_message        TEXT,

    -- Thời điểm hoàn thành bước tính stats (completed).
    computed_at          TIMESTAMPTZ,

    -- Thời điểm GeoServer harvest xong (published).
    published_at         TIMESTAMPTZ,

    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_fire_risk_analysis_date
    ON fire.fire_risk_snapshots (analysis_date);
CREATE INDEX IF NOT EXISTS idx_fire_risk_snapshots_status
    ON fire.fire_risk_snapshots (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fire_risk_snapshots_date
    ON fire.fire_risk_snapshots (analysis_date DESC);

DROP TRIGGER IF EXISTS trg_fire_risk_snapshots_updated_at ON fire.fire_risk_snapshots;
CREATE TRIGGER trg_fire_risk_snapshots_updated_at
    BEFORE UPDATE ON fire.fire_risk_snapshots
    FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();

-- ── 2. fire_risk_features ─────────────────────────────────────────────────────
-- Vùng rủi ro cháy rừng level 4-5 dạng polygon (PostGIS) để hiển thị bản đồ.
-- Xuất từ GEE reduceToVectors() hoặc tính từ district stats + admin boundary.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fire.fire_risk_features (
    id              BIGSERIAL PRIMARY KEY,
    snapshot_id     BIGINT NOT NULL REFERENCES fire.fire_risk_snapshots(id) ON DELETE CASCADE,

    risk_level      SMALLINT    NOT NULL CHECK (risk_level BETWEEN 1 AND 5),
    district_code   VARCHAR(10),
    district_name   VARCHAR(120),

    -- Diện tích tính từ GEE reduceRegion (ha).
    area_ha         NUMERIC(14, 2),

    -- Trung bình P Nesterov vùng này.
    p_nesterov_mean NUMERIC(10, 2),

    -- Trung bình NDVI vùng này (vegetation health indicator).
    ndvi_mean       NUMERIC(6, 4),

    -- GeoJSON properties phụ thêm.
    properties      JSONB        NOT NULL DEFAULT '{}',

    -- Geometry từ GEE vector export (hoặc join với admin boundary).
    -- NULL khi chỉ có stats mà chưa có vector export.
    geom            GEOMETRY(MULTIPOLYGON, 4326),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fire_risk_features_snapshot
    ON fire.fire_risk_features (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_fire_risk_features_level
    ON fire.fire_risk_features (risk_level);
CREATE INDEX IF NOT EXISTS idx_fire_risk_features_district
    ON fire.fire_risk_features (district_code);
CREATE INDEX IF NOT EXISTS idx_fire_risk_features_geom
    ON fire.fire_risk_features USING GIST (geom) WHERE geom IS NOT NULL;

-- ── 3. RBAC ──────────────────────────────────────────────────────────────────
-- fire_risk.read   : xem kết quả (admin + citizen)
-- fire_risk.manage : kích hoạt thủ công, xem history chi tiết (admin only)

UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb) ||
    '{"fire_risk":{"read":true,"manage":true}}'::jsonb
WHERE code = 'system_admin';

UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb) ||
    '{"fire_risk":{"read":true,"manage":true}}'::jsonb
WHERE code = 'so_nnmt';

UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb) ||
    '{"fire_risk":{"read":true,"manage":true}}'::jsonb
WHERE code = 'ubnd_tinh';

UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb) ||
    '{"fire_risk":{"read":true}}'::jsonb
WHERE code = 'citizen';
