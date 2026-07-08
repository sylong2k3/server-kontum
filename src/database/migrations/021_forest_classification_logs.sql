-- ============================================================
-- Migration 021 — Forest Classification: run logs + on-demand
-- ============================================================
-- Adds audit columns to forest.forest_snapshots so admins can
-- see every run with its trigger, requester, and timing.
-- ============================================================

-- ── Audit columns ─────────────────────────────────────────────────────────────

ALTER TABLE forest.forest_snapshots
    ADD COLUMN IF NOT EXISTS trigger       VARCHAR(16) NOT NULL DEFAULT 'cron',
    ADD COLUMN IF NOT EXISTS requested_by  BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS duration_ms   INTEGER;

COMMENT ON COLUMN forest.forest_snapshots.trigger IS
    'cron | manual | user — what initiated this run';
COMMENT ON COLUMN forest.forest_snapshots.requested_by IS
    'User who requested this run (NULL for cron/system triggers)';
COMMENT ON COLUMN forest.forest_snapshots.duration_ms IS
    'Wall-clock milliseconds from run start to completed/failed';

CREATE INDEX IF NOT EXISTS idx_fc_snapshots_trigger      ON forest.forest_snapshots (trigger);
CREATE INDEX IF NOT EXISTS idx_fc_snapshots_requested_by ON forest.forest_snapshots (requested_by)
    WHERE requested_by IS NOT NULL;
