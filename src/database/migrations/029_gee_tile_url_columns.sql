-- ============================================================================
-- gee_tile_url + gee_map_id cho fire.fire_risk_snapshots và forest.forest_snapshots
--
-- Client hiện tại render bản đồ raster bằng geeTileUrl (Earth Engine Tile API)
-- thay vì tile URL của GeoServer, vì GeoServer publish chỉ chạy khi có
-- GEE_GCS_BUCKET + MinIO. Không phụ thuộc GCS → cần một url tile GEE bền vững
-- gắn liền với snapshot đã tính.
--
-- gee_map_id  : mapId trả về từ ee.data.getMapId (dùng để tái tạo url khi cần).
-- gee_tile_url: url tile mẫu {z}/{x}/{y} client cắm thẳng vào Leaflet/Mapbox.
-- gee_tile_generated_at: mốc thời gian sinh url — dùng để invalidate khi cũ.
-- ============================================================================

ALTER TABLE fire.fire_risk_snapshots
    ADD COLUMN IF NOT EXISTS gee_map_id            VARCHAR(500),
    ADD COLUMN IF NOT EXISTS gee_tile_url          TEXT,
    ADD COLUMN IF NOT EXISTS gee_tile_generated_at TIMESTAMPTZ;

ALTER TABLE forest.forest_snapshots
    ADD COLUMN IF NOT EXISTS gee_map_id            VARCHAR(500),
    ADD COLUMN IF NOT EXISTS gee_tile_url          TEXT,
    ADD COLUMN IF NOT EXISTS gee_tile_generated_at TIMESTAMPTZ;
