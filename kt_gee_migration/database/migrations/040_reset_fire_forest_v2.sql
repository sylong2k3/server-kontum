-- ============================================================================
-- Migration 040 — Reset + consolidate Fire Risk & Forest Classification
--
-- Mục tiêu:
--   1. Xoá toàn bộ snapshot + feature/district-area lịch sử của fire-risk và
--      forest-classification (fresh start bản chính thức). KHÔNG đụng tới:
--        - ground truth (fire_gt_*, forest_gt_*)
--        - satellite.image_results (cache on-demand)
--        - MinIO objects / GeoServer layers (dọn tay nếu cần)
--   2. Đổi ràng buộc UNIQUE để cho phép nhiều lần chạy trong cùng ngày/tháng:
--        fire.fire_risk_snapshots:  (analysis_date)         → (analysis_date, attempt)
--        forest.forest_snapshots:   (year, month)           → (year, month, attempt)
--      Bug đã fix: refresh nhiều lần trong ngày không còn ghi đè dòng completed
--      cũ. `listCompleted` giờ trả đủ history mỗi lần chạy.
--   3. Thêm bảng theo dõi trạng thái xuất per-huyện (100m resolution):
--        fire.fire_risk_district_exports
--        forest.forest_district_exports
--      Pipeline mới chia phân loại + download URL theo từng huyện, tính diện
--      tích toàn tỉnh = Σ(district area). Mỗi hàng có state pending → computing
--      → completed/failed, có link raster-ingest job riêng nếu ingest per huyện.
--   4. Ghi thêm cột `export_scale_m` / `download_scale_m` để trace scale đã dùng.
--
-- Idempotent: dùng IF NOT EXISTS / IF EXISTS mọi nơi. Chạy lại an toàn.
-- ============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Xoá dữ liệu lịch sử (KHÔNG động vào ground truth / satellite cache)
-- ─────────────────────────────────────────────────────────────────────────────

-- Raster-ingest job liên quan (FK không cứng, xoá trước để không dedupe ngược
-- với snapshot mới nếu chạy lại pipeline).
DELETE FROM gis.raster_ingest_jobs
WHERE COALESCE(
          request_params #>> '{linkedResource,type}',
          request_params #>> '{linked_resource,type}'
      ) IN ('fire_risk', 'forest', 'forest_classification', 'fire_risk_district', 'forest_district')
   OR LEFT(layer_code, 10) = 'fire_risk_'
   OR LEFT(layer_code, 13) = 'forest_class_';

-- Bảng con tự CASCADE khi truncate cha vì đã khai báo FK ON DELETE CASCADE.
-- Vẫn liệt kê tường minh để phòng khi tương lai đổi thành SET NULL.
TRUNCATE TABLE
    fire.fire_risk_features,
    fire.fire_risk_snapshots,
    forest.forest_district_areas,
    forest.forest_snapshots
RESTART IDENTITY CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. FIRE RISK — snapshot: (analysis_date, attempt) UNIQUE + scale tracking
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE fire.fire_risk_snapshots
    ADD COLUMN IF NOT EXISTS attempt         SMALLINT NOT NULL DEFAULT 1
        CHECK (attempt BETWEEN 1 AND 100),
    ADD COLUMN IF NOT EXISTS export_scale_m  INT      NOT NULL DEFAULT 100
        CHECK (export_scale_m BETWEEN 10 AND 1000),
    ADD COLUMN IF NOT EXISTS district_export_summary JSONB;

COMMENT ON COLUMN fire.fire_risk_snapshots.attempt IS
    'Lần chạy trong cùng analysis_date. UPSERT bị bỏ — mỗi refresh tạo dòng mới với attempt++';
COMMENT ON COLUMN fire.fire_risk_snapshots.export_scale_m IS
    'Scale (m) dùng cho reduceRegions + getDownloadURL. Default 100.';
