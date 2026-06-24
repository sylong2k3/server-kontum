-- ============================================================================
-- Migration 000: INIT SCHEMA (Consolidated)
-- Gộp toàn bộ migration 001 → 010 thành một file duy nhất, phản ánh trạng thái
-- cuối cùng của schema. Thứ tự: extension → schema → function → roles → users
-- → social_accounts → tokens/logs → reset/oauth → email verification.
--
-- Idempotent: dùng IF NOT EXISTS / DROP ... IF EXISTS để chạy lại an toàn.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
--  1. EXTENSIONS
-- ════════════════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS postgis;


-- ════════════════════════════════════════════════════════════════════════════
--  2. SCHEMAS (namespaces)
-- ════════════════════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS core;   -- Hàm/tiện ích dùng chung toàn hệ thống
CREATE SCHEMA IF NOT EXISTS auth;   -- Xác thực, phân quyền người dùng
CREATE SCHEMA IF NOT EXISTS gis;    -- Dữ liệu không gian / bản đồ
CREATE SCHEMA IF NOT EXISTS fire;   -- Cảnh báo cháy rừng
CREATE SCHEMA IF NOT EXISTS cms;    -- Nội dung / báo cáo
CREATE SCHEMA IF NOT EXISTS field;  -- Dữ liệu hiện trường


-- ════════════════════════════════════════════════════════════════════════════
--  3. SHARED FUNCTION: tự động cập nhật updated_at
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION core.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ════════════════════════════════════════════════════════════════════════════
--  4. auth.roles — Vai trò (4 vai trò chính của dự án Kon Tum)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS auth.roles (
    id              SERIAL PRIMARY KEY,
    code            VARCHAR(30) UNIQUE NOT NULL,
    name_vi         VARCHAR(100) NOT NULL,
    name_en         VARCHAR(100),
    description_vi  TEXT,
    description_en  TEXT,
    permissions     JSONB NOT NULL DEFAULT '{}',
    sort_order      INT NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trigger_roles_updated_at ON auth.roles;
CREATE TRIGGER trigger_roles_updated_at
    BEFORE UPDATE ON auth.roles
    FOR EACH ROW
    EXECUTE FUNCTION core.update_updated_at_column();

-- ── Seed 4 vai trò ─────────────────────────────────────────────────────────
INSERT INTO auth.roles (code, name_vi, name_en, description_vi, description_en, sort_order)
VALUES
    (
        'system_admin',
        'Quản trị hệ thống',
        'System Administrator',
        'Toàn quyền hệ thống — quản lý user, cấu hình hệ thống, quản lý trạm đo, '
        'vùng giám sát, dữ liệu môi trường, cảnh báo, báo cáo. '
        'Có thể xem/sửa/xóa tất cả dữ liệu trong hệ thống.',
        'Full system access — manage users, system configuration, monitoring stations, '
        'zones, environmental data, alerts, and reports. '
        'Can view/edit/delete all data in the system.',
        1
    ),
    (
        'ubnd_tinh',
        'UBND tỉnh',
        'Provincial People''s Committee',
        'Ủy ban Nhân dân tỉnh Kon Tum — xem dashboard tổng quan, '
        'theo dõi tình hình môi trường toàn tỉnh, xem cảnh báo, '
        'xuất báo cáo tổng hợp, phê duyệt kế hoạch ứng phó.',
        'Kon Tum Provincial People''s Committee — view overview dashboard, '
        'monitor province-wide environmental status, view alerts, '
        'export summary reports, approve response plans.',
        2
    ),
    (
        'so_nnmt',
        'Sở Nông nghiệp & Môi trường',
        'Provincial Department of Agriculture & Environment',
        'Sở Nông nghiệp và Môi trường tỉnh Kon Tum — nhập dữ liệu môi trường thủ công, '
        'quản lý trạm đo/sensor IoT, quản lý vùng giám sát, '
        'xử lý và phản hồi cảnh báo, tạo báo cáo chuyên ngành, upload media.',
        'Kon Tum Provincial Department of Agriculture & Environment — manually input environmental data, '
        'manage monitoring stations/IoT sensors, manage monitoring zones, '
        'handle and respond to alerts, create specialized reports, upload media.',
        3
    ),
    (
        'citizen',
        'Người dân',
        'Citizens/Public',
        'Người dân tỉnh Kon Tum — xem bản đồ môi trường, xem chỉ số chất lượng '
        'không khí/nước, nhận cảnh báo công khai (cháy rừng, ô nhiễm), '
        'xem báo cáo tổng hợp đã công bố.',
        'Kon Tum citizens — view environmental maps, air/water quality indices, '
        'receive public alerts (forest fires, pollution), '
        'view published summary reports.',
        4
    )
ON CONFLICT (code) DO NOTHING;


-- ── Seed/cập nhật permissions (JSONB) cho từng vai trò ──────────────────────
-- Cấu trúc: { "<resource>": { "<action>": true } }. Dùng cho middleware
-- requirePermission(resource, action). system_admin được bypass trong code
-- nhưng vẫn seed đầy đủ để nhất quán. Idempotent: luôn set về giá trị mong muốn.
UPDATE auth.roles SET permissions = '{
    "users": {
        "read": true,
        "create": true,
        "update": true,
        "delete": true,
        "read_own": true,
        "update_own": true,
        "reset_password": true,
        "change_role": true,
        "change_status": true
    },
    "roles": { "read": true, "update": true, "manage": true },
    "notifications": {
        "read": true,
        "read_own": true,
        "create": true,
        "update": true,
        "delete": true,
        "delete_own": true,
        "send": true
    },
    "notification_reads": { "read_own": true, "create": true, "update_own": true },
    "device_tokens": { "read": true, "read_own": true, "create_own": true, "delete": true, "delete_own": true },
    "news": { "read": true, "create": true, "update": true, "delete": true, "publish": true },
    "news_translations": { "read": true, "create": true, "update": true, "delete": true },
    "comments": { "read": true, "create": true, "delete": true, "delete_own": true, "approve": true },
    "documents": { "read": true, "create": true, "update": true, "delete": true, "publish": true },
    "document_translations": { "read": true, "create": true, "update": true, "delete": true }
}'::jsonb WHERE code = 'system_admin';

