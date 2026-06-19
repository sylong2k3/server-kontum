-- ============================================================================
-- Migration 004: ALTER cms.news — Làm nullable các cột đã chuyển sang news_translations
--
-- Sau migration 003, nội dung (title, slug, content) đã được tách sang bảng
-- cms.news_translations. Các cột gốc trên cms.news không còn được dùng để
-- lưu trữ nữa nhưng constraint NOT NULL vẫn còn, gây lỗi khi INSERT qua
-- newsRepository.createMeta() (chỉ insert cover_url, status, author_id...).
--
-- Migration này làm nullable các cột thừa để tương thích với thiết kế mới.
-- Idempotent: ALTER COLUMN … DROP NOT NULL an toàn nếu cột đã nullable.
-- ============================================================================

ALTER TABLE cms.news ALTER COLUMN title DROP NOT NULL;
ALTER TABLE cms.news ALTER COLUMN slug  DROP NOT NULL;
ALTER TABLE cms.news ALTER COLUMN content DROP NOT NULL;

-- cms.documents.title cũng đã chuyển sang document_translations
ALTER TABLE cms.documents ALTER COLUMN title DROP NOT NULL;
