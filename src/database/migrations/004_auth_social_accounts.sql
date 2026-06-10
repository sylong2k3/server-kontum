-- ============================================================================
-- Migration 004: Create auth.social_accounts
-- Mục đích: Bảng đăng nhập qua bên thứ 3 (Google, Facebook, GitHub, ...)
--           Tách riêng khỏi auth.users để:
--           1. Hỗ trợ nhiều provider (không chỉ Google)
--           2. 1 user có thể liên kết nhiều tài khoản social
--           3. Lưu trữ thông tin chi tiết từ provider
-- ============================================================================

CREATE TABLE IF NOT EXISTS auth.social_accounts (
    -- ── Khóa chính ──────────────────────────────────────────────────────
    id              BIGSERIAL PRIMARY KEY,

    -- ── Liên kết user ───────────────────────────────────────────────────
    -- User sở hữu tài khoản social này
    user_id         BIGINT NOT NULL
                    REFERENCES auth.users(id) ON DELETE CASCADE,

    -- ── Thông tin Provider ──────────────────────────────────────────────
    -- Tên nhà cung cấp đăng nhập
    -- Mở rộng: thêm 'facebook', 'github', 'apple', ... khi cần
    provider        VARCHAR(30) NOT NULL
                    CHECK (provider IN (
                        'google',
                        'facebook',
                        'github',
                        'apple',
                        'microsoft'
                    )),

    -- ID duy nhất của user trên hệ thống provider
    -- Ví dụ: Google sub claim, Facebook user ID, GitHub user ID
    provider_id     VARCHAR(255) NOT NULL,

    -- ── Thông tin bổ sung từ Provider ───────────────────────────────────
    -- Email từ provider (có thể khác email chính trong auth.users)
    provider_email  VARCHAR(255),

    -- Tên hiển thị từ provider
    provider_name   VARCHAR(255),

    -- Avatar URL từ provider
    provider_avatar TEXT,

    -- ── OAuth Tokens từ Provider ────────────────────────────────────────
    -- Access token nhận từ provider (dùng để gọi API của provider nếu cần)
    -- Encrypt trước khi lưu nếu cần bảo mật cao
    access_token    TEXT,

    -- Refresh token từ provider (để gia hạn access token của provider)
    refresh_token   TEXT,

    -- Thời điểm access token của provider hết hạn
    token_expires_at TIMESTAMPTZ,

    -- ── Dữ liệu thô từ Provider ────────────────────────────────────────
    -- Toàn bộ profile data gốc từ provider (backup/debug)
    -- Ví dụ Google: { sub, name, picture, email, email_verified, locale, ... }
    raw_profile     JSONB DEFAULT '{}',

    -- ── Trạng thái ─────────────────────────────────────────────────────
    -- Liên kết có đang hoạt động không
    -- false = user đã hủy liên kết nhưng giữ lại record để audit
    is_active       BOOLEAN NOT NULL DEFAULT true,

    -- Thời điểm đăng nhập gần nhất qua provider này
    last_used_at    TIMESTAMPTZ,

    -- ── Timestamps ─────────────────────────────────────────────────────
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════
--  CONSTRAINTS
-- ═══════════════════════════════════════════════════════════════════════════

-- 1 provider_id chỉ liên kết với 1 user (1 Google account → 1 user)
ALTER TABLE auth.social_accounts
    DROP CONSTRAINT IF EXISTS uq_social_provider_id;
ALTER TABLE auth.social_accounts
    ADD CONSTRAINT uq_social_provider_id
    UNIQUE (provider, provider_id);

-- 1 user chỉ liên kết 1 tài khoản trên mỗi provider
-- (không cho phép 1 user liên kết 2 Google account khác nhau)
ALTER TABLE auth.social_accounts
    DROP CONSTRAINT IF EXISTS uq_social_user_provider;
ALTER TABLE auth.social_accounts
    ADD CONSTRAINT uq_social_user_provider
    UNIQUE (user_id, provider);

-- ═══════════════════════════════════════════════════════════════════════════
--  INDEXES
-- ═══════════════════════════════════════════════════════════════════════════

-- Tìm nhanh theo provider + provider_id (OAuth callback flow)
CREATE INDEX IF NOT EXISTS idx_social_provider_provider_id
    ON auth.social_accounts (provider, provider_id);

-- Tìm nhanh tất cả social accounts của 1 user
CREATE INDEX IF NOT EXISTS idx_social_user_id
    ON auth.social_accounts (user_id);

-- Lọc chỉ active accounts
CREATE INDEX IF NOT EXISTS idx_social_active
    ON auth.social_accounts (is_active)
    WHERE is_active = true;

-- ═══════════════════════════════════════════════════════════════════════════
--  TRIGGER
-- ═══════════════════════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS trigger_social_accounts_updated_at ON auth.social_accounts;
CREATE TRIGGER trigger_social_accounts_updated_at
    BEFORE UPDATE ON auth.social_accounts
    FOR EACH ROW
    EXECUTE FUNCTION auth.update_updated_at_column();
