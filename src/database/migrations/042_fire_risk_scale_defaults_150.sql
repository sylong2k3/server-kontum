-- Fire district exports use the same 150 m operational fallback as Forest.
-- Existing rows keep their recorded scale; only future rows without an
-- explicit value receive the safer default.

BEGIN;

ALTER TABLE fire.fire_risk_snapshots
    ALTER COLUMN export_scale_m SET DEFAULT 150;

ALTER TABLE fire.fire_risk_district_exports
    ALTER COLUMN scale_m SET DEFAULT 150;

COMMIT;
