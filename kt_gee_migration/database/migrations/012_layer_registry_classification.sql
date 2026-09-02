-- ============================================================================
-- Migration 012: Layer registry classification metadata
-- Purpose: distinguish background/base data, thematic overlays, time-series layers,
--          and preserve original FileGDB source names after bulk imports.
-- ============================================================================

ALTER TABLE gis.layer_registry
    ADD COLUMN IF NOT EXISTS layer_kind VARCHAR(20) NOT NULL DEFAULT 'overlay',
    ADD COLUMN IF NOT EXISTS layer_group VARCHAR(80),
    ADD COLUMN IF NOT EXISTS data_year INT,
    ADD COLUMN IF NOT EXISTS source_dataset VARCHAR(120),
    ADD COLUMN IF NOT EXISTS source_layer_name VARCHAR(160);

ALTER TABLE gis.layer_registry
    DROP CONSTRAINT IF EXISTS chk_layer_registry_layer_kind,
    DROP CONSTRAINT IF EXISTS chk_layer_registry_data_year;

ALTER TABLE gis.layer_registry
    ADD CONSTRAINT chk_layer_registry_layer_kind
        CHECK (layer_kind IN ('basemap', 'overlay')),
    ADD CONSTRAINT chk_layer_registry_data_year
        CHECK (data_year IS NULL OR data_year BETWEEN 1900 AND 2100);

CREATE INDEX IF NOT EXISTS idx_layer_registry_layer_kind ON gis.layer_registry (layer_kind, sort_order);
CREATE INDEX IF NOT EXISTS idx_layer_registry_layer_group ON gis.layer_registry (layer_group, sort_order);
CREATE INDEX IF NOT EXISTS idx_layer_registry_data_year ON gis.layer_registry (data_year) WHERE data_year IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_layer_registry_source_dataset ON gis.layer_registry (source_dataset) WHERE source_dataset IS NOT NULL;

-- Allow recording FileGDB import jobs even when the actual conversion is performed
-- by QGIS/GDAL before registering the resulting PostGIS table.
ALTER TABLE gis.layer_import_jobs
    DROP CONSTRAINT IF EXISTS layer_import_jobs_source_format_check;

ALTER TABLE gis.layer_import_jobs
    ADD CONSTRAINT layer_import_jobs_source_format_check
        CHECK (source_format IN ('shapefile','geojson','csv','kml','wfs','postgis_dump','geotiff','filegdb'));

-- Best-effort classification for existing registered layers. Manual updates can
-- override these values later for exact UI grouping.
UPDATE gis.layer_registry
SET
    layer_kind = CASE
        WHEN lower(COALESCE(category, '') || ' ' || code || ' ' || table_name) ~ '(basemap|background|du[_ ]?lieu[_ ]?nen|dulieunen|nen)' THEN 'basemap'
        ELSE COALESCE(NULLIF(layer_kind, ''), 'overlay')
    END,
    layer_group = COALESCE(
        layer_group,
        CASE
            WHEN lower(COALESCE(category, '') || ' ' || code || ' ' || table_name) ~ '(bien[_ ]?dong|biendong)' THEN 'bien_dong_lop_phu'
            WHEN lower(COALESCE(category, '') || ' ' || code || ' ' || table_name) ~ '(nhiet[_ ]?do|nhietdo|temperature)' THEN 'nhiet_do_be_mat'
            WHEN lower(COALESCE(category, '') || ' ' || code || ' ' || table_name) ~ '(lop[_ ]?phu|lopphu|landcover)' THEN 'lop_phu'
            WHEN lower(COALESCE(category, '') || ' ' || code || ' ' || table_name) ~ '(basemap|background|du[_ ]?lieu[_ ]?nen|dulieunen|nen)' THEN 'du_lieu_nen'
            ELSE category
        END
    ),
    data_year = COALESCE(
        data_year,
        NULLIF(substring(COALESCE(code, '') || '_' || COALESCE(table_name, '') from '(19[0-9]{2}|20[0-9]{2})'), '')::INT
    ),
    source_layer_name = COALESCE(source_layer_name, table_name),
    source_dataset = COALESCE(source_dataset, 'postgis'),
    updated_at = NOW();
