-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 031 — GEE Raster Ingest pipeline
--
-- Pipeline: GEE download URL → MinIO (S3) → GeoServer (S3GeoTiff CoverageStore)
--
-- Đợt 1: chỉ hỗ trợ source_kind = 'gee_download_url' và RGB visualize.
-- Job tracking bằng bảng gis.raster_ingest_jobs, worker poll bằng
-- FOR UPDATE SKIP LOCKED (cùng pattern với geoImport.worker.js).
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. Bảng job tracking ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gis.raster_ingest_jobs (
    id                  BIGSERIAL PRIMARY KEY,

    -- Định danh job & mối quan hệ
    layer_id            INT REFERENCES gis.layer_registry(id) ON DELETE SET NULL,
    layer_code          VARCHAR(60) NOT NULL,
    source_kind         VARCHAR(32) NOT NULL DEFAULT 'gee_download_url'
                        CHECK (source_kind IN ('gee_download_url')),

    -- Nguồn URL: lưu SHA256 để dedupe idempotent, không lưu URL đầy đủ (URL GEE
    -- chứa access token và hết hạn nhanh; grep log tránh lộ token).
    source_url          TEXT        NOT NULL,
    source_hash         CHAR(64)    NOT NULL,

    -- Yêu cầu render / xử lý
    request_params      JSONB       NOT NULL DEFAULT '{}',
        -- { bbox, epsg_code, scale_m, gee_map_id, gee_task_id, ... }

    -- State machine:
    --   pending → downloading → validating → uploading → publishing → completed
    --                                                              → failed
    -- Cột retry_count để worker biết đã thử mấy lần; > MAX thì set 'failed'.
    status              VARCHAR(24) NOT NULL DEFAULT 'pending'
                        CHECK (status IN (
                            'pending','downloading','validating','uploading',
                            'publishing','completed','failed','cancelled'
                        )),
    retry_count         SMALLINT    NOT NULL DEFAULT 0,
    progress            SMALLINT    NOT NULL DEFAULT 0
                        CHECK (progress BETWEEN 0 AND 100),
    error_log           TEXT,

    -- Kết quả
    minio_bucket        VARCHAR(64),
    minio_key           TEXT,
    file_size_bytes     BIGINT,
    file_sha256         CHAR(64),
    geoserver_store     VARCHAR(120),
    geoserver_layer     TEXT,

    -- Timing
    created_by          BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ
);

-- ── 2. Indexes tối ưu ────────────────────────────────────────────────────────
-- Worker chỉ scan 'pending' + 'downloading' (đang retry) → partial index
-- giữ index nhỏ (≤ vài chục row lúc peak) thay vì full-table B-tree.

CREATE INDEX IF NOT EXISTS idx_raster_ingest_worker_queue
    ON gis.raster_ingest_jobs (created_at)
    WHERE status IN ('pending','downloading','validating','uploading','publishing');

CREATE INDEX IF NOT EXISTS idx_raster_ingest_layer
    ON gis.raster_ingest_jobs (layer_id, created_at DESC)
    WHERE layer_id IS NOT NULL;

-- Dedupe: cùng source_hash + status không phải terminal → block duplicate submit.
-- Dùng partial UNIQUE thay vì UNIQUE(source_hash) để cho phép re-ingest sau khi
-- job trước đã completed/failed/cancelled.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_raster_ingest_active_source
    ON gis.raster_ingest_jobs (source_hash)
    WHERE status NOT IN ('completed','failed','cancelled');

-- Admin dashboard hay lọc theo (created_by, created_at) — cover cả 2.
CREATE INDEX IF NOT EXISTS idx_raster_ingest_created_by
    ON gis.raster_ingest_jobs (created_by, created_at DESC)
    WHERE created_by IS NOT NULL;

COMMENT ON TABLE  gis.raster_ingest_jobs               IS 'Job pipeline GEE → MinIO → GeoServer (đợt 1: gee_download_url)';
COMMENT ON COLUMN gis.raster_ingest_jobs.source_hash   IS 'SHA-256 của source_url — dedupe không lưu token';
COMMENT ON COLUMN gis.raster_ingest_jobs.file_sha256   IS 'SHA-256 của GeoTIFF cuối — content-addressable';
COMMENT ON COLUMN gis.raster_ingest_jobs.request_params IS 'JSONB: bbox, epsg_code, scale_m, gee_map_id, thumbnail_url…';

-- ── 3. Cột thêm cho layer_registry ───────────────────────────────────────────
-- Truy vấn ngược từ layer → job ingest gần nhất + metadata GEE gốc.

ALTER TABLE gis.layer_registry
    ADD COLUMN IF NOT EXISTS raster_ingest_job_id BIGINT
        REFERENCES gis.raster_ingest_jobs(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS raster_source_url  TEXT,
    ADD COLUMN IF NOT EXISTS raster_gee_metadata JSONB;

CREATE INDEX IF NOT EXISTS idx_layer_registry_raster_job
    ON gis.layer_registry (raster_ingest_job_id)
    WHERE raster_ingest_job_id IS NOT NULL;

-- ── 4. Trigger auto-update completed_at ──────────────────────────────────────
-- Set completed_at khi status chuyển sang terminal state (idempotent).

CREATE OR REPLACE FUNCTION gis.set_raster_ingest_completed_at()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IN ('completed','failed','cancelled')
       AND OLD.status IS DISTINCT FROM NEW.status
       AND NEW.completed_at IS NULL THEN
        NEW.completed_at := NOW();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_raster_ingest_completed_at ON gis.raster_ingest_jobs;
CREATE TRIGGER trg_raster_ingest_completed_at
    BEFORE UPDATE ON gis.raster_ingest_jobs
    FOR EACH ROW EXECUTE FUNCTION gis.set_raster_ingest_completed_at();

-- ── 5. RBAC — quyền map_layers.ingest_raster ─────────────────────────────────
-- Chỉ system_admin + so_nnmt được kích hoạt pipeline (đọc GEE quota).
--
-- ⚠️  KHÔNG dùng `permissions || '{"map_layers": {"ingest_raster": true}}'`
--     vì JSONB `||` merge chỉ ở TOP LEVEL — sẽ ghi đè toàn bộ object
--     `map_layers` hiện có, xóa mọi action đã cấp (create/read/update/publish…).
--     Dùng `jsonb_set` với inner `||` để chỉ thêm 1 key con.

UPDATE auth.roles
SET permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{map_layers}',
    COALESCE(permissions->'map_layers', '{}'::jsonb)
        || '{"ingest_raster": true}'::jsonb,
    true    -- create_missing = true → thêm key map_layers nếu chưa có
)
WHERE code IN ('system_admin', 'so_nnmt');
