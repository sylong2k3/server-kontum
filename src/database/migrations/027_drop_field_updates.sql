-- ============================================================================
-- Migration 027: DROP FIELD UPDATES (gỡ bỏ tính năng field-update mobile)
-- Ngược lại migration 018/019 — 2 file đó đã bị xoá khỏi repo nên trên DB mới
-- bảng này sẽ không được tạo ra nữa; migration này dọn sạch DB cũ đã từng
-- chạy 018/019 (nếu có). Idempotent: dùng IF EXISTS.
-- ============================================================================

DROP TABLE IF EXISTS field.field_updates;
DROP FUNCTION IF EXISTS field.set_field_update_geom();
