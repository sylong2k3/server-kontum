-- Durable, bounded retry state for scheduled Fire Risk and Forest Classification.

ALTER TABLE fire.fire_risk_snapshots
    ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_retry_error TEXT;

ALTER TABLE forest.forest_snapshots
    ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_retry_error TEXT;

ALTER TABLE fire.fire_risk_snapshots
    DROP CONSTRAINT IF EXISTS fire_risk_snapshots_retry_count_check;
ALTER TABLE fire.fire_risk_snapshots
    ADD CONSTRAINT fire_risk_snapshots_retry_count_check
    CHECK (retry_count BETWEEN 0 AND 3);

ALTER TABLE forest.forest_snapshots
    DROP CONSTRAINT IF EXISTS forest_snapshots_retry_count_check;
ALTER TABLE forest.forest_snapshots
    ADD CONSTRAINT forest_snapshots_retry_count_check
    CHECK (retry_count BETWEEN 0 AND 3);

CREATE INDEX IF NOT EXISTS idx_fire_risk_snapshots_retry_due
    ON fire.fire_risk_snapshots (next_retry_at)
    WHERE status = 'failed' AND next_retry_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_forest_snapshots_retry_due
    ON forest.forest_snapshots (next_retry_at)
    WHERE status = 'failed' AND next_retry_at IS NOT NULL;
