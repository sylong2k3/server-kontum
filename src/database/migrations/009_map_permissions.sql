-- ============================================================================
-- Migration 009: MAP RBAC permissions
-- Adds permissions for GeoServer map/layer administration and map viewing.
-- Idempotent: merges into existing auth.roles.permissions JSONB.
-- ============================================================================

UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb) || '{
  "map_layers": {
    "read": true,
    "publish": true,
    "unpublish": true,
    "update": true,
    "harvest": true
  },
  "map_proxy": {
    "read": true
  }
}'::jsonb
WHERE code IN ('system_admin', 'so_nnmt');

UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb) || '{
  "map_layers": {
    "read": true
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