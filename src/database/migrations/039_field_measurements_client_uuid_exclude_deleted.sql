-- ============================================================================
-- Migration 039: FIX unique index client_uuid không loại trừ bản ghi đã xoá mềm
--
-- Bug: uq_field_measurements_measured_by_client_uuid (migration 038) chỉ lọc
-- WHERE client_uuid IS NOT NULL, không tính đến deleted_at. Khi một phiên đo
-- draft bị xoá mềm (deleteMeasurement) rồi người dùng đo lại với cùng
-- client_uuid, INSERT mới đụng UNIQUE với bản ghi đã xoá -> ON CONFLICT DO
-- NOTHING -> service fallback SELECT (có điều kiện deleted_at IS NULL) không
-- tìm thấy gì -> createMeasurement trả về created = null -> crash tại
-- toMeasurementItem (Cannot read properties of null (reading 'id')).
--
-- Fix: thêm deleted_at IS NULL vào predicate — bản ghi đã xoá mềm không còn
-- chiếm chỗ trong index, cho phép tái sử dụng client_uuid sau khi xoá.
-- ============================================================================

DROP INDEX IF EXISTS gis.uq_field_measurements_measured_by_client_uuid;

CREATE UNIQUE INDEX IF NOT EXISTS uq_field_measurements_measured_by_client_uuid
    ON gis.field_measurements (measured_by, client_uuid)
    WHERE client_uuid IS NOT NULL AND deleted_at IS NULL;
