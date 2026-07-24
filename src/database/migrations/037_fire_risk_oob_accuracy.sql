-- ─────────────────────────────────────────────────────────────────────────────
-- 037_fire_risk_oob_accuracy
--
-- Thêm cột `oob_accuracy` (%) vào fire.fire_risk_snapshots — diagnostic
-- chất lượng RF classifier v8.1. Tính qua `classifier.explain().getInfo()`
-- khi env FIRE_RISK_COMPUTE_OOB=true (cost thêm 30-90s/lần chạy). NULL khi
-- ENABLE_RF=false, COMPUTE_OOB=false, hoặc getInfo timeout.
-- Cùng semantic + kiểu như forest.forest_classification_snapshots.oob_accuracy.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE fire.fire_risk_snapshots
    ADD COLUMN IF NOT EXISTS oob_accuracy NUMERIC(5,2);

COMMENT ON COLUMN fire.fire_risk_snapshots.oob_accuracy IS
    'Out-of-bag accuracy % (0-100) của RF classifier. NULL khi RF disabled hoặc COMPUTE_OOB=false.';
