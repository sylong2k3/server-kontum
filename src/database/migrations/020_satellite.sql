-- ============================================================
-- Migration 020 — Satellite imagery cache + Forest classification
-- ============================================================
-- Schemas:
--   satellite.*  — on-demand image tile cache (RGB/NDVI/heatmap/classified/compare)
--   forest.*     — monthly forest classification snapshots + district area stats
-- ============================================================

-- ── Schema creation ───────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS satellite;
CREATE SCHEMA IF NOT EXISTS forest;

-- ── satellite.image_results ───────────────────────────────────────────────────
-- Caches GEE tile URLs for on-demand requests (keyed by content hash).
-- TTL: entries expire after `expires_at`; cron cleans up old rows.

CREATE TABLE IF NOT EXISTS satellite.image_results (
    id              BIGSERIAL PRIMARY KEY,
    request_hash    VARCHAR(64)  NOT NULL,          -- SHA-256 of normalized request params
    image_type      VARCHAR(32)  NOT NULL,          -- 'rgb' | 'ndvi' | 'heatmap' | 'classified' | 'compare'
    collection      VARCHAR(32),                    -- 'S2' | 'LANDSAT' | null = auto
    start_date      DATE         NOT NULL,
    end_date        DATE         NOT NULL,
    start_date2     DATE,                           -- for compare only
    end_date2       DATE,
    bbox            JSONB,                          -- [minX, minY, maxX, maxY]
    geometry        JSONB,                          -- original GeoJSON geometry
    tile_url        TEXT         NOT NULL,          -- GEE tile URL template with {z}/{x}/{y}
    map_id          VARCHAR(256),                   -- GEE mapid
    stats           JSONB,                          -- area stats / NDVI stats etc.
    legend          JSONB,                          -- palette + labels
    metadata        JSONB,                          -- cloud cover, image count, etc.
    -- GeoServer publish tracking
    status          VARCHAR(32)  NOT NULL DEFAULT 'ready',
        -- ready | exporting | published | failed
    gee_task_id     TEXT,                           -- GEE export task name (async publish)
    minio_key       TEXT,                           -- path in MinIO after download
    geoserver_layer TEXT,                           -- workspace:storeName once published
    geoserver_store TEXT,
    publish_error   TEXT,
    expires_at      TIMESTAMPTZ  NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT satellite_image_results_hash_type_uq UNIQUE (request_hash)
);

CREATE INDEX IF NOT EXISTS idx_sat_results_type    ON satellite.image_results (image_type);
CREATE INDEX IF NOT EXISTS idx_sat_results_expires ON satellite.image_results (expires_at);
CREATE INDEX IF NOT EXISTS idx_sat_results_status  ON satellite.image_results (status);

-- ── forest.forest_snapshots ───────────────────────────────────────────────────
-- One row per year-month classification run.

CREATE TABLE IF NOT EXISTS forest.forest_snapshots (
    id              BIGSERIAL PRIMARY KEY,
    year            SMALLINT     NOT NULL,
    month           SMALLINT     NOT NULL,           -- 1-12, month of analysis end
    status          VARCHAR(32)  NOT NULL DEFAULT 'pending',
        -- pending | computing | completed | failed | exporting | published
    model_params    JSONB        NOT NULL DEFAULT '{}',
    province_summary JSONB,                          -- total area by class at province level
    oob_accuracy    NUMERIC(5,2),                    -- OOB accuracy % from RF
    s2_image_count  INTEGER,                         -- # S2 images used
    ls_image_count  INTEGER,                         -- # Landsat images used
    gee_task_id     TEXT,                            -- GEE export task name
    minio_key       TEXT,                            -- path in MinIO after download
    geoserver_layer TEXT,
    geoserver_store TEXT,
    error_message   TEXT,
    computed_at     TIMESTAMPTZ,
    published_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT forest_snapshots_year_month_uq UNIQUE (year, month)
);

CREATE INDEX IF NOT EXISTS idx_fc_snapshots_status ON forest.forest_snapshots (status);
CREATE INDEX IF NOT EXISTS idx_fc_snapshots_ym     ON forest.forest_snapshots (year DESC, month DESC);

-- ── forest.forest_district_areas ─────────────────────────────────────────────
-- Per-district area (ha) by class for each snapshot.

CREATE TABLE IF NOT EXISTS forest.forest_district_areas (
    id              BIGSERIAL PRIMARY KEY,
    snapshot_id     BIGINT       NOT NULL REFERENCES forest.forest_snapshots(id) ON DELETE CASCADE,
    district_code   VARCHAR(32),
    district_name   VARCHAR(128),
    class_id        SMALLINT     NOT NULL,           -- 0-10
    class_name      VARCHAR(64)  NOT NULL,
    area_ha         NUMERIC(12,2) NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fc_district_areas_snap ON forest.forest_district_areas (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_fc_district_areas_dist ON forest.forest_district_areas (district_code, class_id);

-- ── updated_at trigger ────────────────────────────────────────────────────────

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_forest_snapshots_updated_at'
    ) THEN
        CREATE TRIGGER trg_forest_snapshots_updated_at
            BEFORE UPDATE ON forest.forest_snapshots
            FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();
    END IF;
END;
$$;

-- ── RBAC — satellite permissions ─────────────────────────────────────────────

DO $$
DECLARE
    v_perm_id  INTEGER;
    v_role_id  INTEGER;
BEGIN
    INSERT INTO core.permissions (module, action, description)
    VALUES ('satellite', 'manage', 'Xuất bản ảnh vệ tinh lên GeoServer')
    ON CONFLICT (module, action) DO NOTHING;

    SELECT id INTO v_perm_id
    FROM core.permissions
    WHERE module = 'satellite' AND action = 'manage';

    FOR v_role_id IN
        SELECT id FROM core.roles WHERE name IN ('system_admin', 'so_nnmt', 'ubnd_tinh')
    LOOP
        INSERT INTO core.role_permissions (role_id, permission_id)
        VALUES (v_role_id, v_perm_id)
        ON CONFLICT DO NOTHING;
    END LOOP;
END;
$$;

-- ── RBAC — forest classification permissions ──────────────────────────────────

DO $$
DECLARE
    v_perm_id  INTEGER;
    v_role_id  INTEGER;
BEGIN
    INSERT INTO core.permissions (module, action, description)
    VALUES ('forest_classification', 'manage', 'Quản lý phân loại lớp phủ rừng')
    ON CONFLICT (module, action) DO NOTHING;

    SELECT id INTO v_perm_id
    FROM core.permissions
    WHERE module = 'forest_classification' AND action = 'manage';

    FOR v_role_id IN
        SELECT id FROM core.roles WHERE name IN ('system_admin', 'so_nnmt', 'ubnd_tinh')
    LOOP
        INSERT INTO core.role_permissions (role_id, permission_id)
        VALUES (v_role_id, v_perm_id)
        ON CONFLICT DO NOTHING;
    END LOOP;
END;
$$;
