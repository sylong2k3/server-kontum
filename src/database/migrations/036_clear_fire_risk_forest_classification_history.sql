-- ============================================================================
-- Migration 036: clear Fire Risk and Forest Classification run history
--
-- This is an intentional one-time data cleanup. It removes:
--   - raster ingest jobs linked to Fire Risk or Forest Classification snapshots;
--   - Fire Risk snapshots and their feature rows;
--   - Forest Classification snapshots and their district-area rows.
--
-- It does not remove ground-truth data, satellite.image_results, MinIO objects,
-- GeoServer layers, or gis.layer_registry records.
-- ============================================================================

-- These jobs reference snapshots through JSON rather than a foreign key. Remove
-- them first so a new analysis is not deduplicated against an old ingest job.
DELETE FROM gis.raster_ingest_jobs
WHERE COALESCE(
          request_params #>> '{linkedResource,type}',
          request_params #>> '{linked_resource,type}'
      ) IN ('fire_risk', 'forest')
   OR LEFT(layer_code, 10) = 'fire_risk_'
   OR LEFT(layer_code, 13) = 'forest_class_';

-- Include child tables explicitly. Avoid TRUNCATE ... CASCADE so this cleanup
-- cannot expand to unrelated tables if more foreign keys are added later.
TRUNCATE TABLE
    fire.fire_risk_features,
    fire.fire_risk_snapshots,
    forest.forest_district_areas,
    forest.forest_snapshots
RESTART IDENTITY;
