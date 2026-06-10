-- ============================================================================
-- Migration 005: Create auth token tables
-- Mục đích: Quản lý refresh tokens, blacklist access tokens, activity logs
-- ============================================================================


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │  Bảng 1: auth.refresh_tokens                                           │
-- │  Lưu hash của refresh token — cho phép revoke theo device/session       │
-- │                                                                         │
-- │  Flow:                                                                  │
-- │  1. User login → server tạo refresh token → hash (SHA-256) → lưu DB    │
-- │  2. User gửi refresh token → server hash lại → tìm trong DB → verify   │
-- │  3. User logout → xóa record → refresh token không dùng được nữa       │
-- └──────────────────────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
    id            BIGSERIAL PRIMARY KEY,

    -- User sở hữu token này
    user_id       BIGINT NOT NULL
                  REFERENCES auth.users(id) ON DELETE CASCADE,

    -- SHA-256 hash của refresh token (không lưu token gốc vì lý do bảo mật)
    -- Khi user gửi refresh token, server hash lại rồi so sánh
    token_hash    VARCHAR(64) NOT NULL,

    -- Thông tin thiết bị/trình duyệt (để user quản lý sessions)
    -- Ví dụ: { "browser": "Chrome", "os": "Windows", "ip": "1.2.3.4" }
    device_info   JSONB DEFAULT '{}',

    -- Thời điểm token hết hạn (theo JWT_REFRESH_EXPIRES_IN trong .env)
    expires_at    TIMESTAMPTZ NOT NULL,

    -- Token đã bị thu hồi chưa (dùng khi admin force-logout user)
    is_revoked    BOOLEAN NOT NULL DEFAULT false,

    -- Thời điểm tạo
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tìm nhanh tất cả tokens của 1 user (quản lý sessions, force-logout)
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id
    ON auth.refresh_tokens (user_id);

-- Tìm nhanh theo hash (verify refresh token khi refresh)
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash
    ON auth.refresh_tokens (token_hash);

-- Dọn dẹp tokens hết hạn (cleanup job)
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at
    ON auth.refresh_tokens (expires_at)
    WHERE is_revoked = false;


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │  Bảng 2: auth.token_blacklist                                           │
-- │  Blacklist access tokens khi user logout trước khi token hết hạn        │
-- │                                                                         │
-- │  Flow:                                                                  │
-- │  1. User logout → server lấy jti (JWT ID) từ access token              │
-- │  2. Lưu jti + expires_at vào blacklist                                 │
-- │  3. Mỗi request → middleware check jti có trong blacklist không         │
-- │  4. Cleanup job xóa records đã hết hạn (không cần giữ lại)            │
-- └──────────────────────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS auth.token_blacklist (
    -- JWT ID (UUID v4) — unique identifier cho mỗi access token
    jti         VARCHAR(64) PRIMARY KEY,

    -- Thời điểm access token hết hạn
    -- Sau thời điểm này, record có thể xóa vì token đã hết hạn tự nhiên
    expires_at  TIMESTAMPTZ NOT NULL,

    -- Thời điểm blacklist (để audit)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Dọn dẹp blacklist entries đã hết hạn
CREATE INDEX IF NOT EXISTS idx_token_blacklist_expires_at
    ON auth.token_blacklist (expires_at);


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │  Bảng 3: auth.activity_logs                                             │
-- │  Ghi lại tất cả sự kiện auth quan trọng để audit/bảo mật               │
-- └──────────────────────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS auth.activity_logs (
    id          BIGSERIAL PRIMARY KEY,

    -- User thực hiện hành động (NULL nếu chưa xác thực, ví dụ login fail)
    user_id     BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,

    -- Loại sự kiện
    action      VARCHAR(50) NOT NULL
                CHECK (action IN (
                    'register',           -- Đăng ký tài khoản mới
                    'login',              -- Đăng nhập thành công
                    'login_failed',       -- Đăng nhập thất bại
                    'logout',             -- Đăng xuất
                    'refresh_token',      -- Gia hạn token
                    'change_password',    -- Đổi mật khẩu
                    'social_login',       -- Đăng nhập qua bên thứ 3
                    'social_link',        -- Liên kết tài khoản bên thứ 3
                    'social_unlink',      -- Hủy liên kết tài khoản bên thứ 3
                    'account_locked',     -- Tài khoản bị khóa tạm
                    'account_unlocked',   -- Tài khoản được mở khóa
                    'force_logout'        -- Admin force-logout user
                )),

    -- Kết quả: thành công hay thất bại
    status      VARCHAR(10) NOT NULL DEFAULT 'success'
                CHECK (status IN ('success', 'failure')),

    -- IP address của request
    ip_address  VARCHAR(45),

    -- User-Agent string
    user_agent  TEXT,

    -- Dữ liệu bổ sung (ví dụ: lý do thất bại, provider, email)
    metadata    JSONB DEFAULT '{}',

    -- Thời điểm xảy ra
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tìm nhanh logs theo user
CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id
    ON auth.activity_logs (user_id);

-- Tìm nhanh theo loại sự kiện + thời gian (audit query)
CREATE INDEX IF NOT EXISTS idx_activity_logs_action_created
    ON auth.activity_logs (action, created_at DESC);

-- Lọc login failures theo IP (chống brute-force)
CREATE INDEX IF NOT EXISTS idx_activity_logs_ip_action
    ON auth.activity_logs (ip_address, action)
    WHERE action = 'login_failed';
