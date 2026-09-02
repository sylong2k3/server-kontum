-- ============================================================================
-- Migration 049: Cấp quyền forest_classification + fire_risk theo vai trò
--
-- Đồng bộ RBAC với đặc tả vai trò (00-project-charter.md §5):
--   system_admin : read + manage  (bypass ở middleware, nhưng seed cho khớp UI)
--   so_nnmt      : read + manage  (nghiệp vụ chính — phân tích ảnh, dự báo cháy)
--   ubnd_tinh    : read           (giám sát điều hành, xem cảnh báo/thống kê)
--   citizen      : read           (xem cảnh báo công khai qua MobileGIS/WebGIS)
--
-- Tại sao có migration này:
--   Các migrations trước (019 fire_risk, 020 satellite/forest_classification)
--   đã seed các quyền tương ứng. Trạng thái DB dev/staging cho thấy các key
--   này bị trống → cần seed lại và siết `manage` cho ubnd_tinh (mig 019 cũ
--   cấp `manage` cho ubnd_tinh, không khớp với vai trò "giám sát" — sửa lại).
--
-- Idempotent:
--   Dùng `jsonb_set` với inner `||` để MERGE vào object con của resource, giữ
--   nguyên các action khác (VD sau này thêm `export`, `configure`…). KHÔNG
--   dùng `permissions || '{"fire_risk": {...}}'` top-level vì sẽ ghi đè
--   toàn bộ object con (giống lưu ý ở migration 031).
--
-- Kiểm tra sau khi chạy:
--   SELECT code, permissions -> 'fire_risk' AS fire_risk,
--                 permissions -> 'forest_classification' AS forest
--     FROM auth.roles ORDER BY id;
-- ============================================================================

-- ── fire_risk: read + manage cho system_admin, so_nnmt ──────────────────────
UPDATE auth.roles
SET permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{fire_risk}',
    COALESCE(permissions -> 'fire_risk', '{}'::jsonb)
        || '{"read": true, "manage": true}'::jsonb,
    true
)
WHERE code IN ('system_admin', 'so_nnmt');

-- ── fire_risk: chỉ read cho ubnd_tinh, citizen ──────────────────────────────
-- Với ubnd_tinh: đảm bảo `manage` KHÔNG được set (nếu seed cũ từ mig 019 đã
-- gán → xóa). Với citizen: chỉ read.
UPDATE auth.roles
SET permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{fire_risk}',
    (COALESCE(permissions -> 'fire_risk', '{}'::jsonb) - 'manage')
        || '{"read": true}'::jsonb,
    true
)
WHERE code IN ('ubnd_tinh', 'citizen');

-- ── forest_classification: read + manage cho system_admin, so_nnmt ──────────
UPDATE auth.roles
SET permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{forest_classification}',
    COALESCE(permissions -> 'forest_classification', '{}'::jsonb)
        || '{"read": true, "manage": true}'::jsonb,
    true
)
WHERE code IN ('system_admin', 'so_nnmt');

-- ── forest_classification: chỉ read cho ubnd_tinh, citizen ──────────────────
UPDATE auth.roles
SET permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{forest_classification}',
    (COALESCE(permissions -> 'forest_classification', '{}'::jsonb) - 'manage')
        || '{"read": true}'::jsonb,
    true
)
WHERE code IN ('ubnd_tinh', 'citizen');
