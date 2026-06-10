-- ============================================================================
-- Migration 001: Create Schemas
-- Mục đích: Tạo các schema (namespace) cho hệ thống
-- ============================================================================

-- Schema: auth
-- Chứa tất cả bảng liên quan đến xác thực, phân quyền người dùng
CREATE SCHEMA IF NOT EXISTS auth;

-- Ghi chú:
-- search_path đã được cấu hình trong database.js: 'public,auth,vn_units'
-- Không cần ALTER ROLE SET search_path vì đã xử lý ở application level