COMMENT ON COLUMN fire.fire_risk_snapshots.district_export_summary IS
    'Aggregate của fire_risk_district_exports: { total, completed, failed, totalHa, byLevel:{1..5:ha} }';

-- Xoá UNIQUE cũ trên analysis_date và tạo mới trên (analysis_date, attempt).
DROP INDEX IF EXISTS fire.uniq_fire_risk_analysis_date;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_fire_risk_analysis_date_attempt
    ON fire.fire_risk_snapshots (analysis_date, attempt);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. FOREST — snapshot: (year, month, attempt) UNIQUE + scale tracking
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE forest.forest_snapshots
    ADD COLUMN IF NOT EXISTS attempt          SMALLINT NOT NULL DEFAULT 1
        CHECK (attempt BETWEEN 1 AND 100),
    ADD COLUMN IF NOT EXISTS download_scale_m INT      NOT NULL DEFAULT 100
        CHECK (download_scale_m BETWEEN 10 AND 1000),
    ADD COLUMN IF NOT EXISTS district_export_summary JSONB;

COMMENT ON COLUMN forest.forest_snapshots.attempt IS
    'Lần chạy trong cùng (year, month). Mỗi refresh tạo dòng mới với attempt++';
COMMENT ON COLUMN forest.forest_snapshots.download_scale_m IS
    'Scale (m) dùng cho getDownloadURL per district. Default 100.';
COMMENT ON COLUMN forest.forest_snapshots.district_export_summary IS
    'Aggregate của forest_district_exports: { total, completed, failed, totalHa, forestHa, byClass:{0..12:ha} }';

-- Constraint 020 dùng syntax CONSTRAINT ... UNIQUE → dùng DROP CONSTRAINT.
ALTER TABLE forest.forest_snapshots
    DROP CONSTRAINT IF EXISTS forest_snapshots_year_month_uq;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_forest_snapshots_year_month_attempt
    ON forest.forest_snapshots (year, month, attempt);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. NEW — fire.fire_risk_district_exports: track per-district export state
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fire.fire_risk_district_exports (
    id                    BIGSERIAL PRIMARY KEY,
    snapshot_id           BIGINT NOT NULL REFERENCES fire.fire_risk_snapshots(id) ON DELETE CASCADE,

    -- Định danh huyện (từ RanhGioiHuyen_Polygon.geojson: ADM2_CODE, ADM2_NAME).
    district_code         VARCHAR(32),
    district_name         VARCHAR(128),

    -- pending   → chờ worker/pipeline pick up
    -- computing → đang gọi GEE reduceRegions + getDownloadURL cho huyện này
    -- completed → có area_stats + download URL
    -- failed    → GEE lỗi / timeout cho huyện này (không kéo theo snapshot fail)
    -- skipped   → huyện không có pixel hợp lệ (ngoài rừng / no data)
    status                VARCHAR(20) NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','computing','completed','failed','skipped')),

    -- Scale export cho huyện này (mặc định = snapshot.export_scale_m = 100m).
    scale_m               INT         NOT NULL DEFAULT 100
                          CHECK (scale_m BETWEEN 10 AND 1000),

    -- Kết quả tính diện tích cho huyện: giống shape district_stats cũ.
    -- { riskLevelDist:{0..5:ha}, blendCaseHa:{withInput,withoutInput},
    --   confidenceHa:{none,low,medium,high}, pNesterovMean, s2Coverage }
    area_stats            JSONB,

    -- Tổng diện tích có kết quả level ≥ 1 (dùng để aggregate lên tỉnh).
    total_area_ha         NUMERIC(12, 2),

    -- Assets GEE per district (tile URL riêng để hiển thị từng huyện + download).
    gee_map_id            VARCHAR(500),
    gee_tile_url          TEXT,
    gee_download_url      TEXT,
    gee_download_filename VARCHAR(200),
    gee_generated_at      TIMESTAMPTZ,

    -- Raster-ingest job riêng cho huyện này (optional — chỉ khi ingest MinIO/GeoServer).
    minio_key             TEXT,
    geoserver_layer       TEXT,
    geoserver_store       VARCHAR(120),
    raster_ingest_job_id  BIGINT REFERENCES gis.raster_ingest_jobs(id) ON DELETE SET NULL,

    error_message         TEXT,
    duration_ms           INTEGER,
    started_at            TIMESTAMPTZ,
    completed_at          TIMESTAMPTZ,

    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uniq_fire_district_export_snap_code
        UNIQUE (snapshot_id, district_code)
);

