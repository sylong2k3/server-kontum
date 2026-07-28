-- Layer time-series: one GeoServer ImageMosaic per group, one row per raster time step.
CREATE TABLE IF NOT EXISTS gis.layer_series_groups (
    id SERIAL PRIMARY KEY,
    code VARCHAR(80) UNIQUE NOT NULL,
    name_vi VARCHAR(200) NOT NULL,
    name_en VARCHAR(200),
    geoserver_store VARCHAR(120) NOT NULL,
    geoserver_layer VARCHAR(255) NOT NULL,
    geoserver_style VARCHAR(160),
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_public BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_layer_series_group_code CHECK (code ~ '^[a-zA-Z_][a-zA-Z0-9_]*$'),
    CONSTRAINT chk_layer_series_store CHECK (geoserver_store ~ '^[a-zA-Z_][a-zA-Z0-9_]*$')
);

CREATE TABLE IF NOT EXISTS gis.layer_series_granules (
    id BIGSERIAL PRIMARY KEY,
    group_id INT NOT NULL REFERENCES gis.layer_series_groups(id) ON DELETE CASCADE,
    year_from INT NOT NULL,
    year_to INT NOT NULL,
    time_value DATE NOT NULL,
    label VARCHAR(120) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    source_layer VARCHAR(255),
    source_url TEXT,
    created_by BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_layer_series_years CHECK (year_from BETWEEN 1900 AND 2100 AND year_to BETWEEN year_from AND 2100),
    CONSTRAINT uq_layer_series_period UNIQUE (group_id, year_from, year_to),
    CONSTRAINT uq_layer_series_time UNIQUE (group_id, time_value),
    CONSTRAINT uq_layer_series_file UNIQUE (group_id, file_name)
);

CREATE INDEX IF NOT EXISTS idx_layer_series_granules_timeline ON gis.layer_series_granules (group_id, time_value, year_from, year_to);
CREATE INDEX IF NOT EXISTS idx_layer_series_groups_visibility ON gis.layer_series_groups (is_active, is_public, code);

DROP TRIGGER IF EXISTS trigger_layer_series_groups_updated_at ON gis.layer_series_groups;
CREATE TRIGGER trigger_layer_series_groups_updated_at BEFORE UPDATE ON gis.layer_series_groups FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();
DROP TRIGGER IF EXISTS trigger_layer_series_granules_updated_at ON gis.layer_series_granules;
CREATE TRIGGER trigger_layer_series_granules_updated_at BEFORE UPDATE ON gis.layer_series_granules FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();

INSERT INTO gis.layer_series_groups (code, name_vi, name_en, geoserver_store, geoserver_layer, geoserver_style) VALUES
    ('lop_phu', 'Lớp phủ', 'Land cover', 'lop_phu', 'kontum:lop_phu', NULL),
    ('nhiet_do_be_mat', 'Nhiệt độ bề mặt', 'Land surface temperature', 'nhiet_do_be_mat', 'kontum:nhiet_do_be_mat', NULL),
    ('bien_dong_lop_phu', 'Biến động lớp phủ', 'Land-cover change', 'bien_dong_lop_phu', 'kontum:bien_dong_lop_phu', NULL),
    ('dien_bien_nhiet_do', 'Diễn biến nhiệt độ', 'Temperature change', 'dien_bien_nhiet_do', 'kontum:dien_bien_nhiet_do', NULL)
ON CONFLICT (code) DO NOTHING;
