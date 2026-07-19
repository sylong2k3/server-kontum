-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 033: Ground Truth cho phân loại rừng 11-class (forest classification)
--
-- Cùng ý tưởng với 032 (fire-risk GT) nhưng KHÁC ở chỗ:
--   - Thang: class_id 0-10 (11 land cover class Kon Tum) thay vì severity 1-5
--   - Point vẫn có class_id (điểm mẫu đơn lẻ, ví dụ ranger đo "cây rừng trồng
--     tại tọa độ X,Y")
--   - Không có concept "severity" — chỉ có class_id
--
-- Pipeline forest classification sẽ:
--   1. Query cả 2 bảng trong cửa sổ N ngày trước analysis (thường 90-180 ngày
--      để có đủ mẫu cho RF, không như fire-risk 30 ngày)
--   2. Convert thành ee.FeatureCollection inline với property `class` = class_id
--   3. Truyền vào runRfClassification qua param mới `groundTruthGeoJson`
--   4. RF blend rule đã có: có GT → 50% input + 30% dataset + 20% threshold
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. ZONES ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS forest.forest_gt_zones (
    id              BIGSERIAL PRIMARY KEY,
    name            VARCHAR(200),                            -- "Rừng lá rộng thôn 5 Đăk Glei"
    observed_at     TIMESTAMPTZ NOT NULL,                    -- ngày khảo sát (tương đương occurred_at của fire)
    class_id        SMALLINT NOT NULL
                    CHECK (class_id BETWEEN 0 AND 10),       -- 11 class Kon Tum
    source          VARCHAR(64) DEFAULT 'field_survey',      -- field_survey|expert_review|other
    geom            GEOMETRY(MULTIPOLYGON, 4326) NOT NULL,
    area_ha         NUMERIC(12,2),                           -- auto ST_Area/10000
    notes           TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,           -- soft-delete
    created_by      BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_forest_gt_zones_geom_gist
    ON forest.forest_gt_zones USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_forest_gt_zones_observed
    ON forest.forest_gt_zones (observed_at DESC)
    WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_forest_gt_zones_class
    ON forest.forest_gt_zones (class_id)
    WHERE is_active = TRUE;

-- ── 2. POINTS ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS forest.forest_gt_points (
    id              BIGSERIAL PRIMARY KEY,
    observed_at     TIMESTAMPTZ NOT NULL,
    class_id        SMALLINT NOT NULL
                    CHECK (class_id BETWEEN 0 AND 10),
    lng             NUMERIC(9,6) NOT NULL
                    CHECK (lng BETWEEN 106 AND 109),         -- Kon Tum range
    lat             NUMERIC(8,6) NOT NULL
                    CHECK (lat BETWEEN 13 AND 16.5),
    geom            GEOMETRY(POINT, 4326) NOT NULL,
    source          VARCHAR(64) DEFAULT 'field_report',
        -- field_report | ranger | expert | citizen | other
    photo_url       TEXT,
    reporter_name   VARCHAR(200),
    notes           TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_by      BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_forest_gt_points_geom_gist
    ON forest.forest_gt_points USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_forest_gt_points_observed
    ON forest.forest_gt_points (observed_at DESC)
    WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_forest_gt_points_class
    ON forest.forest_gt_points (class_id)
    WHERE is_active = TRUE;

-- ── 3. Triggers auto-compute area/geom ───────────────────────────────────────

CREATE OR REPLACE FUNCTION forest.compute_gt_zone_area()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.geom IS NOT NULL THEN
        NEW.area_ha := ST_Area(NEW.geom::geography) / 10000.0;
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_forest_gt_zones_area ON forest.forest_gt_zones;
CREATE TRIGGER trg_forest_gt_zones_area
    BEFORE INSERT OR UPDATE OF geom ON forest.forest_gt_zones
    FOR EACH ROW EXECUTE FUNCTION forest.compute_gt_zone_area();

CREATE OR REPLACE FUNCTION forest.compute_gt_point_geom()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.geom IS NULL THEN
        NEW.geom := ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_forest_gt_points_geom ON forest.forest_gt_points;
CREATE TRIGGER trg_forest_gt_points_geom
    BEFORE INSERT OR UPDATE OF lng, lat ON forest.forest_gt_points
    FOR EACH ROW EXECUTE FUNCTION forest.compute_gt_point_geom();

-- ── 4. Bookkeeping snapshot ──────────────────────────────────────────────────

ALTER TABLE forest.forest_snapshots
    ADD COLUMN IF NOT EXISTS gt_zone_count   INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS gt_point_count  INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS gt_window_days  SMALLINT;

COMMENT ON COLUMN forest.forest_snapshots.gt_zone_count  IS 'Số zone GT active dùng cho snapshot (0 = không có GT)';
COMMENT ON COLUMN forest.forest_snapshots.gt_point_count IS 'Số point GT active dùng cho snapshot';
COMMENT ON COLUMN forest.forest_snapshots.gt_window_days IS 'Cửa sổ GT (ngày) — mặc định env FC_GT_WINDOW_DAYS = 180';

-- ── 5. RBAC ──────────────────────────────────────────────────────────────────

UPDATE auth.roles
SET permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{forest_classification}',
    COALESCE(permissions->'forest_classification', '{}'::jsonb)
        || '{"ground_truth": true}'::jsonb,
    TRUE
)
WHERE code IN ('system_admin', 'so_nnmt');

-- ── 6. Helper view ───────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW forest.v_gt_recent_zones AS
SELECT id, name, observed_at, class_id, source, geom, area_ha
FROM forest.forest_gt_zones
WHERE is_active = TRUE;

CREATE OR REPLACE VIEW forest.v_gt_recent_points AS
SELECT id, observed_at, class_id, source, lng, lat, geom
FROM forest.forest_gt_points
WHERE is_active = TRUE;
