-- Speeds up deduplication and history lookups for district raster jobs.
-- The queue identifies generated district layers by layer_code, not layer_id.
CREATE INDEX IF NOT EXISTS idx_raster_ingest_layer_code_created
    ON gis.raster_ingest_jobs (layer_code, created_at DESC);
