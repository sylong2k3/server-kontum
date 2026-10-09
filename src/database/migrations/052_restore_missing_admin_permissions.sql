-- 052: Restore only missing actions from the existing RBAC migrations.
-- Sources: 006, 009/010, 013_pdf_maps, 015, 017/025, 028, 031, 032/033.
-- Never replay historical migrations to repair permissions (046-048 delete data).
-- Existing action values, including explicit false, and custom resources survive.
-- Deliberate restrictions from 024 and 049 take precedence over the restore list.
-- migrate.js supplies the transaction; do not add BEGIN/COMMIT here.

DO $$
DECLARE
    role_row RECORD;
    resource_row RECORD;
BEGIN
    IF (SELECT count(*) FROM auth.roles
        WHERE code IN ('system_admin', 'ubnd_tinh', 'so_nnmt')) <> 3 THEN
        RAISE EXCEPTION 'RBAC restore requires the three existing Admin roles';
    END IF;
    FOR role_row IN
        SELECT code, permissions FROM auth.roles
        WHERE code IN ('system_admin', 'ubnd_tinh', 'so_nnmt') FOR UPDATE
    LOOP
        IF jsonb_typeof(role_row.permissions) IS DISTINCT FROM 'object' THEN
            RAISE EXCEPTION 'Invalid permissions object for role %', role_row.code;
        END IF;
        FOR resource_row IN SELECT key, value FROM jsonb_each(role_row.permissions)
        LOOP
            IF jsonb_typeof(resource_row.value) IS DISTINCT FROM 'object' THEN
                RAISE EXCEPTION 'Invalid resource permissions for %.%', role_row.code, resource_row.key;
            END IF;
        END LOOP;
    END LOOP;
END $$;

-- Durable, migration-specific rollback snapshot. Re-running must not overwrite it.
CREATE TABLE IF NOT EXISTS core.rbac_restore_052_snapshot (
    role_code VARCHAR(30) PRIMARY KEY,
    permissions JSONB NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO core.rbac_restore_052_snapshot (role_code, permissions)
SELECT code, permissions FROM auth.roles
WHERE code IN ('system_admin', 'ubnd_tinh', 'so_nnmt')
ON CONFLICT (role_code) DO NOTHING;

DO $$
DECLARE
    policy JSONB := '{
      "system_admin": {
        "statistics":{"read":true,"dashboard":true},
        "spatial":{"read":true,"analyze":true},
        "map_layers":{"create":true,"read":true,"update":true,"delete":true,"publish":true,"unpublish":true,"harvest":true,"import":true,"feature_create":true,"feature_read":true,"feature_update":true,"feature_delete":true,"ingest_raster":true},
        "map_proxy":{"read":true},
        "pdf_maps":{"read":true,"create":true,"update":true,"delete":true,"publish":true},
        "pdf_map_translations":{"read":true,"create":true,"update":true,"delete":true},
        "weather":{"read":true,"manage":true},
        "feedback":{"read":true,"create":true,"update":true,"delete":true,"read_own":true,"create_own":true,"update_status":true,"map":true},
        "field_measurements":{"create":true,"read":true,"update":true,"submit":true,"verify":true,"delete":true,"export":true},
        "fire_risk":{"ground_truth":true},
        "forest_classification":{"ground_truth":true}
      },
      "so_nnmt": {
        "statistics":{"read":true,"dashboard":true},
        "spatial":{"read":true,"analyze":true},
        "map_layers":{"create":true,"read":true,"update":true,"delete":true,"unpublish":true,"harvest":true,"import":true,"feature_create":true,"feature_read":true,"feature_update":true,"feature_delete":true,"ingest_raster":true},
        "map_proxy":{"read":true},
        "pdf_maps":{"read":true,"create":true,"update":true,"delete":true,"publish":true},
        "pdf_map_translations":{"read":true,"create":true,"update":true,"delete":true},
        "weather":{"read":true,"manage":true},
        "feedback":{"read":true,"update_status":true,"map":true},
        "field_measurements":{"create":true,"read":true,"update":true,"submit":true,"delete":true,"export":true},
        "fire_risk":{"ground_truth":true},
        "forest_classification":{"ground_truth":true}
      },
      "ubnd_tinh": {
        "statistics":{"read":true,"dashboard":true},
        "spatial":{"read":true},
        "map_layers":{"read":true,"feature_read":true},
        "map_proxy":{"read":true},
        "pdf_maps":{"read":true},
        "weather":{"read":true},
        "feedback":{"read":true,"map":true},
        "field_measurements":{"read":true,"export":true}
      }
    }'::jsonb;
    role_policy RECORD;
    resource_policy RECORD;
    existing JSONB;
    restored JSONB;
BEGIN
    FOR role_policy IN SELECT key, value FROM jsonb_each(policy)
    LOOP
        SELECT permissions INTO existing FROM auth.roles WHERE code = role_policy.key;
        IF role_policy.key = 'so_nnmt' THEN
            existing := existing #- '{remote_sensing,create}' #- '{map_layers,publish}';
        ELSIF role_policy.key = 'ubnd_tinh' THEN
            existing := existing #- '{fire_risk,manage}' #- '{forest_classification,manage}';
        END IF;
        restored := existing;
        FOR resource_policy IN SELECT key, value FROM jsonb_each(role_policy.value)
        LOOP
            -- Existing values are on the RIGHT: false/unknown/custom are not overridden.
            restored := jsonb_set(restored, ARRAY[resource_policy.key],
                resource_policy.value || COALESCE(existing -> resource_policy.key, '{}'::jsonb), TRUE);
        END LOOP;
        IF role_policy.key = 'so_nnmt' THEN
            restored := restored #- '{remote_sensing,create}' #- '{map_layers,publish}';
        ELSIF role_policy.key = 'ubnd_tinh' THEN
            restored := restored #- '{fire_risk,manage}' #- '{forest_classification,manage}';
        END IF;
        UPDATE auth.roles SET permissions = restored
        WHERE code = role_policy.key AND permissions IS DISTINCT FROM restored;
        FOR resource_policy IN SELECT key, value FROM jsonb_each(role_policy.value)
        LOOP
            IF NOT (restored -> resource_policy.key) @> (
                resource_policy.value || COALESCE(existing -> resource_policy.key, '{}'::jsonb)
            ) THEN
                RAISE EXCEPTION 'RBAC restore verification failed for %.%', role_policy.key, resource_policy.key;
            END IF;
        END LOOP;
    END LOOP;
END $$;

-- Citizen, CMS, users, API keys and new remote-sensing grants are untouched.
-- The existing 024 remote_sensing.create revocation is still enforced for so_nnmt.
-- To rollback, first review snapshot vs current permissions and concurrent policy changes.
-- In a maintenance transaction restore auth.roles.permissions from the snapshot,
-- then delete ONLY the 052 schema_migrations row if reapplication is intended.
-- Never overwrite later permission edits without review.
