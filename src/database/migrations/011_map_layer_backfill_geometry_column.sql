-- ============================================================================
-- Migration 011: Backfill registry geometry column from PostGIS metadata
-- ============================================================================

UPDATE gis.layer_registry lr
SET geometry_column = gc.f_geometry_column,
    geometry_type = UPPER(gc.type),
    epsg_code = gc.srid,
    updated_at = NOW(),
    last_updated_at = NOW()
FROM geometry_columns gc
WHERE gc.f_table_schema = lr.schema_name
  AND gc.f_table_name = lr.table_name
  AND gc.f_geometry_column IS NOT NULL
  AND (
      lr.geometry_column IS DISTINCT FROM gc.f_geometry_column
      OR lr.geometry_type IS DISTINCT FROM UPPER(gc.type)
      OR lr.epsg_code IS DISTINCT FROM gc.srid
  );
