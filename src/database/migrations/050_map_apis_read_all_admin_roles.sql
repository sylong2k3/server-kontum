-- ============================================================================
-- Migration 050: Cấp map_apis.read cho ubnd_tinh + so_nnmt
--
-- Ma trận vai trò (Danh mục chức năng WebGIS Kon Tum §2.2):
--   API dữ liệu bản đồ:
--     QTS       : M — tạo/chia sẻ/phân quyền API
--     UBND      : V — sử dụng API báo cáo điều hành
--     SO_NNMT   : N — khai thác API tích hợp hệ thống chuyên ngành
--     NGUOI_DAN : —
--
-- Migration 016 chỉ seed cho system_admin (create/read/update/delete). UBND
-- và Sở NN&MT chưa được cấp bất kỳ quyền nào → sidebar item "API bản đồ" bị
-- ẩn với 2 role này, không khớp đặc tả.
--
-- Chỉ mở `read` — 2 role này không tạo/xóa key, chỉ xem danh sách và dùng key
-- do QTS phát hành.
--
-- Idempotent: jsonb_set + inner || merge (không đè các action khác).
-- ============================================================================

UPDATE auth.roles
SET permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{map_apis}',
    COALESCE(permissions -> 'map_apis', '{}'::jsonb) || '{"read": true}'::jsonb,
    true
)
WHERE code IN ('ubnd_tinh', 'so_nnmt');
