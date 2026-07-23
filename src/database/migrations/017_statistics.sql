-- ============================================================================
-- Migration 017: THỐNG KÊ & PHÂN TÍCH KHÔNG GIAN (EP-07)
--
-- Cung cấp nền dữ liệu cho:
--   - US-060: Diện tích lớp phủ / che phủ rừng theo huyện + mốc thời gian
--   - US-063: Dashboard điều hành (tổng hợp + cache)
--   - Dữ liệu chuỗi thời gian phục vụ thống kê lịch sử
--   - US-062: Khoảng cách dân cư – rừng (ST_DWithin trên lớp GIS đã import)
--
-- Dữ liệu seed là SỐ LIỆU THỰC tỉnh Kon Tum:
--   - Đơn vị hành chính: diện tích (km²) + dân số (Niên giám / Wikipedia)
--   - Che phủ rừng 2024: công bố của tỉnh (kontum.gov.vn, 31/12/2024)
--   - Tổng hợp rừng 2023/2024: hiện trạng rừng toàn quốc (Bộ NN&PTNT)
--
-- Idempotent: IF NOT EXISTS + ON CONFLICT DO UPDATE.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS gis;

-- ── 1. Đơn vị hành chính cấp huyện ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gis.administrative_units (
    code            VARCHAR(10) PRIMARY KEY,          -- mã GSO cấp huyện
    name_vi         VARCHAR(120) NOT NULL,
    name_en         VARCHAR(120),
    level           VARCHAR(20)  NOT NULL DEFAULT 'district'
                    CHECK (level IN ('province', 'district', 'commune')),
    parent_code     VARCHAR(10),                      -- mã đơn vị cha (tỉnh)
    area_km2        NUMERIC(12, 2),
    population      INTEGER,
    centroid_lng    DOUBLE PRECISION,
    centroid_lat    DOUBLE PRECISION,
    -- Ranh giới thực: nạp sau qua import shapefile (NULL cho tới khi có).
    geom            GEOMETRY(MULTIPOLYGON, 4326),
    sort_order      INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_units_parent ON gis.administrative_units (parent_code);
CREATE INDEX IF NOT EXISTS idx_admin_units_level  ON gis.administrative_units (level, sort_order);
CREATE INDEX IF NOT EXISTS idx_admin_units_geom   ON gis.administrative_units USING GIST (geom) WHERE geom IS NOT NULL;

-- ── 2. Thống kê lớp phủ / che phủ rừng theo huyện + năm ───────────────────────
CREATE TABLE IF NOT EXISTS gis.landcover_statistics (
    id              BIGSERIAL PRIMARY KEY,
    unit_code       VARCHAR(10) NOT NULL REFERENCES gis.administrative_units(code) ON DELETE CASCADE,
    period_year     INT NOT NULL,
    forest_type     VARCHAR(30) NOT NULL DEFAULT 'total'
                    CHECK (forest_type IN ('total', 'natural', 'planted', 'non_forest')),
    area_ha         NUMERIC(14, 2) NOT NULL DEFAULT 0,
    coverage_pct    NUMERIC(6, 2),                    -- tỷ lệ che phủ (%) — chỉ với forest_type='total'
    source          VARCHAR(120) NOT NULL DEFAULT 'kontum.gov.vn',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uniq_landcover_unit_year_type UNIQUE (unit_code, period_year, forest_type)
);

CREATE INDEX IF NOT EXISTS idx_landcover_unit_year ON gis.landcover_statistics (unit_code, period_year);
CREATE INDEX IF NOT EXISTS idx_landcover_year_type ON gis.landcover_statistics (period_year, forest_type);

-- ── 3. Cache kết quả dashboard ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gis.stats_cache (
    cache_key   VARCHAR(200) PRIMARY KEY,
    payload     JSONB        NOT NULL,
    computed_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stats_cache_expires ON gis.stats_cache (expires_at);

-- ============================================================================
-- SEED — Đơn vị hành chính tỉnh Kon Tum (10 huyện/thành phố + tỉnh)
-- Diện tích (km²) & dân số: Wikipedia/Niên giám thống kê.
-- ============================================================================
INSERT INTO gis.administrative_units (code, name_vi, name_en, level, parent_code, area_km2, population, sort_order) VALUES
    ('62',  'Tỉnh Kon Tum',         'Kon Tum Province',  'province', NULL, 9677.30, 591217, 0),
    ('608', 'Thành phố Kon Tum',    'Kon Tum City',      'district', '62',  433.00, 168264, 1),
    ('610', 'Huyện Đăk Glei',       'Dak Glei',          'district', '62', 1495.00,  48761, 2),
    ('611', 'Huyện Ngọc Hồi',       'Ngoc Hoi',          'district', '62',  824.00,  58913, 3),
    ('612', 'Huyện Đăk Tô',         'Dak To',            'district', '62',  511.00,  47544, 4),
    ('613', 'Huyện Kon Plông',      'Kon Plong',         'district', '62', 1371.00,  26025, 5),
    ('614', 'Huyện Kon Rẫy',        'Kon Ray',           'district', '62',  886.00,  28591, 6),
    ('615', 'Huyện Đăk Hà',         'Dak Ha',            'district', '62',  845.00,  74805, 7),
    ('616', 'Huyện Sa Thầy',        'Sa Thay',           'district', '62', 1435.00,  49914, 8),
    ('617', 'Huyện Tu Mơ Rông',     'Tu Mo Rong',        'district', '62',  857.00,  27411, 9),
    ('618', 'Huyện Ia H''Drai',     'Ia H''Drai',        'district', '62',  980.00,  10210, 10)
ON CONFLICT (code) DO UPDATE SET
    name_vi = EXCLUDED.name_vi, name_en = EXCLUDED.name_en,
    area_km2 = EXCLUDED.area_km2, population = EXCLUDED.population,
    sort_order = EXCLUDED.sort_order, updated_at = NOW();

-- ============================================================================
-- SEED — Che phủ rừng theo huyện năm 2024 (công bố tỉnh, 31/12/2024)
-- coverage_pct: số liệu công bố; area_ha = area_km2 × 100 × pct/100 (xấp xỉ).
-- ============================================================================
INSERT INTO gis.landcover_statistics (unit_code, period_year, forest_type, area_ha, coverage_pct, source) VALUES
    ('608', 2024, 'total',   2992.03,  6.91, 'kontum.gov.vn 2024'),
    ('610', 2024, 'total', 108716.40, 72.72, 'kontum.gov.vn 2024'),
    ('611', 2024, 'total',  38785.68, 47.07, 'kontum.gov.vn 2024'),
    ('612', 2024, 'total',  18462.43, 36.13, 'kontum.gov.vn 2024'),
    ('613', 2024, 'total', 113285.73, 82.63, 'kontum.gov.vn 2024'),
    ('614', 2024, 'total',  58608.90, 66.15, 'kontum.gov.vn 2024'),
    ('615', 2024, 'total',  38532.00, 45.60, 'kontum.gov.vn 2024'),
    ('616', 2024, 'total',  91194.25, 63.55, 'kontum.gov.vn 2024'),
    ('617', 2024, 'total',  58044.61, 67.73, 'kontum.gov.vn 2024'),
    ('618', 2024, 'total',  85348.20, 87.09, 'kontum.gov.vn 2024')
ON CONFLICT (unit_code, period_year, forest_type) DO UPDATE SET
    area_ha = EXCLUDED.area_ha, coverage_pct = EXCLUDED.coverage_pct, source = EXCLUDED.source;

-- ============================================================================
-- SEED — Tổng hợp toàn tỉnh 2023 & 2024 (hiện trạng rừng toàn quốc, Bộ NN&PTNT)
-- 2023: rừng 616.123,37 ha (tự nhiên 552.287,28 + trồng 63.836,09), che phủ 63,69%
-- 2024: rừng 616.195,94 ha (tự nhiên 552.350,72 + trồng 63.845,22), che phủ 63,69%
-- ============================================================================
INSERT INTO gis.landcover_statistics (unit_code, period_year, forest_type, area_ha, coverage_pct, source) VALUES
    ('62', 2023, 'total',   616123.37, 63.69, 'Bộ NN&PTNT 2023'),
    ('62', 2023, 'natural', 552287.28, NULL,  'Bộ NN&PTNT 2023'),
    ('62', 2023, 'planted',  63836.09, NULL,  'Bộ NN&PTNT 2023'),
    ('62', 2024, 'total',   616195.94, 63.69, 'Bộ NN&PTNT 2024'),
    ('62', 2024, 'natural', 552350.72, NULL,  'Bộ NN&PTNT 2024'),
    ('62', 2024, 'planted',  63845.22, NULL,  'Bộ NN&PTNT 2024')
ON CONFLICT (unit_code, period_year, forest_type) DO UPDATE SET
    area_ha = EXCLUDED.area_ha, coverage_pct = EXCLUDED.coverage_pct, source = EXCLUDED.source;

-- ============================================================================
-- RBAC — quyền cho thống kê (statistics) và phân tích không gian (spatial)
-- ============================================================================
UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb)
    || '{"statistics":{"read":true,"dashboard":true},"spatial":{"read":true,"analyze":true}}'::jsonb
WHERE code = 'system_admin';

UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb)
    || '{"statistics":{"read":true,"dashboard":true},"spatial":{"read":true}}'::jsonb
WHERE code = 'ubnd_tinh';

UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb)
    || '{"statistics":{"read":true},"spatial":{"read":true,"analyze":true}}'::jsonb
WHERE code = 'so_nnmt';

UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb)
    || '{"statistics":{"read":true}}'::jsonb
WHERE code = 'citizen';
