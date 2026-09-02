-- ============================================================================
-- Migration 013: PDF MAPS — Quản trị bản đồ chuyên đề PDF
--
-- Lưu trữ các bản đồ PDF chuyên đề (lớp phủ nhiệt, cháy rừng, lớp phủ rừng…)
-- theo năm (1991 → nay). File vật lý lưu ở disk backend (public/uploads/pdf-maps),
-- bảng này chỉ lưu metadata + đường dẫn.
--
-- Tách riêng khỏi cms.documents vì cần các chiều nghiệp vụ riêng:
--   - theme_code : chủ đề bản đồ
--   - year       : năm bản đồ (chiều lọc chính)
--   - scale      : tỷ lệ bản đồ
--
-- Đa ngữ (vi/en) tách sang cms.pdf_map_translations giống document_translations.
--
-- Idempotent: dùng IF NOT EXISTS / ON CONFLICT.
-- Phụ thuộc: 002_cms.sql (schema cms, core.update_updated_at_column).
-- ============================================================================

-- ════════════════════════════════════════════════════════════════════════════
--  1. cms.pdf_maps — Metadata chung của bản đồ PDF
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS cms.pdf_maps (
    id            BIGSERIAL PRIMARY KEY,
    theme_code    VARCHAR(30) NOT NULL CHECK (theme_code IN ('lop_phu_nhiet', 'chay_rung', 'lop_phu_rung', 'khac')),
    year          SMALLINT NOT NULL CHECK (year BETWEEN 1900 AND 2100),
    scale         VARCHAR(30),
    region        VARCHAR(150),
    file_url      TEXT NOT NULL,
    file_name     VARCHAR(255),
    mime_type     VARCHAR(150),
    file_size     BIGINT,
    thumbnail_url TEXT,
    is_public     BOOLEAN NOT NULL DEFAULT false,
    uploaded_by   BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    deleted_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pdf_maps_theme_year
    ON cms.pdf_maps (theme_code, year DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pdf_maps_year
    ON cms.pdf_maps (year DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pdf_maps_public
    ON cms.pdf_maps (is_public) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pdf_maps_uploaded_by
    ON cms.pdf_maps (uploaded_by);

DROP TRIGGER IF EXISTS trigger_pdf_maps_updated_at ON cms.pdf_maps;
CREATE TRIGGER trigger_pdf_maps_updated_at
    BEFORE UPDATE ON cms.pdf_maps
    FOR EACH ROW
    EXECUTE FUNCTION core.update_updated_at_column();


-- ════════════════════════════════════════════════════════════════════════════
--  2. cms.pdf_map_translations — Bản dịch (vi/en) tiêu đề + mô tả
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS cms.pdf_map_translations (
    id          BIGSERIAL PRIMARY KEY,
    pdf_map_id  BIGINT NOT NULL REFERENCES cms.pdf_maps(id) ON DELETE CASCADE,
    lang        VARCHAR(5) NOT NULL CHECK (lang IN ('vi', 'en')),
    title       VARCHAR(255) NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (pdf_map_id, lang)
);

CREATE INDEX IF NOT EXISTS idx_pdf_map_translations_pdf_map_id
    ON cms.pdf_map_translations (pdf_map_id);

DROP TRIGGER IF EXISTS trigger_pdf_map_translations_updated_at ON cms.pdf_map_translations;
CREATE TRIGGER trigger_pdf_map_translations_updated_at
    BEFORE UPDATE ON cms.pdf_map_translations
    FOR EACH ROW
    EXECUTE FUNCTION core.update_updated_at_column();


-- ════════════════════════════════════════════════════════════════════════════
--  3. RBAC — Seed quyền cho pdf_maps + pdf_map_translations (và documents)
--
--  Merge vào auth.roles.permissions JSONB (idempotent, giống migration 009).
--  "documents"/"document_translations" được seed lại ở đây để đảm bảo đầy đủ
--  cho 2 vai trò quản trị, không phụ thuộc thứ tự chạy migration 005.
-- ════════════════════════════════════════════════════════════════════════════

-- system_admin + so_nnmt: toàn quyền quản trị bản đồ PDF & tài liệu
UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb) || '{
  "pdf_maps": {
    "read": true,
    "create": true,
    "update": true,
    "delete": true,
    "publish": true
  },
  "pdf_map_translations": {
    "read": true,
    "create": true,
    "update": true,
    "delete": true
  },
  "documents": {
    "read": true,
    "create": true,
    "update": true,
    "delete": true,
    "publish": true
  },
  "document_translations": {
    "read": true,
    "create": true,
    "update": true,
    "delete": true
  }
}'::jsonb
WHERE code IN ('system_admin', 'so_nnmt');

-- ubnd_tinh: chỉ xem
UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb) || '{
  "pdf_maps": { "read": true },
  "documents": { "read": true }
}'::jsonb
WHERE code = 'ubnd_tinh';

-- citizen: chỉ xem bản đồ công khai (đồng bộ với documents.read)
UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb) || '{
  "pdf_maps": { "read": true },
  "documents": { "read": true }
}'::jsonb
WHERE code = 'citizen';
