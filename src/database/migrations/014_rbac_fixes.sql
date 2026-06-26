-- ============================================================================
-- Migration 014: RBAC FIXES
--
-- Fix: so_nnmt thiếu "remote_sensing.delete" → không thể xóa ảnh của mình.
-- Migration 007 chỉ cấp delete_own: true, nhưng route dùng
-- requirePermission('remote_sensing', 'delete') nên middleware block trước
-- khi service kịp kiểm tra ownership.
--
-- Service deleteImage đã có guard đúng (isOwner || isAdmin ['system_admin']),
-- nên chỉ cần mở cổng middleware — so_nnmt vẫn không xóa được ảnh của người khác.
--
-- Idempotent: dùng || để merge vào JSONB hiện có.
-- ============================================================================

UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb) || '{
  "remote_sensing": {
    "read":       true,
    "create":     true,
    "update":     true,
    "update_own": true,
    "delete":     true,
    "delete_own": true,
    "download":   true,
    "process":    true,
    "publish":    true
  }
}'::jsonb
WHERE code = 'so_nnmt';