UPDATE auth.roles SET permissions = '{
    "users": { "read": true },
    "notifications": { "read_own": true, "delete_own": true },
    "notification_reads": { "read_own": true, "create": true, "update_own": true },
    "device_tokens": { "read_own": true, "create_own": true, "delete_own": true },
    "news": { "read": true },
    "comments": { "read": true },
    "documents": { "read": true }
}'::jsonb WHERE code = 'ubnd_tinh';

UPDATE auth.roles SET permissions = '{
    "users": {
        "read": true,
        "create": true,
        "update": true,
        "delete": true,
        "reset_password": true,
        "change_status": true
    },
    "notifications": { "read_own": true, "delete_own": true, "send": true },
    "notification_reads": { "read_own": true, "create": true, "update_own": true },
    "device_tokens": { "read_own": true, "create_own": true, "delete_own": true },
    "news": { "read": true, "create": true, "update": true, "delete": true, "publish": true },
    "news_translations": { "read": true, "create": true, "update": true, "delete": true },
    "comments": { "read": true, "delete": true, "approve": true },
    "documents": { "read": true, "create": true, "update": true, "delete": true, "publish": true },
    "document_translations": { "read": true, "create": true, "update": true, "delete": true }
}'::jsonb WHERE code = 'so_nnmt';

UPDATE auth.roles SET permissions = '{
    "users": { "read_own": true, "update_own": true },
    "notifications": { "read_own": true, "delete_own": true },
    "notification_reads": { "read_own": true, "create": true, "update_own": true },
    "device_tokens": { "read_own": true, "create_own": true, "delete_own": true },
    "news": { "read": true },
    "comments": { "read": true, "create": true, "delete_own": true },
    "documents": { "read": true }
}'::jsonb WHERE code = 'citizen';


