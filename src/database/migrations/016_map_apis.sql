-- ============================================================================
-- Migration 016: MAP DATA SHARING API (US-025)
--
-- Cho phép system_admin cấp api_key cho bên thứ ba để khai thác dữ liệu một
-- lớp GIS (GeoJSON features) qua API có kiểm soát: scope + rate-limit + hết hạn.
--
-- Quy tắc (doc 14 §C):
--   - api_key ngẫu nhiên ~64 ký tự, CHỈ lưu dạng hash (sha256).
--   - key_prefix lưu kèm để tra cứu nhanh trước khi so hash.
--   - request gửi header X-Map-Api-Key; chỉ cho phép GET feature.
--
-- Idempotent: IF NOT EXISTS + || cho quyền JSONB.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS gis;

CREATE TABLE IF NOT EXISTS gis.map_apis (
    id            BIGSERIAL PRIMARY KEY,
    name          VARCHAR(150) NOT NULL,
    layer_id      INT NOT NULL REFERENCES gis.layer_registry(id) ON DELETE CASCADE,

    key_prefix    VARCHAR(20)  NOT NULL,           -- tra cứu nhanh (12 ký tự đầu)
    key_hash      VARCHAR(128) NOT NULL,           -- sha256 hex của full key
    key_last4     VARCHAR(8),                      -- hiển thị nhận diện

    -- scope: { "read": true, "rate_per_min": 60, "bbox_limit": <sq.deg> }
    scope         JSONB        NOT NULL DEFAULT '{"read":true,"rate_per_min":60}'::jsonb,

    is_active     BOOLEAN      NOT NULL DEFAULT true,
    expires_at    TIMESTAMPTZ,
    last_used_at  TIMESTAMPTZ,
    request_count BIGINT       NOT NULL DEFAULT 0,

    created_by    BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_map_apis_key_prefix ON gis.map_apis (key_prefix);
CREATE INDEX IF NOT EXISTS idx_map_apis_layer_id   ON gis.map_apis (layer_id);
CREATE INDEX IF NOT EXISTS idx_map_apis_active      ON gis.map_apis (is_active);

DROP TRIGGER IF EXISTS trigger_map_apis_updated_at ON gis.map_apis;
CREATE TRIGGER trigger_map_apis_updated_at
    BEFORE UPDATE ON gis.map_apis
    FOR EACH ROW
    EXECUTE FUNCTION core.update_updated_at_column();

-- ── RBAC ────────────────────────────────────────────────────────────────────
-- Chỉ system_admin quản lý api_key (doc 14 §C). Các role khác không có quyền.
UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb) ||
    '{"map_apis":{"create":true,"read":true,"update":true,"delete":true}}'::jsonb
WHERE code = 'system_admin';
