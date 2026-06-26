-- ============================================================================
-- Migration 013: layer_edit_history.layer_id — nullable + ON DELETE SET NULL
-- Lý do: khi xóa layer, lịch sử chỉnh sửa vẫn được giữ lại với layer_id = NULL
--        thay vì bị CASCADE xóa theo, tránh FK_VIOLATION khi insertEditHistory
--        được gọi sau khi layer đã bị xóa.
-- ============================================================================

-- 1. Xóa constraint cũ (NOT NULL + ON DELETE CASCADE)
ALTER TABLE gis.layer_edit_history
    DROP CONSTRAINT IF EXISTS layer_edit_history_layer_id_fkey;

-- 2. Cho phép NULL
ALTER TABLE gis.layer_edit_history
    ALTER COLUMN layer_id DROP NOT NULL;

-- 3. Thêm lại FK với ON DELETE SET NULL
ALTER TABLE gis.layer_edit_history
    ADD CONSTRAINT layer_edit_history_layer_id_fkey
    FOREIGN KEY (layer_id)
    REFERENCES gis.layer_registry(id)
    ON DELETE SET NULL;
