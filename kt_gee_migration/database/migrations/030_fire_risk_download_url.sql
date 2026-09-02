-- ============================================================================
-- Migration 030: FIRE RISK — add gee_download_url column
--
-- Cho phép server persist download URL (GeoTIFF clip theo RanhGioiTinh_Polygon)
-- được sinh bởi ee.Image.getDownloadURL() ở cuối pipeline `runAnalysis`.
-- URL có TTL ~24h nên khi expired user cần refresh snapshot để lấy URL mới.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS (Postgres 9.6+).
-- ============================================================================

ALTER TABLE fire.fire_risk_snapshots
    ADD COLUMN IF NOT EXISTS gee_download_url TEXT;

COMMENT ON COLUMN fire.fire_risk_snapshots.gee_download_url IS
    'GEE getDownloadURL() cho RiskLevel image, clip theo province polygon. ZIP GeoTIFF, valid ~24h.';