-- ════════════════════════════════════════════════════════════════════════════
--  5. auth.users — Người dùng hệ thống (đã gộp đủ cột từ MV 003/008/009/010)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS auth.users (
    id                   BIGSERIAL PRIMARY KEY,

    -- Đăng nhập
    -- Không đặt UNIQUE inline: dùng partial unique index theo LOWER(email)
    -- WHERE deleted_at IS NULL (cho phép tạo lại email đã bị soft-delete).
    email                VARCHAR(255) NOT NULL,
    password_hash        VARCHAR(255),               -- NULL nếu chỉ đăng nhập qua social

    -- Thông tin cá nhân
    full_name            VARCHAR(255) NOT NULL,
    phone                VARCHAR(20),
    avatar_url           TEXT,

    -- Phân quyền
    role_id              INT NOT NULL REFERENCES auth.roles(id) ON UPDATE CASCADE,

    -- Trạng thái tài khoản
    is_active            BOOLEAN NOT NULL DEFAULT true,

    -- Xác thực email (MV 008)
    email_verified       BOOLEAN NOT NULL DEFAULT false,
    email_verified_at    TIMESTAMPTZ,

    -- Bảo mật đăng nhập
    login_attempts       INT NOT NULL DEFAULT 0,
    locked_until         TIMESTAMPTZ,
    password_changed_at  TIMESTAMPTZ,
    must_change_password BOOLEAN NOT NULL DEFAULT false,  -- MV 009
    last_login_at        TIMESTAMPTZ,
    last_login_ip        VARCHAR(45),

    -- Soft delete (MV 010)
    deleted_at           TIMESTAMPTZ,

    -- Timestamps
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Default role_id = citizen khi insert không truyền role_id.
-- (PostgreSQL không cho subquery trong DEFAULT, nên dùng trigger BEFORE INSERT.)
CREATE OR REPLACE FUNCTION auth.set_default_user_role()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.role_id IS NULL THEN
        SELECT id INTO NEW.role_id FROM auth.roles WHERE code = 'citizen';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_users_default_role ON auth.users;
CREATE TRIGGER trigger_users_default_role
    BEFORE INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION auth.set_default_user_role();

-- ── Indexes ────────────────────────────────────────────────────────────────
-- Email duy nhất theo LOWER(email), chỉ áp dụng cho user chưa xóa.
-- Vừa đảm bảo unique vừa phục vụ lookup login (findByEmail lọc deleted_at IS NULL).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_email_active
    ON auth.users (LOWER(email)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_role_id         ON auth.users (role_id);
CREATE INDEX IF NOT EXISTS idx_users_is_active       ON auth.users (is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_users_not_deleted     ON auth.users (id) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trigger_users_updated_at ON auth.users;
CREATE TRIGGER trigger_users_updated_at
    BEFORE UPDATE ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION core.update_updated_at_column();


-- ════════════════════════════════════════════════════════════════════════════
--  6. auth.social_accounts — Đăng nhập bên thứ 3 (Google, Facebook, ...)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS auth.social_accounts (
    id               BIGSERIAL PRIMARY KEY,
    user_id          BIGINT NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    provider         VARCHAR(30) NOT NULL
                     CHECK (provider IN ('google', 'facebook', 'github', 'apple', 'microsoft')),
    provider_id      VARCHAR(255) NOT NULL,
    provider_email   VARCHAR(255),
    provider_name    VARCHAR(255),
    provider_avatar  TEXT,

    access_token     TEXT,
    refresh_token    TEXT,
    token_expires_at TIMESTAMPTZ,
    raw_profile      JSONB DEFAULT '{}',

    is_active        BOOLEAN NOT NULL DEFAULT true,
    last_used_at     TIMESTAMPTZ,

    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE auth.social_accounts DROP CONSTRAINT IF EXISTS uq_social_provider_id;
ALTER TABLE auth.social_accounts ADD CONSTRAINT uq_social_provider_id UNIQUE (provider, provider_id);

ALTER TABLE auth.social_accounts DROP CONSTRAINT IF EXISTS uq_social_user_provider;
ALTER TABLE auth.social_accounts ADD CONSTRAINT uq_social_user_provider UNIQUE (user_id, provider);

CREATE INDEX IF NOT EXISTS idx_social_provider_provider_id ON auth.social_accounts (provider, provider_id);
CREATE INDEX IF NOT EXISTS idx_social_user_id              ON auth.social_accounts (user_id);
CREATE INDEX IF NOT EXISTS idx_social_active               ON auth.social_accounts (is_active) WHERE is_active = true;

DROP TRIGGER IF EXISTS trigger_social_accounts_updated_at ON auth.social_accounts;
CREATE TRIGGER trigger_social_accounts_updated_at
    BEFORE UPDATE ON auth.social_accounts
    FOR EACH ROW
    EXECUTE FUNCTION core.update_updated_at_column();


-- ════════════════════════════════════════════════════════════════════════════
--  7. auth.refresh_tokens — Refresh token (lưu hash SHA-256)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    token_hash  VARCHAR(64) NOT NULL,
    device_info JSONB DEFAULT '{}',
    expires_at  TIMESTAMPTZ NOT NULL,
    is_revoked  BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id    ON auth.refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON auth.refresh_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON auth.refresh_tokens (expires_at) WHERE is_revoked = false;


-- ════════════════════════════════════════════════════════════════════════════
--  8. auth.token_blacklist — Blacklist access token theo jti
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS auth.token_blacklist (
    jti        VARCHAR(64) PRIMARY KEY,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_blacklist_expires_at ON auth.token_blacklist (expires_at);


-- ════════════════════════════════════════════════════════════════════════════
--  9. auth.activity_logs — Nhật ký sự kiện auth (CHECK đã gộp toàn bộ action)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS auth.activity_logs (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    action      VARCHAR(50) NOT NULL,
    status      VARCHAR(10) NOT NULL DEFAULT 'success'
                CHECK (status IN ('success', 'failure')),
    ip_address  VARCHAR(45),
    user_agent  TEXT,
    metadata    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tập action đầy đủ (gộp MV 005 + 006 + 008)
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
        'email_verification_sent',
        'email_verified',
        'token_reuse_detected',
        'user_create',
        'user_role_change',
        'user_active_change',
        'user_delete',
        'admin_password_reset'
    ));

CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id        ON auth.activity_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_action_created ON auth.activity_logs (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_ip_action      ON auth.activity_logs (ip_address, action) WHERE action = 'login_failed';


-- ════════════════════════════════════════════════════════════════════════════
--  10. auth.password_reset_tokens — Token quên mật khẩu (lưu hash)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS auth.password_reset_tokens (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    request_ip VARCHAR(45),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_token_hash ON auth.password_reset_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_password_reset_user_id    ON auth.password_reset_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_expires_at ON auth.password_reset_tokens (expires_at);


-- ════════════════════════════════════════════════════════════════════════════
--  11. auth.oauth_exchange_codes — Mã 1 lần đổi token sau OAuth
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS auth.oauth_exchange_codes (
    code_hash     VARCHAR(64) PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    access_token  TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    is_new_user   BOOLEAN NOT NULL DEFAULT false,
    expires_at    TIMESTAMPTZ NOT NULL,
    used_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires_at ON auth.oauth_exchange_codes (expires_at);


-- ════════════════════════════════════════════════════════════════════════════
--  12. auth.email_verification_tokens — Token xác minh email (lưu hash)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS auth.email_verification_tokens (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    request_ip VARCHAR(45),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_verif_token_hash ON auth.email_verification_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_email_verif_user_id    ON auth.email_verification_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_email_verif_expires_at ON auth.email_verification_tokens (expires_at);
