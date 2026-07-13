-- ============================================================================
-- Migration 028: ĐO ĐẠC THỰC ĐỊA — GHI NHẬN BIẾN ĐỔI KHU VỰC (Sở NN&MT)
--
-- Thiết kế đầy đủ: docs/modules/17-change-tracking-design.md
--
-- Cán bộ Sở NN&MT ra hiện trường, bật định vị GPS, đi men ranh giới khu vực
-- biến đổi để ghi điểm → khép polygon → server tính diện tích + giao cắt với
-- lớp dữ liệu hiện có (gis.layer_registry) để auto-fill loại đất hiện trạng.
-- Nhiều lần đo cùng một chỗ được gom vào 1 "khu vực theo dõi" (monitored_areas)
-- để xem diễn tiến theo thời gian. Phiên đo đi qua 1 bước xác thực nhẹ:
--   draft -> submitted -> verified | rejected
-- Đây là hồ sơ ghi nhận/báo cáo, KHÔNG sửa dữ liệu lớp bản đồ, KHÔNG làm
-- versioning bảng vật lý (khác phạm vi với gis.layer_edit_history).
--
-- Lưu ý: migration 027 đã DROP bảng field.field_updates (mobile, phạm vi khác,
-- đã gỡ khỏi repo). Migration này độc lập, dùng schema gis.
-- ============================================================================

-- ── 1. gis.monitored_areas ───────────────────────────────────────────────────
-- Khu vực theo dõi: gom nhiều phiên đo của cùng một chỗ qua các mốc thời gian
-- để nhìn ra diễn tiến biến đổi (vd. rừng thu hẹp dần qua 3 lần đo trong 1 năm).
-- ref_geom mặc định = ranh giới lần đo đầu tiên, dùng cho gợi ý mốc 1 (ST_DWithin).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gis.monitored_areas (
    id            BIGSERIAL PRIMARY KEY,
    code          VARCHAR(30) UNIQUE,              -- KV-2026-001, gán sau khi INSERT
    name          VARCHAR(200),                    -- tên gợi nhớ (tùy chọn)
    ref_geom      GEOMETRY(POLYGON, 4326),          -- ranh giới tham chiếu (lần đo đầu)
    commune_code  VARCHAR(20),
    note          TEXT,
    created_by    BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_monitored_areas_geom ON gis.monitored_areas USING GIST (ref_geom);
CREATE INDEX IF NOT EXISTS idx_monitored_areas_commune ON gis.monitored_areas (commune_code);

DROP TRIGGER IF EXISTS trg_monitored_areas_updated_at ON gis.monitored_areas;
CREATE TRIGGER trg_monitored_areas_updated_at
    BEFORE UPDATE ON gis.monitored_areas
    FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();

-- ── 2. gis.field_measurements ────────────────────────────────────────────────
-- Một phiên đo GPS thực địa. points lưu vết đo gốc (đối chiếu/pháp lý);
-- geom là polygon đã khép + ST_MakeValid từ các điểm đó.
-- old_land_use auto-fill từ thửa giao cắt lớn nhất trong affected_features,
-- cán bộ xác nhận/sửa; new_land_use là hiện trạng quan sát được, nhập tay.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gis.field_measurements (
    id                BIGSERIAL PRIMARY KEY,
    code              VARCHAR(30) UNIQUE,            -- DD-2026-00001, gán sau khi INSERT
    area_id           BIGINT REFERENCES gis.monitored_areas(id) ON DELETE SET NULL,
    layer_id          INT REFERENCES gis.layer_registry(id) ON DELETE SET NULL,  -- lớp thửa đối chiếu

    points            JSONB NOT NULL,                -- [{lng,lat,accuracy_m,recorded_at}, ...]
    geom              GEOMETRY(POLYGON, 4326) NOT NULL,
    area_m2           NUMERIC(16,2) NOT NULL CHECK (area_m2 >= 0),
    avg_accuracy_m    NUMERIC(6,2),

    commune_code      VARCHAR(20),                   -- xã/phường (spatial join lúc tạo)
    affected_features JSONB NOT NULL DEFAULT '[]',    -- [{feature_id, land_use, overlap_m2}, ...]
    old_land_use      VARCHAR(100),                   -- auto-fill (thửa giao cắt lớn nhất)
    new_land_use      VARCHAR(100),                   -- hiện trạng quan sát được
    note              TEXT,

    status            VARCHAR(20) NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','submitted','verified','rejected')),
    review_note       TEXT,                           -- lý do trả lại (rejected)

    device_info       JSONB,
    measured_by       BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    verified_by       BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,

    started_at        TIMESTAMPTZ,
    finished_at       TIMESTAMPTZ,
    submitted_at      TIMESTAMPTZ,
    verified_at       TIMESTAMPTZ,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_field_measurements_geom ON gis.field_measurements USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_field_measurements_status ON gis.field_measurements (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_field_measurements_area ON gis.field_measurements (area_id, finished_at DESC);
CREATE INDEX IF NOT EXISTS idx_field_measurements_commune ON gis.field_measurements (commune_code);
CREATE INDEX IF NOT EXISTS idx_field_measurements_measured_by ON gis.field_measurements (measured_by, created_at DESC);

DROP TRIGGER IF EXISTS trg_field_measurements_updated_at ON gis.field_measurements;
CREATE TRIGGER trg_field_measurements_updated_at
    BEFORE UPDATE ON gis.field_measurements
    FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();

-- ── 3. gis.field_measurement_photos ──────────────────────────────────────────
-- Ảnh hiện trường đính kèm phiên đo, lưu trong MinIO (minio_key tham chiếu).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gis.field_measurement_photos (
    id             BIGSERIAL PRIMARY KEY,
    measurement_id BIGINT NOT NULL REFERENCES gis.field_measurements(id) ON DELETE CASCADE,
    minio_key      TEXT NOT NULL,
    original_name  VARCHAR(255),
    mime_type      VARCHAR(100),
    size_bytes     BIGINT,
    taken_at       TIMESTAMPTZ,                      -- thời điểm chụp (EXIF nếu có)
    uploaded_by    BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_field_measurement_photos_measurement ON gis.field_measurement_photos (measurement_id);

-- ── 4. RBAC ──────────────────────────────────────────────────────────────────
-- field_measurements.create/read/update/submit/delete/export : so_nnmt (nghiệp vụ đo)
-- field_measurements.verify                                   : chỉ system_admin
-- field_measurements.read/export                              : ubnd_tinh (theo dõi)
-- ────────────────────────────────────────────────────────────────────────────

UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb) || '{
  "field_measurements": {
    "create": true,
    "read": true,
    "update": true,
    "submit": true,
    "delete": true,
    "export": true
  }
}'::jsonb
WHERE code = 'so_nnmt';

UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb) || '{
  "field_measurements": {
    "create": true,
    "read": true,
    "update": true,
    "submit": true,
    "verify": true,
    "delete": true,
    "export": true
  }
}'::jsonb
WHERE code = 'system_admin';

UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb) || '{
  "field_measurements": {
    "read": true,
    "export": true
  }
}'::jsonb
WHERE code = 'ubnd_tinh';
