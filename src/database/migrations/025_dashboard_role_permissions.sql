-- ============================================================================
-- Migration 025: Mở quyền dashboard cho so_nnmt (EP-07 US-063)
--
-- Trước migration này, GET /stats/dashboard chỉ cấp cho system_admin và
-- ubnd_tinh (statistics.dashboard). so_nnmt (Sở NN&MT) chỉ có statistics.read
-- nên bị 403 khi gọi dashboard, dù mô tả vai trò (000_init_schema.sql) đã ghi
-- rõ so_nnmt "xử lý và phản hồi cảnh báo, tạo báo cáo chuyên ngành" — cần xem
-- dashboard vận hành (chi tiết theo huyện + phản ánh cần xử lý).
--
-- statistics.service.js#getDashboard dùng req.user.role để trả về nội dung
-- khác nhau theo scope: 'executive' (system_admin/ubnd_tinh) vs 'operational'
-- (so_nnmt).
--
-- Idempotent: || jsonb chỉ ghi đè key statistics, không đụng permission khác.
-- ============================================================================

UPDATE auth.roles
SET permissions = COALESCE(permissions, '{}'::jsonb)
    || '{"statistics":{"read":true,"dashboard":true}}'::jsonb
WHERE code = 'so_nnmt';
