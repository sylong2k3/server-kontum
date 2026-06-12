-- ============================================================================
-- Migration 007: Functional index trên LOWER(email)
-- Mục đích: Tăng tốc truy vấn login/lookup dùng "WHERE LOWER(email) = LOWER($1)"
--           (index idx_users_email cũ trên cột email nguyên trạng không được
--            tận dụng khi bọc hàm LOWER()).
--
-- Lưu ý: App layer (Joi) đã chuẩn hóa email về lowercase + trim trước khi lưu,
--        nên dữ liệu mới luôn đồng nhất. Index này phục vụ cả dữ liệu cũ (mixed case).
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_users_email_lower
    ON auth.users (LOWER(email));
