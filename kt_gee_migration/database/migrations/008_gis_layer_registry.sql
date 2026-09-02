-- ============================================================================
-- Migration 008: GIS Layer Registry — GeoServer/PostGIS integration foundation
-- Schema: gis
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS gis;

CREATE TABLE IF NOT EXISTS gis.layer_registry (
    id                  SERIAL PRIMARY KEY,
    code                VARCHAR(60) UNIQUE NOT NULL,
    name_vi             VARCHAR(200) NOT NULL,
    name_en             VARCHAR(200),
    description_vi      TEXT,
    description_en      TEXT,
    schema_name         VARCHAR(60) NOT NULL DEFAULT 'gis',
    table_name          VARCHAR(120) NOT NULL,
    geometry_type       VARCHAR(30) NOT NULL
                        CHECK (geometry_type IN ('POINT','MULTIPOINT','LINESTRING','MULTILINESTRING','POLYGON','MULTIPOLYGON','GEOMETRY','RASTER')),
    epsg_code           INT NOT NULL DEFAULT 4326,
    geoserver_layer     VARCHAR(255),
    geoserver_store     VARCHAR(120),
    default_style       JSONB NOT NULL DEFAULT '{}',
    min_zoom            INT NOT NULL DEFAULT 1,
    max_zoom            INT NOT NULL DEFAULT 22,
    label_field         VARCHAR(60),
    category            VARCHAR(60),
    sort_order          INT NOT NULL DEFAULT 0,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    is_public           BOOLEAN NOT NULL DEFAULT false,
    is_editable         BOOLEAN NOT NULL DEFAULT true,
    layer_permissions   JSONB NOT NULL DEFAULT '{}',
    feature_count       BIGINT DEFAULT 0,
    last_updated_at     TIMESTAMPTZ,
    bbox                GEOMETRY(POLYGON, 4326),
    created_by          BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    updated_by          BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_layer_registry_zoom_range CHECK (min_zoom BETWEEN 0 AND 24 AND max_zoom BETWEEN 0 AND 24 AND min_zoom <= max_zoom),
    CONSTRAINT chk_layer_registry_identifiers CHECK (schema_name ~ '^[a-zA-Z_][a-zA-Z0-9_]*$' AND table_name ~ '^[a-zA-Z_][a-zA-Z0-9_]*$' AND code ~ '^[a-zA-Z0-9_-]+$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_layer_registry_physical_table ON gis.layer_registry (schema_name, table_name);
CREATE INDEX IF NOT EXISTS idx_layer_registry_code ON gis.layer_registry (code);
CREATE INDEX IF NOT EXISTS idx_layer_registry_active_public ON gis.layer_registry (is_active, is_public, sort_order);
CREATE INDEX IF NOT EXISTS idx_layer_registry_category ON gis.layer_registry (category, sort_order);
CREATE INDEX IF NOT EXISTS idx_layer_registry_geoserver_layer ON gis.layer_registry (geoserver_layer) WHERE geoserver_layer IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_layer_registry_bbox_gist ON gis.layer_registry USING GIST (bbox) WHERE bbox IS NOT NULL;

DROP TRIGGER IF EXISTS trigger_layer_registry_updated_at ON gis.layer_registry;
CREATE TRIGGER trigger_layer_registry_updated_at BEFORE UPDATE ON gis.layer_registry FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();

CREATE TABLE IF NOT EXISTS gis.layer_import_jobs (
    id                  BIGSERIAL PRIMARY KEY,
    layer_id            INT NOT NULL REFERENCES gis.layer_registry(id) ON DELETE CASCADE,
    source_format       VARCHAR(30) NOT NULL CHECK (source_format IN ('shapefile','geojson','csv','kml','wfs','postgis_dump','geotiff')),
    source_info         JSONB NOT NULL DEFAULT '{}',
    import_mode         VARCHAR(20) NOT NULL DEFAULT 'append' CHECK (import_mode IN ('append','overwrite','upsert')),
    srid_input          INT DEFAULT 4326,
    encoding            VARCHAR(20) DEFAULT 'UTF-8',
    strategy            VARCHAR(20) NOT NULL DEFAULT 'best_effort' CHECK (strategy IN ('best_effort', 'all_or_nothing')),
    status              VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed','cancelled')),
    progress            NUMERIC(5,2) DEFAULT 0,
    total_features      INT,
    imported_count      INT,
    failed_count        INT,
    error_log           TEXT,
    result_summary      JSONB DEFAULT '{}',
    created_by          BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_layer_import_jobs_layer_id ON gis.layer_import_jobs (layer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_layer_import_jobs_status ON gis.layer_import_jobs (status, created_at DESC);

CREATE TABLE IF NOT EXISTS gis.layer_edit_history (
    id                  BIGSERIAL PRIMARY KEY,
    layer_id            INT NOT NULL REFERENCES gis.layer_registry(id) ON DELETE CASCADE,
    operation_id        UUID NOT NULL DEFAULT gen_random_uuid(),
    source              VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','api','system')),
    import_job_id       BIGINT REFERENCES gis.layer_import_jobs(id) ON DELETE SET NULL,
    feature_id          BIGINT,
    action              VARCHAR(20) NOT NULL CHECK (action IN ('create','update','delete','bulk_import','publish','unpublish','toggle_active')),
    old_data            JSONB,
    new_data            JSONB,
    geometry_changed    BOOLEAN DEFAULT false,
    old_bbox            GEOMETRY(POLYGON, 4326),
    new_bbox            GEOMETRY(POLYGON, 4326),
    changed_by          BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    changed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_layer_edit_history_layer_id ON gis.layer_edit_history (layer_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_layer_edit_history_operation_id ON gis.layer_edit_history (operation_id);
CREATE INDEX IF NOT EXISTS idx_layer_edit_history_import_job_id ON gis.layer_edit_history (import_job_id) WHERE import_job_id IS NOT NULL;
