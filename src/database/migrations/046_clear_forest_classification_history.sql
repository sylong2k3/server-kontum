-- ============================================================================
-- Migration 046: clear all Forest Classification run history
--
-- Intentional one-time cleanup for the "Lịch sử chạy phân loại" screen.
-- Removes:
--   - raster-ingest jobs created by forest-classification runs;
--   - forest snapshots;
--   - district export and district-area rows belonging to those snapshots
--     (deleted through ON DELETE CASCADE).
--
-- Preserves ground-truth data, administrative boundaries, layer registry,
-- MinIO objects and GeoServer layers.
-- ============================================================================

-- Raster jobs reference classification runs through JSON instead of a foreign
-- key. Delete them first to prevent a future run from being deduplicated
-- against an old job. Foreign keys from layer_registry/district_exports use
-- ON DELETE SET NULL.
DELETE FROM gis.raster_ingest_jobs
WHERE COALESCE(
          request_params #>> '{linkedResource,type}',
          request_params #>> '{linked_resource,type}'
      ) IN ('forest', 'forest_classification', 'forest_district')
   OR LEFT(layer_code, 13) = 'forest_class_';

-- forest_district_areas and forest_district_exports reference snapshots with
-- ON DELETE CASCADE, so deleting snapshots clears the complete run history
-- without widening the cleanup to unrelated tables.
DELETE FROM forest.forest_snapshots;
