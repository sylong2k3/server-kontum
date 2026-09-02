-- ============================================================================
-- Migration 010: Map layer CRUD/import/feature permissions and metadata
-- ============================================================================

ALTER TABLE gis.layer_registry
    ADD COLUMN IF NOT EXISTS geometry_column VARCHAR(60) NOT NULL DEFAULT 'geom',
    ADD COLUMN IF NOT EXISTS source_url TEXT;

ALTER TABLE gis.layer_registry
    DROP CONSTRAINT IF EXISTS chk_layer_registry_geometry_column;

ALTER TABLE gis.layer_registry
    ADD CONSTRAINT chk_layer_registry_geometry_column
    CHECK (geometry_column ~ '^[a-zA-Z_][a-zA-Z0-9_]*$');

UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb) || '{
  "map_layers": {
    "create": true,
    "read": true,
    "update": true,
    "delete": true,
    "publish": true,
    "unpublish": true,
    "harvest": true,
    "import": true,
    "feature_create": true,
    "feature_read": true,
    "feature_update": true,
    "feature_delete": true
  },
  "map_proxy": {
    "read": true
  }
}'::jsonb
WHERE code IN ('system_admin', 'so_nnmt');

UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb) || '{
  "map_layers": {
    "read": true,
    "feature_read": true
  },
  "map_proxy": {
    "read": true
  }
}'::jsonb
WHERE code = 'ubnd_tinh';

UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb) || '{
  "map_proxy": {
    "read": true
  }
}'::jsonb
WHERE code = 'citizen';

