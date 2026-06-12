-- ============================================================================
-- Migration 006: Password reset tokens + OAuth one-time exchange codes
-- Mục đích:
--   1. auth.password_reset_tokens — token đặt lại mật khẩu (quên mật khẩu)
--   2. auth.oauth_exchange_codes  — mã 1 lần để frontend đổi lấy token sau OAuth
--      (tránh truyền access/refresh token trực tiếp trên URL query)
--   3. Cập nhật CHECK constraint của auth.activity_logs để thêm action mới
-- ============================================================================


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │  Bảng 1: auth.password_reset_tokens                                       │
-- │  Lưu HASH (SHA-256) của reset token — không lưu token gốc                 │
-- │                                                                           │
-- │  Flow:                                                                    │
-- │  1. User yêu cầu quên mật khẩu → server tạo token ngẫu nhiên             │
-- │  2. Hash token → lưu DB, gửi token gốc qua email                          │
-- │  3. User mở link → gửi token gốc → server hash lại → đối chiếu           │
-- │  4. Đặt mật khẩu mới → đánh dấu used_at → revoke toàn bộ refresh token    │
-- └──────────────────────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS auth.password_reset_tokens (
    id            BIGSERIAL PRIMARY KEY,

    user_id       BIGINT NOT NULL
                  REFERENCES auth.users(id) ON DELETE CASCADE,

    -- SHA-256 hash của reset token (token gốc chỉ gửi qua email)
    token_hash    VARCHAR(64) NOT NULL,

    -- Thời điểm token hết hạn (ngắn hạn, mặc định 15 phút)
    expires_at    TIMESTAMPTZ NOT NULL,

    -- Thời điểm token được sử dụng (NULL = chưa dùng). Token chỉ dùng 1 lần.
    used_at       TIMESTAMPTZ,

    -- IP yêu cầu (audit / chống lạm dụng)
    request_ip    VARCHAR(45),

    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tra cứu nhanh theo hash (verify khi reset)
CREATE INDEX IF NOT EXISTS idx_password_reset_token_hash
    ON auth.password_reset_tokens (token_hash);

-- Dọn token theo user / cleanup
CREATE INDEX IF NOT EXISTS idx_password_reset_user_id
    ON auth.password_reset_tokens (user_id);

CREATE INDEX IF NOT EXISTS idx_password_reset_expires_at
    ON auth.password_reset_tokens (expires_at);


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │  Bảng 2: auth.oauth_exchange_codes                                        │
-- │  Mã 1 lần (one-time code) cấp sau khi OAuth thành công.                   │
-- │  Frontend gọi POST /auth/oauth/exchange { code } để lấy token thật.       │
-- │  → Không lộ access/refresh token trên URL (history, Referer, server log). │
-- └──────────────────────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS auth.oauth_exchange_codes (
    -- SHA-256 hash của code (code gốc chỉ nằm trên URL redirect 1 lần)
    code_hash      VARCHAR(64) PRIMARY KEY,

    user_id        BIGINT NOT NULL
                   REFERENCES auth.users(id) ON DELETE CASCADE,

    -- Token tạm giữ để trả cho frontend khi exchange (TTL rất ngắn ~60s)
    access_token   TEXT NOT NULL,
    refresh_token  TEXT NOT NULL,
    is_new_user    BOOLEAN NOT NULL DEFAULT false,

    expires_at     TIMESTAMPTZ NOT NULL,
    used_at        TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires_at
    ON auth.oauth_exchange_codes (expires_at);


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │  Cập nhật CHECK constraint cho auth.activity_logs                         │
-- │  Thêm các action liên quan đến reset password                             │
-- └──────────────────────────────────────────────────────────────────────────┘

ALTER TABLE auth.activity_logs DROP CONSTRAINT IF EXISTS activity_logs_action_check;

ALTER TABLE auth.activity_logs
    ADD CONSTRAINT activity_logs_action_check
    CHECK (action IN (
        'register',
        'login',
        'login_failed',
        'logout',
        'refresh_token',
        'change_password',
        'social_login',
        'social_link',
        'social_unlink',
        'account_locked',
        'account_unlocked',
        'force_logout',
        'password_reset_request',   -- Yêu cầu đặt lại mật khẩu (quên mật khẩu)
        'password_reset',           -- Đặt lại mật khẩu thành công
        'password_reset_failed'     -- Đặt lại mật khẩu thất bại (token sai/hết hạn)
    ));
