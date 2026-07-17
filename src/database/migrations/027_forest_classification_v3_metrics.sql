-- ============================================================================
-- Forest Classification v3: independent test metrics + sample quotas.
--
-- v3 pipeline supports optional ground-truth (Input 50% / Dataset 30% /
-- Threshold 20%). When ground truth is provided, we hold out 30% at the
-- feature level for independent validation and expose:
--   * test_accuracy — Overall Accuracy % on input holdout
--   * test_kappa    — Cohen's kappa on input holdout
--   * sample_quotas — JSON {inputQuota, datasetQuota, thresholdQuota,
--                          inputTestQuota} actually used for the run.
-- ============================================================================

ALTER TABLE forest.forest_snapshots
    ADD COLUMN IF NOT EXISTS test_accuracy  NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS test_kappa     NUMERIC(6,3),
    ADD COLUMN IF NOT EXISTS sample_quotas  JSONB;
