-- ============================================================================
-- Migration 015: WEATHER (EP-05 — Thời tiết thời gian gần thực)
--
-- Cache dữ liệu thời tiết theo giờ để giảm số lần gọi API ngoài
-- (OpenWeather có hạn ngạch). Lưu cả thời điểm quan trắc (observed_at) để
-- frontend biết độ mới, và expires_at để service quyết định refresh.
--
-- Nguồn dữ liệu:
--   - point      : OpenWeather Current Weather (popup tại điểm)
--   - wind_grid  : Open-Meteo grid (lưới gió cho animation streamlines)
--
-- Idempotent: dùng IF NOT EXISTS và || để merge quyền JSONB.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS gis;

CREATE TABLE IF NOT EXISTS gis.weather_cache (
    id          BIGSERIAL PRIMARY KEY,
    cache_key   VARCHAR(200)     NOT NULL,
    data_type   VARCHAR(30)      NOT NULL
                CHECK (data_type IN ('point', 'wind_grid', 'forecast')),

    lng         DOUBLE PRECISION,
    lat         DOUBLE PRECISION,
    bbox        JSONB,
    payload     JSONB            NOT NULL,

    source      VARCHAR(40)      NOT NULL DEFAULT 'openweather',
    observed_at TIMESTAMPTZ,
    fetched_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ      NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_weather_cache_key
    ON gis.weather_cache (cache_key);
CREATE INDEX IF NOT EXISTS idx_weather_cache_expires
    ON gis.weather_cache (expires_at);
CREATE INDEX IF NOT EXISTS idx_weather_cache_type
    ON gis.weather_cache (data_type);

-- ── RBAC ────────────────────────────────────────────────────────────────────
-- Đọc thời tiết là dữ liệu công khai (route dùng optionalAuth, không gate quyền).
-- Quyền "manage" dành cho việc làm nóng cache thủ công (POST /weather/refresh).
UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb) || '{"weather":{"read":true,"manage":true}}'::jsonb
WHERE code = 'system_admin';

UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb) || '{"weather":{"read":true,"manage":true}}'::jsonb
WHERE code = 'so_nnmt';

UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb) || '{"weather":{"read":true}}'::jsonb
WHERE code = 'ubnd_tinh';

UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb) || '{"weather":{"read":true}}'::jsonb
WHERE code = 'citizen';