CREATE INDEX IF NOT EXISTS idx_fire_district_exports_snap
    ON fire.fire_risk_district_exports (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_fire_district_exports_status
    ON fire.fire_risk_district_exports (status, created_at DESC);
-- Worker query "pending việc cần chạy": partial index nhỏ, không quét toàn bảng.
CREATE INDEX IF NOT EXISTS idx_fire_district_exports_pending
    ON fire.fire_risk_district_exports (created_at)
    WHERE status IN ('pending','computing');

DROP TRIGGER IF EXISTS trg_fire_district_exports_updated_at ON fire.fire_risk_district_exports;
CREATE TRIGGER trg_fire_district_exports_updated_at
    BEFORE UPDATE ON fire.fire_risk_district_exports
    FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();

COMMENT ON TABLE fire.fire_risk_district_exports IS
    'Per-district export state cho fire-risk snapshot: chia GEE download URL theo huyện (scale 100m), aggregate lên tỉnh = Σ area';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. NEW — forest.forest_district_exports: same pattern cho forest classify
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS forest.forest_district_exports (
    id                    BIGSERIAL PRIMARY KEY,
    snapshot_id           BIGINT NOT NULL REFERENCES forest.forest_snapshots(id) ON DELETE CASCADE,

    district_code         VARCHAR(32),
    district_name         VARCHAR(128),

    status                VARCHAR(20) NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','computing','completed','failed','skipped')),

    scale_m               INT         NOT NULL DEFAULT 100
                          CHECK (scale_m BETWEEN 10 AND 1000),

    -- Diện tích ha theo class 0-12: { "0": 0, "1": ha, ..., "12": ha }.
    area_by_class         JSONB,

    -- Tổng diện tích có kết quả (Σ all class), và tổng riêng class rừng.
    total_area_ha         NUMERIC(12, 2),
    forest_area_ha        NUMERIC(12, 2),

    -- GEE per-district assets
    gee_map_id            VARCHAR(500),
    gee_tile_url          TEXT,
    gee_download_url      TEXT,
    gee_download_filename VARCHAR(200),
    gee_generated_at      TIMESTAMPTZ,

    -- Ingest tracking
    minio_key             TEXT,
    geoserver_layer       TEXT,
    geoserver_store       VARCHAR(120),
    raster_ingest_job_id  BIGINT REFERENCES gis.raster_ingest_jobs(id) ON DELETE SET NULL,

    error_message         TEXT,
    duration_ms           INTEGER,
    started_at            TIMESTAMPTZ,
    completed_at          TIMESTAMPTZ,

    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uniq_forest_district_export_snap_code
        UNIQUE (snapshot_id, district_code)
);

CREATE INDEX IF NOT EXISTS idx_forest_district_exports_snap
    ON forest.forest_district_exports (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_forest_district_exports_status
    ON forest.forest_district_exports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_forest_district_exports_pending
    ON forest.forest_district_exports (created_at)
    WHERE status IN ('pending','computing');

DROP TRIGGER IF EXISTS trg_forest_district_exports_updated_at ON forest.forest_district_exports;
CREATE TRIGGER trg_forest_district_exports_updated_at
    BEFORE UPDATE ON forest.forest_district_exports
    FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();

COMMENT ON TABLE forest.forest_district_exports IS
    'Per-district export state cho forest classification: chia GEE classified download theo huyện (scale 100m), aggregate byClass lên tỉnh = Σ per huyện';

COMMIT;
