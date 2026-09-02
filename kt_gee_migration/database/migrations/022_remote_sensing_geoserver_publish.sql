-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 022: Liên kết layer_registry với kho ảnh viễn thám
--
-- Cho phép publish ảnh GeoTIFF từ kho viễn thám (MinIO) lên GeoServer:
-- mỗi layer raster trong gis.layer_registry có thể tham chiếu ngược về
-- bản ghi gốc trong raster.remote_sensing_images (source of truth).
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE gis.layer_registry
    ADD COLUMN IF NOT EXISTS remote_sensing_image_id BIGINT
        REFERENCES raster.remote_sensing_images(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_layer_registry_rs_image
    ON gis.layer_registry (remote_sensing_image_id)
    WHERE remote_sensing_image_id IS NOT NULL;

COMMENT ON COLUMN gis.layer_registry.remote_sensing_image_id IS
    'FK tới raster.remote_sensing_images — layer được publish từ kho ảnh viễn thám';
