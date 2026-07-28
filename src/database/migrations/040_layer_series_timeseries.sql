-- ============================================================================
-- Migration 040: Time-series (ImageMosaic) support cho các nhóm layer nhiều năm
-- Nhóm: lop_phu, nhiet_do_be_mat (snapshot từng năm) và bien_dong_lop_phu,
--       dien_bien_nhiet_do (so sánh cặp giai đoạn) — mỗi nhóm publish thành
--       DUY NHẤT 1 layer GeoServer kiểu ImageMosaic có time dimension, thay vì
--       mỗi năm/giai đoạn là 1 layer rời rạc.
-- ============================================================================

ALTER TABLE gis.layer_registry
    DROP CONSTRAINT IF EXISTS chk_layer_registry_layer_kind;

ALTER TABLE gis.layer_registry
    ADD CONSTRAINT chk_layer_registry_layer_kind
        CHECK (layer_kind IN ('basemap', 'overlay', 'timeseries'));

ALTER TABLE gis.layer_registry
    ADD COLUMN IF NOT EXISTS mosaic_path VARCHAR(500);

CREATE TABLE IF NOT EXISTS gis.layer_series_granule (
    id              BIGSERIAL PRIMARY KEY,
    layer_id        INT NOT NULL REFERENCES gis.layer_registry(id) ON DELETE CASCADE,
    year_from       INT NOT NULL CHECK (year_from BETWEEN 1900 AND 2100),
    year_to         INT NOT NULL CHECK (year_to BETWEEN 1900 AND 2100),
    time_value      DATE NOT NULL,
    label_vi        VARCHAR(60) NOT NULL,
    label_en        VARCHAR(60),
    file_path       VARCHAR(500),
    file_sha256     VARCHAR(64),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    ingested_by     BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_layer_series_granule_years CHECK (year_to >= year_from),
    CONSTRAINT uniq_layer_series_granule_years UNIQUE (layer_id, year_from, year_to),
    CONSTRAINT uniq_layer_series_granule_time UNIQUE (layer_id, time_value)
);

CREATE INDEX IF NOT EXISTS idx_layer_series_granule_layer_time ON gis.layer_series_granule (layer_id, time_value);

DROP TRIGGER IF EXISTS trigger_layer_series_granule_updated_at ON gis.layer_series_granule;
CREATE TRIGGER trigger_layer_series_granule_updated_at BEFORE UPDATE ON gis.layer_series_granule FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();

-- Seed 4 row "đầu nhóm" trong layer_registry — mỗi row tương ứng 1 CoverageStore
-- ImageMosaic sẽ được publish qua GeoServer (geoserver_layer sẽ được set sau khi
-- ensureMosaic() chạy lần ingest granule đầu tiên).
INSERT INTO gis.layer_registry (
    code, name_vi, name_en, schema_name, table_name, geometry_column, geometry_type,
    epsg_code, category, layer_kind, layer_group, is_active, is_public, is_editable, sort_order
) VALUES
    ('lop_phu', 'Lớp phủ', 'Land cover', 'gis', 'lop_phu', 'geom', 'RASTER', 4326, 'remote_sensing', 'timeseries', 'lop_phu', true, true, false, 10),
    ('nhiet_do_be_mat', 'Nhiệt độ bề mặt', 'Surface temperature', 'gis', 'nhiet_do_be_mat', 'geom', 'RASTER', 4326, 'remote_sensing', 'timeseries', 'nhiet_do_be_mat', true, true, false, 20),
    ('bien_dong_lop_phu', 'Biến động lớp phủ', 'Land cover change', 'gis', 'bien_dong_lop_phu', 'geom', 'RASTER', 4326, 'remote_sensing', 'timeseries', 'bien_dong_lop_phu', true, true, false, 30),
    ('dien_bien_nhiet_do', 'Diễn biến nhiệt độ', 'Temperature change', 'gis', 'dien_bien_nhiet_do', 'geom', 'RASTER', 4326, 'remote_sensing', 'timeseries', 'dien_bien_nhiet_do', true, true, false, 40)
ON CONFLICT (code) DO NOTHING;
