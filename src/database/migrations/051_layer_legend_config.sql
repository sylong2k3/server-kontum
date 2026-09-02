-- ============================================================================
-- Migration 051: Add legend_config to gis.layer_registry
-- Canonical shape: {"entries": [{"label": "...", "color": "#HEX"}]} or NULL
-- ============================================================================

ALTER TABLE gis.layer_registry
    ADD COLUMN IF NOT EXISTS legend_config JSONB NULL;

COMMENT ON COLUMN gis.layer_registry.legend_config IS
    'Cấu hình chú giải lớp bản đồ (canonical format: {"entries": [{"label": string, "color": "#hex"}]})';
