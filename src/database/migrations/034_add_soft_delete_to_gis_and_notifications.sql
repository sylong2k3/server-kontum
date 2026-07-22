-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 034 — Soft Delete cho gis.layer_registry, gis.map_apis,
--                 gis.field_measurements, core.notifications
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE gis.layer_registry
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_gis_layer_registry_deleted_at
    ON gis.layer_registry(deleted_at)
    WHERE deleted_at IS NULL;

ALTER TABLE gis.map_apis
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_gis_map_apis_deleted_at
    ON gis.map_apis(deleted_at)
    WHERE deleted_at IS NULL;

ALTER TABLE gis.field_measurements
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_gis_field_measurements_deleted_at
    ON gis.field_measurements(deleted_at)
    WHERE deleted_at IS NULL;

ALTER TABLE core.notifications
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_core_notifications_deleted_at
    ON core.notifications(deleted_at)
    WHERE deleted_at IS NULL;
