-- ============================================================================
-- Migration 038: IDEMPOTENCY CHO PHIÊN ĐO THỰC ĐỊA (client_uuid)
--
-- App di động ngoài hiện trường thường mất sóng ngay sau khi request POST
-- /field-measurements đã commit ở server nhưng response chưa về tới máy —
-- app coi như timeout và tự động retry cùng nội dung. Không có khoá idempotent
-- thì mỗi lần retry sẽ tạo thêm một phiên đo trùng lặp.
--
-- client_uuid do app sinh 1 lần cho mỗi phiên đo (UUID v4) và gửi lại y nguyên
-- ở mọi lần retry. UNIQUE index (measured_by, client_uuid) là chốt chặn atomic
-- ở tầng DB — service dùng INSERT ... ON CONFLICT DO NOTHING để dedupe race-safe
-- (xem field-measurement.repository.js#create).
-- ============================================================================

ALTER TABLE gis.field_measurements
    ADD COLUMN IF NOT EXISTS client_uuid VARCHAR(80);

-- Partial UNIQUE: NULL (app cũ chưa gửi client_uuid) không bị chặn trùng.
-- Scope theo measured_by (không global) vì client_uuid chỉ đảm bảo duy nhất
-- trong phạm vi thiết bị/người dùng sinh ra nó.
CREATE UNIQUE INDEX IF NOT EXISTS uq_field_measurements_measured_by_client_uuid
    ON gis.field_measurements (measured_by, client_uuid)
    WHERE client_uuid IS NOT NULL;
