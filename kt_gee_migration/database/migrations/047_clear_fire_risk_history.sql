-- ============================================================================
-- Migration 047: clear all Fire Risk analysis history
--
-- Intentional one-time cleanup for snapshots created before the district
-- boundary loader supported `ma_huyen` and `ten_huyen`. Those old snapshots
-- persisted placeholder district names such as "Huyện 1", "Huyện 2", etc.
--
-- Removes:
--   - raster-ingest jobs created by Fire Risk analyses;
--   - Fire Risk snapshots;
--   - district exports and feature rows belonging to those snapshots
--     (deleted through ON DELETE CASCADE).
--
-- Preserves fire ground-truth data, administrative boundaries, layer registry,
-- MinIO objects and GeoServer layers.
-- ============================================================================

-- Raster jobs reference Fire Risk analyses through JSON instead of a foreign
-- key. Delete them first so a new analysis cannot be deduplicated against an
-- old job. Foreign keys from layer_registry/district_exports use
-- ON DELETE SET NULL.
DELETE FROM gis.raster_ingest_jobs
WHERE COALESCE(
          request_params #>> '{linkedResource,type}',
          request_params #>> '{linked_resource,type}'
      ) IN ('fire_risk', 'fire_risk_district')
   OR LEFT(layer_code, 10) = 'fire_risk_';

-- fire_risk_features and fire_risk_district_exports reference snapshots with
-- ON DELETE CASCADE, so this clears the complete analysis history without
-- widening the cleanup to unrelated tables.
DELETE FROM fire.fire_risk_snapshots;
