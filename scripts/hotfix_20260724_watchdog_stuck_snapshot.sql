-- ─────────────────────────────────────────────────────────────────────────────
-- Hotfix 2026-07-24
--
-- Bug 2 — Fire risk cronjob thất bại liên tục:
--   "column 'oob_accuracy' of relation 'fire_risk_snapshots' does not exist"
--   → Migration 037 chưa được apply trên prod. Chạy phần 1 dưới đây.
--
-- Bug 3 — Forest snapshot period 2026/6 kẹt status='computing' từ 2026-07-23:
--   Worker trước đó bị crash/restart giữa chừng, không được đánh dấu failed.
--   Watchdog (2h stale) không retry vì mỗi lần retry lại upsertSnapshot()
--   set updated_at=NOW() rồi lại chết → treo mãi. Đánh dấu failed để watchdog
--   lượt tick tiếp theo tạo run mới cho 2026/6.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. Migration 037: thêm cột oob_accuracy vào fire_risk_snapshots ───────
ALTER TABLE fire.fire_risk_snapshots
    ADD COLUMN IF NOT EXISTS oob_accuracy NUMERIC(5,2);

COMMENT ON COLUMN fire.fire_risk_snapshots.oob_accuracy IS
    'Out-of-bag accuracy % (0-100) của RF classifier. NULL khi RF disabled hoặc COMPUTE_OOB=false.';

-- ── 2. Đánh dấu snapshot forest 2026/6 (id=2) là failed để watchdog retry ─
-- Chỉ update khi vẫn ở status computing/pending/exporting (tránh ghi đè
-- accidentally trên snapshot đã hoàn thành nếu chạy nhầm nhiều lần).
UPDATE forest.forest_snapshots
   SET status        = 'failed',
       error_message = 'Reset bởi hotfix 20260724 — worker crash để lại status computing quá 24h',
       updated_at    = NOW()
 WHERE id = 2
   AND status IN ('pending', 'computing', 'exporting');

-- Kiểm chứng — hai row phải in ra ngay.
SELECT 'fire.oob_accuracy exists' AS check,
       COUNT(*)                    AS ok
  FROM information_schema.columns
 WHERE table_schema = 'fire'
   AND table_name   = 'fire_risk_snapshots'
   AND column_name  = 'oob_accuracy';

SELECT id, year, month, status, updated_at
  FROM forest.forest_snapshots
 WHERE id = 2;

COMMIT;
