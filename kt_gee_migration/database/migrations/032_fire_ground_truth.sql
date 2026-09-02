-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 032: Ground Truth (GT) cho fire-risk
--
-- 2 loại input:
--   1. ZONE — MultiPolygon GeoJSON (vùng cháy đã xác nhận từ field/FIRMS)
--   2. POINT — điểm quan sát đơn lẻ (ranger, citizen report, hình ảnh field)
--
-- Pipeline fire-risk sẽ query cả 2 bảng trong cửa sổ N ngày trước analysisDate,
-- convert thành ee.FeatureCollection inline → dùng làm nhãn training weighted
-- cho Random Forest (blend 50% khi có GT, thay vì 60% dataset khi không có).
--
-- Bookkeeping snapshot: cột gt_zone_count + gt_point_count để trace GT nào đã
-- được dùng cho snapshot nào.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. Bảng ZONE ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fire.fire_gt_zones (
    id              BIGSERIAL PRIMARY KEY,
    name            VARCHAR(200),                        -- "Cháy Đăk Glei 15/07"
    occurred_at     TIMESTAMPTZ NOT NULL,                -- ngày giờ cháy đã biết
    severity        SMALLINT NOT NULL DEFAULT 3
                    CHECK (severity BETWEEN 1 AND 5),    -- C1-C5 khớp với RiskLevel
    source          VARCHAR(64) DEFAULT 'field_survey',  -- field_survey|firms_confirmed|other
    geom            GEOMETRY(MULTIPOLYGON, 4326) NOT NULL,
    area_ha         NUMERIC(12,2),                       -- auto ST_Area/10000
    notes           TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,       -- soft-delete để không rewrite lịch sử
    created_by      BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fire_gt_zones_geom_gist
    ON fire.fire_gt_zones USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_fire_gt_zones_occurred
    ON fire.fire_gt_zones (occurred_at DESC)
    WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_fire_gt_zones_severity
    ON fire.fire_gt_zones (severity)
    WHERE is_active = TRUE;

-- ── 2. Bảng POINT ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fire.fire_gt_points (
    id              BIGSERIAL PRIMARY KEY,
    occurred_at     TIMESTAMPTZ NOT NULL,
    severity        SMALLINT NOT NULL DEFAULT 3
                    CHECK (severity BETWEEN 1 AND 5),
    lng             NUMERIC(9,6) NOT NULL
                    CHECK (lng BETWEEN 106 AND 109),      -- clamp Kon Tum range
    lat             NUMERIC(8,6) NOT NULL
                    CHECK (lat BETWEEN 13 AND 16.5),
    geom            GEOMETRY(POINT, 4326) NOT NULL,
    source          VARCHAR(64) DEFAULT 'field_report',
        -- field_report | ranger | firms | citizen | other
    photo_url       TEXT,
    reporter_name   VARCHAR(200),
    notes           TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_by      BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fire_gt_points_geom_gist
    ON fire.fire_gt_points USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_fire_gt_points_occurred
    ON fire.fire_gt_points (occurred_at DESC)
    WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_fire_gt_points_severity
    ON fire.fire_gt_points (severity)
    WHERE is_active = TRUE;

-- ── 3. Trigger auto-compute area_ha cho zones ────────────────────────────────

CREATE OR REPLACE FUNCTION fire.compute_gt_zone_area()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.geom IS NOT NULL THEN
        -- ST_Area trên geography (m²) chính xác hơn planar. /10000 → hectare.
        NEW.area_ha := ST_Area(NEW.geom::geography) / 10000.0;
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fire_gt_zones_area ON fire.fire_gt_zones;
CREATE TRIGGER trg_fire_gt_zones_area
    BEFORE INSERT OR UPDATE OF geom ON fire.fire_gt_zones
    FOR EACH ROW EXECUTE FUNCTION fire.compute_gt_zone_area();

-- ── 4. Trigger auto-fill geom cho points từ lng/lat ──────────────────────────

CREATE OR REPLACE FUNCTION fire.compute_gt_point_geom()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.geom IS NULL THEN
        NEW.geom := ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fire_gt_points_geom ON fire.fire_gt_points;
CREATE TRIGGER trg_fire_gt_points_geom
    BEFORE INSERT OR UPDATE OF lng, lat ON fire.fire_gt_points
    FOR EACH ROW EXECUTE FUNCTION fire.compute_gt_point_geom();

-- ── 5. Bookkeeping cho snapshot ──────────────────────────────────────────────
-- Ghi số GT đã dùng khi build snapshot → admin trace được impact.

ALTER TABLE fire.fire_risk_snapshots
    ADD COLUMN IF NOT EXISTS gt_zone_count  INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS gt_point_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS gt_window_days SMALLINT;

COMMENT ON COLUMN fire.fire_risk_snapshots.gt_zone_count  IS 'Số zone GT active dùng cho snapshot (0 = không có GT)';
COMMENT ON COLUMN fire.fire_risk_snapshots.gt_point_count IS 'Số point GT active dùng cho snapshot';
COMMENT ON COLUMN fire.fire_risk_snapshots.gt_window_days IS 'Cửa sổ GT (ngày) đã áp dụng — mặc định env FIRE_RISK_GT_WINDOW_DAYS';

-- ── 6. RBAC ──────────────────────────────────────────────────────────────────
-- fire_risk.ground_truth = quyền upload/xóa GT. Cấp cho system_admin + so_nnmt.
-- Dùng jsonb_set với inner || (không overwrite các action fire_risk khác).

UPDATE auth.roles
SET permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{fire_risk}',
    COALESCE(permissions->'fire_risk', '{}'::jsonb)
        || '{"ground_truth": true}'::jsonb,
    TRUE
)
WHERE code IN ('system_admin', 'so_nnmt');

-- ── 7. View helper: GT trong cửa sổ N ngày trước 1 ngày (dùng bởi pipeline) ──
-- Không phải materialized — dữ liệu GT rất nhỏ (max vài trăm feature/tháng).

CREATE OR REPLACE VIEW fire.v_gt_recent_zones AS
SELECT id, name, occurred_at, severity, source, geom, area_ha
FROM fire.fire_gt_zones
WHERE is_active = TRUE;

CREATE OR REPLACE VIEW fire.v_gt_recent_points AS
SELECT id, occurred_at, severity, source, lng, lat, geom
FROM fire.fire_gt_points
WHERE is_active = TRUE;
