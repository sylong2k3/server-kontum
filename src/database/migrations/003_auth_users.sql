-- ============================================================================
-- Migration 003: Create auth.users
-- Mục đích: Bảng người dùng hệ thống
--           role_id FK → auth.roles (thay vì CHECK constraint)
--           Không chứa thông tin đăng nhập bên thứ 3 (tách sang 004)
-- ============================================================================

CREATE TABLE IF NOT EXISTS auth.users (
    -- ── Khóa chính ──────────────────────────────────────────────────────
    id              BIGSERIAL PRIMARY KEY,

    -- ── Thông tin đăng nhập ─────────────────────────────────────────────
    -- Email là định danh duy nhất cho mỗi tài khoản
    email           VARCHAR(255) UNIQUE NOT NULL,

    -- Hash mật khẩu (bcrypt, ~60 ký tự)
    -- NULL khi user chỉ đăng nhập qua bên thứ 3 (Google, Facebook, ...)
    password_hash   VARCHAR(255),

    -- ── Thông tin cá nhân ───────────────────────────────────────────────
    full_name       VARCHAR(255) NOT NULL,
    phone           VARCHAR(20),
    avatar_url      TEXT,

    -- ── Phân quyền ─────────────────────────────────────────────────────
    -- FK đến bảng auth.roles
    -- Mặc định = role 'viewer' (id sẽ được set qua subquery)
    role_id         INT NOT NULL
                    REFERENCES auth.roles(id) ON UPDATE CASCADE,

    -- Tài khoản có đang hoạt động không
    -- false = tài khoản bị khóa/vô hiệu hóa bởi admin
    is_active       BOOLEAN NOT NULL DEFAULT true,

    -- ── Bảo mật ────────────────────────────────────────────────────────
    -- Số lần đăng nhập sai liên tiếp (reset về 0 khi đăng nhập thành công)
    login_attempts  INT NOT NULL DEFAULT 0,

    -- Thời điểm bị khóa tạm do nhập sai quá nhiều lần
    -- NULL = không bị khóa
    locked_until    TIMESTAMPTZ,

    -- Thời điểm đổi mật khẩu gần nhất
    password_changed_at TIMESTAMPTZ,

    -- Thời điểm đăng nhập gần nhất (bất kỳ phương thức nào)
    last_login_at   TIMESTAMPTZ,

    -- IP đăng nhập gần nhất
    last_login_ip   VARCHAR(45),

    -- ── Timestamps ─────────────────────────────────────────────────────
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Set default role_id = citizen (Người dân) ──────────────────────────
-- Dùng ALTER vì DEFAULT cần subquery, không hỗ trợ inline trong CREATE TABLE
ALTER TABLE auth.users
    ALTER COLUMN role_id SET DEFAULT (SELECT id FROM auth.roles WHERE code = 'citizen');

-- ── Indexes ─────────────────────────────────────────────────────────────

-- Tìm kiếm nhanh theo email (login flow)
CREATE INDEX IF NOT EXISTS idx_users_email
    ON auth.users (email);

-- Lọc user theo role (admin panel, phân quyền)
CREATE INDEX IF NOT EXISTS idx_users_role_id
    ON auth.users (role_id);

-- Lọc user đang active
CREATE INDEX IF NOT EXISTS idx_users_is_active
    ON auth.users (is_active)
    WHERE is_active = true;

-- ── Trigger: tự động cập nhật updated_at ────────────────────────────────
DROP TRIGGER IF EXISTS trigger_users_updated_at ON auth.users;
CREATE TRIGGER trigger_users_updated_at
    BEFORE UPDATE ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION auth.update_updated_at_column();
