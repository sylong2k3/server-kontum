-- ============================================================================
-- Migration 008: Email verification (xác thực email khi đăng ký)
-- Mục đích:
--   1. Thêm cột email_verified / email_verified_at vào auth.users
--   2. Bảng auth.email_verification_tokens (token xác minh, lưu hash)
--   3. Cập nhật CHECK constraint auth.activity_logs (thêm action mới)
--   4. Đánh dấu user hiện hữu là đã xác thực (tránh khóa người đang dùng)
-- ============================================================================

-- ── 1. Cột trạng thái xác thực email ───────────────────────────────────────
ALTER TABLE auth.users
    ADD COLUMN IF NOT EXISTS email_verified     BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS email_verified_at  TIMESTAMPTZ;

-- Người dùng đã tồn tại trước migration → coi như đã xác thực (không khóa họ)
UPDATE auth.users
   SET email_verified = true,
       email_verified_at = COALESCE(email_verified_at, NOW())
 WHERE email_verified = false;


-- ── 2. Bảng token xác minh email ───────────────────────────────────────────
-- Token gốc chỉ gửi qua email; DB chỉ lưu hash SHA-256. Dùng 1 lần, ngắn hạn.
CREATE TABLE IF NOT EXISTS auth.email_verification_tokens (
    id            BIGSERIAL PRIMARY KEY,

    user_id       BIGINT NOT NULL
                  REFERENCES auth.users(id) ON DELETE CASCADE,

    token_hash    VARCHAR(64) NOT NULL,

    expires_at    TIMESTAMPTZ NOT NULL,
    used_at       TIMESTAMPTZ,
    request_ip    VARCHAR(45),

    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_verif_token_hash
    ON auth.email_verification_tokens (token_hash);

CREATE INDEX IF NOT EXISTS idx_email_verif_user_id
    ON auth.email_verification_tokens (user_id);

CREATE INDEX IF NOT EXISTS idx_email_verif_expires_at
    ON auth.email_verification_tokens (expires_at);


-- ── 3. Cập nhật CHECK constraint cho auth.activity_logs ─────────────────────
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
        'password_reset_request',
        'password_reset',
        'password_reset_failed',
        'email_verification_sent',  -- Gửi email xác minh
        'email_verified',           -- Xác minh email thành công
        'token_reuse_detected'      -- Phát hiện refresh token bị dùng lại (nghi đánh cắp)
    ));
