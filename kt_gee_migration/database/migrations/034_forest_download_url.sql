-- ============================================================================
-- Migration 034: FOREST CLASSIFICATION — add gee_download_url column
--
-- Mirror migration 030 cho forest snapshots. Cho phép service persist download
-- URL (GeoTIFF phân loại 11 lớp) từ `ee.Image.getDownloadURL()` ở cuối
-- pipeline runAnalysis. URL có TTL ~24h → auto-ingest raster-ingest job sẽ
-- pull về MinIO trước khi hết hạn, back-link `geoserver_layer` vào snapshot.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS (Postgres 9.6+).
-- ============================================================================

ALTER TABLE forest.forest_snapshots
    ADD COLUMN IF NOT EXISTS gee_download_url TEXT;

COMMENT ON COLUMN forest.forest_snapshots.gee_download_url IS
    'GEE getDownloadURL() cho classified image (11-class viz), clip theo province polygon. GeoTIFF trần valid ~24h.';
