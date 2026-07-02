-- ============================================================================
-- Migration 018: FIELD UPDATES (MobileGIS — Sở NN&MT đo đạc, cập nhật đối tượng)
-- Ghi lại mỗi lần kiểm lâm gửi 1 điểm GPS + thuộc tính để tạo/sửa 1 feature
-- trên lớp GIS (gis.layer_registry) từ app di động. Bảng bookkeeping — dữ liệu
-- không gian thật được ghi trực tiếp vào bảng vật lý của layer tương ứng và
-- audit trail nằm ở gis.layer_edit_history (đã có từ migration 008).
-- Idempotent: dùng IF NOT EXISTS.
-- ============================================================================

-- Schema `field` đã tồn tại từ migration 006 (field.feedback)

CREATE TABLE IF NOT EXISTS field.field_updates (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    layer_id        INT NOT NULL REFERENCES gis.layer_registry(id) ON DELETE CASCADE,
    feature_id      BIGINT,                              -- id của row trong bảng vật lý sau khi ghi

    action          VARCHAR(10) NOT NULL
                    CHECK (action IN ('insert', 'update')),
    attributes      JSONB NOT NULL DEFAULT '{}'::jsonb,   -- thuộc tính đã gửi (bookkeeping, tham chiếu)
    client_uuid     VARCHAR(80),                          -- chống gửi trùng khi offline
    note            TEXT,

    lng             DOUBLE PRECISION NOT NULL,
    lat             DOUBLE PRECISION NOT NULL,
    geom            GEOMETRY(Point, 4326),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_field_updates_lng CHECK (lng BETWEEN 106.0 AND 109.0),
    CONSTRAINT chk_field_updates_lat CHECK (lat BETWEEN 13.0 AND 16.5)
);

CREATE OR REPLACE FUNCTION field.set_field_update_geom()
RETURNS TRIGGER AS $$
BEGIN
    NEW.geom = ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_field_updates_geom ON field.field_updates;
CREATE TRIGGER trigger_field_updates_geom
    BEFORE INSERT OR UPDATE OF lng, lat ON field.field_updates
    FOR EACH ROW
    EXECUTE FUNCTION field.set_field_update_geom();

CREATE INDEX IF NOT EXISTS idx_field_updates_geom ON field.field_updates USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_field_updates_user_created ON field.field_updates (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_field_updates_layer_created ON field.field_updates (layer_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_field_updates_user_client_uuid
    ON field.field_updates (user_id, client_uuid)
    WHERE client_uuid IS NOT NULL;

-- Không cần seed RBAC mới — map_layers.feature_create/feature_read/feature_update
-- đã được cấp cho so_nnmt và system_admin từ migration 010_map_layer_crud_import.sql
