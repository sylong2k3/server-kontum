-- ============================================================================
-- Migration 026: Cho phép user xoá (ẩn riêng) thông báo broadcast
--
-- Trước đây DELETE /api/v1/notifications/:id chỉ xoá được thông báo cá nhân
-- (user_id = actor.id). Thông báo broadcast (user_id NULL, audience 'all'/'role')
-- không thể xoá vì không có bản ghi nào khớp user_id -> luôn trả 404.
--
-- Thêm cột dismissed_at vào core.notification_reads để lưu trạng thái
-- "đã ẩn/xoá riêng" theo từng user, không ảnh hưởng tới user khác.
-- ============================================================================

ALTER TABLE core.notification_reads
    ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;
