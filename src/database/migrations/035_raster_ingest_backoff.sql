-- ============================================================================
-- Migration 035: RASTER-INGEST — add next_retry_at cho exponential backoff
--
-- Vấn đề trước fix: worker poll cron `*/15s`, khi 1 job retry sau HTTP 429
-- (GEE rate limit) → status trở lại 'pending' → 15s sau claim lại → 429 nữa.
-- 3 retry trong 30s không đủ cửa sổ để GEE mở lại quota → GEE hard-reject
-- (400) và invalidate URL vĩnh viễn.
--
-- Fix: cột `next_retry_at TIMESTAMPTZ`. Khi retry vì 429, service set
-- `next_retry_at = NOW() + backoff` (60s / 180s / 600s tuỳ retry_count).
-- Worker query `claimPending` chỉ pick job có `next_retry_at IS NULL OR
-- next_retry_at <= NOW()`. Retry vì lỗi khác (network, timeout) vẫn giữ null
-- → poll ngay tick tiếp theo (không delay).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.
-- ============================================================================

ALTER TABLE gis.raster_ingest_jobs
    ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

COMMENT ON COLUMN gis.raster_ingest_jobs.next_retry_at IS
    'Earliest time worker được phép re-claim job (dùng cho backoff sau HTTP 429). NULL = pick ngay.';

-- Index để `claimPending` WHERE `next_retry_at IS NULL OR next_retry_at <= NOW()`
-- không phải full-scan khi có nhiều job pending.
CREATE INDEX IF NOT EXISTS idx_raster_ingest_next_retry
    ON gis.raster_ingest_jobs (next_retry_at)
    WHERE status = 'pending';
