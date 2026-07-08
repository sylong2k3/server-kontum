-- ============================================================================
-- Migration 019: FIELD UPDATE MEDIA (MobileGIS — "Chụp ảnh, cập nhật hiện trạng rừng")
-- Bổ sung ảnh hiện trường cho field.field_updates để khớp ma trận chức năng
-- doc 01 §2: cán bộ Sở NN&MT chụp ảnh kèm điểm đo GPS. Cùng pattern với
-- field.feedback.media_urls (migration 006): mảng đường dẫn tương đối
-- `/uploads/images/...` do upload.middleware ghi ra đĩa.
-- Idempotent: dùng IF NOT EXISTS.
-- ============================================================================

ALTER TABLE field.field_updates
    ADD COLUMN IF NOT EXISTS media_urls JSONB NOT NULL DEFAULT '[]'::jsonb;
