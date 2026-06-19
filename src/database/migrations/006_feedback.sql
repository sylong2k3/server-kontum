-- ============================================================================
-- Migration 006: FIELD FEEDBACK
-- Phản ánh hiện trường của người dân/cán bộ, hỗ trợ media + vị trí PostGIS.
-- Idempotent: dùng IF NOT EXISTS và cập nhật quyền bằng jsonb_set/||.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS field;

CREATE TABLE IF NOT EXISTS field.feedback (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    anonymous_id    VARCHAR(100),
    client_uuid     VARCHAR(80),

    category        VARCHAR(30) NOT NULL
                    CHECK (category IN ('chay_rung', 'vi_pham', 'hien_trang')),
    title           VARCHAR(255) NOT NULL,
    description     TEXT,
    status          VARCHAR(30) NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'in_progress', 'resolved', 'rejected')),
    priority        VARCHAR(20) NOT NULL DEFAULT 'normal'
                    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),

    media_urls      JSONB NOT NULL DEFAULT '[]'::jsonb,
    lng             DOUBLE PRECISION NOT NULL,
    lat             DOUBLE PRECISION NOT NULL,
    geom            GEOMETRY(Point, 4326),

    created_by      BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    updated_by      BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    resolved_at     TIMESTAMPTZ,
    deleted_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_feedback_owner CHECK (user_id IS NOT NULL OR anonymous_id IS NOT NULL),
    CONSTRAINT chk_feedback_lng CHECK (lng BETWEEN 106.0 AND 109.0),
    CONSTRAINT chk_feedback_lat CHECK (lat BETWEEN 13.0 AND 16.5)
);

CREATE OR REPLACE FUNCTION field.set_feedback_geom()
RETURNS TRIGGER AS $$
BEGIN
    NEW.geom = ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_feedback_geom ON field.feedback;
CREATE TRIGGER trigger_feedback_geom
    BEFORE INSERT OR UPDATE OF lng, lat ON field.feedback
    FOR EACH ROW
    EXECUTE FUNCTION field.set_feedback_geom();

DROP TRIGGER IF EXISTS trigger_feedback_updated_at ON field.feedback;
CREATE TRIGGER trigger_feedback_updated_at
    BEFORE UPDATE ON field.feedback
    FOR EACH ROW
    EXECUTE FUNCTION core.update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_feedback_geom ON field.feedback USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON field.feedback (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_feedback_category ON field.feedback (category) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON field.feedback (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON field.feedback (user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_feedback_anonymous_id ON field.feedback (anonymous_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_feedback_user_client_uuid
    ON field.feedback (user_id, client_uuid)
    WHERE user_id IS NOT NULL AND client_uuid IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_feedback_anon_client_uuid
    ON field.feedback (anonymous_id, client_uuid)
    WHERE anonymous_id IS NOT NULL AND client_uuid IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS field.feedback_status_log (
    id              BIGSERIAL PRIMARY KEY,
    feedback_id     BIGINT NOT NULL REFERENCES field.feedback(id) ON DELETE CASCADE,
    from_status     VARCHAR(30),
    to_status       VARCHAR(30) NOT NULL,
    note            TEXT,
    changed_by      BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_status_log_feedback_id
    ON field.feedback_status_log (feedback_id, changed_at DESC);

UPDATE auth.roles
SET permissions = permissions || '{"feedback":{"read":true,"create":true,"update":true,"delete":true,"read_own":true,"create_own":true,"update_status":true,"map":true}}'::jsonb
WHERE code = 'system_admin';

UPDATE auth.roles
SET permissions = permissions || '{"feedback":{"read":true,"update_status":true,"map":true}}'::jsonb
WHERE code = 'so_nnmt';

UPDATE auth.roles
SET permissions = permissions || '{"feedback":{"read":true,"map":true}}'::jsonb
WHERE code = 'ubnd_tinh';

UPDATE auth.roles
SET permissions = permissions || '{"feedback":{"create_own":true,"read_own":true}}'::jsonb
WHERE code = 'citizen';
