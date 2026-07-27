-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 043: RASTER INGEST — thêm status 'url_expired'
--
-- Bối cảnh:
--   Sau khi PM2 restart, GEE session token đổi → liên kết tải tạm được sinh
--   trong session cũ trả HTTP 401 "Invalid token". Trước đây worker mark
--   status='failed' non-retryable → mất luôn cả 9 huyện của snapshot. Bây giờ
--   worker detect 401 → set 'url_expired', job URL-refresh (cron */5) sẽ chạy
--   lại pipeline sinh liên kết mới rồi re-enqueue.
--
-- Thay đổi:
--   - Mở rộng CHECK constraint status của gis.raster_ingest_jobs để chấp nhận
--     'url_expired'.
--   - Dedupe partial UNIQUE + worker queue index đã lọc theo status NOT IN
--     ('completed','failed','cancelled') — 'url_expired' tự động được lọc là
--     "đang mở" (chưa terminal), không cần đổi index.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE gis.raster_ingest_jobs
    DROP CONSTRAINT IF EXISTS raster_ingest_jobs_status_check;

ALTER TABLE gis.raster_ingest_jobs
    ADD CONSTRAINT raster_ingest_jobs_status_check
    CHECK (status IN (
        'pending','downloading','validating','uploading',
        'publishing','completed','failed','cancelled',
        'url_expired'
    ));

COMMENT ON COLUMN gis.raster_ingest_jobs.status IS
    'State: pending/downloading/validating/uploading/publishing/completed/failed/cancelled/url_expired. url_expired = lien ket tai tam het han (HTTP 401), cho job refresh sinh lien ket moi.';

COMMIT;
