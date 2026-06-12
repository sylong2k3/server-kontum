-- ============================================================================
-- Migration 001: NOTIFICATIONS (thông báo đa nền tảng: web + Android + iOS)
-- Đặt trong schema `core` vì thông báo là mối quan tâm xuyên suốt mọi domain
-- (fire / field / cms / auth ...). Nguồn dữ liệu "nguồn sự thật" để đảm bảo
-- không mất thông báo dù realtime/push thất bại.
--
-- Idempotent: dùng IF NOT EXISTS / DROP ... IF EXISTS để chạy lại an toàn.
-- Phụ thuộc: 000_init_schema.sql (schema core, auth.users, hàm core.update_updated_at_column).
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
--  1. core.notifications — Bản ghi thông báo (nguồn sự thật)
--     - user_id NOT NULL  → thông báo cá nhân gửi tới 1 người.
--     - user_id NULL       → thông báo phát rộng (broadcast) theo audience.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS core.notifications (
    id            BIGSERIAL PRIMARY KEY,

    -- Người nhận. NULL = broadcast (xác định đối tượng qua audience/audience_role).
    user_id       BIGINT REFERENCES auth.users(id) ON DELETE CASCADE,

    -- Phạm vi phát: 'user' (cá nhân) | 'all' (mọi người) | 'role' (theo vai trò)
    audience      VARCHAR(10) NOT NULL DEFAULT 'user'
                  CHECK (audience IN ('user', 'all', 'role')),
    audience_role VARCHAR(30),                 -- chỉ dùng khi audience = 'role'

    -- Phân loại để client lọc/điều hướng (khớp channel WebSocket & FCM topic)
    channel       VARCHAR(50) NOT NULL DEFAULT 'system',  -- 'fire' | 'field' | 'news' | 'system'...
    type          VARCHAR(50) NOT NULL,        -- mã sự kiện: 'fire_warning', 'feedback_status'...

    -- Nội dung hiển thị
    title         VARCHAR(255) NOT NULL,
    body          TEXT,
    data          JSONB NOT NULL DEFAULT '{}', -- payload kèm theo (id liên quan, deep-link...)

    -- Vòng đời
    expires_at    TIMESTAMPTZ,                 -- NULL = không hết hạn
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
    ON core.notifications (user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_broadcast_created
    ON core.notifications (audience, created_at DESC) WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_channel
    ON core.notifications (channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_expires
    ON core.notifications (expires_at) WHERE expires_at IS NOT NULL;


-- ════════════════════════════════════════════════════════════════════════════
--  2. core.notification_reads — Trạng thái đã đọc (đồng bộ đa thiết bị)
--     Áp dụng cho cả thông báo cá nhân lẫn broadcast. Một dòng = 1 user đã đọc
--     1 notification. Không có dòng = chưa đọc.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS core.notification_reads (
    notification_id BIGINT NOT NULL REFERENCES core.notifications(id) ON DELETE CASCADE,
    user_id         BIGINT NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    read_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (notification_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_reads_user
    ON core.notification_reads (user_id);


-- ════════════════════════════════════════════════════════════════════════════
--  3. core.device_tokens — Token đẩy push theo thiết bị (FCM)
--     Mỗi user có thể đăng nhập nhiều thiết bị (web, android, ios).
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS core.device_tokens (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    token        TEXT NOT NULL,               -- FCM registration token
    platform     VARCHAR(10) NOT NULL
                 CHECK (platform IN ('web', 'android', 'ios')),
    device_info  JSONB NOT NULL DEFAULT '{}', -- model, os version, app version...

    is_active    BOOLEAN NOT NULL DEFAULT true,
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Một token là duy nhất toàn hệ thống (gắn lại cho user mới nhất khi đổi tài khoản).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_device_token ON core.device_tokens (token);
CREATE INDEX IF NOT EXISTS idx_device_tokens_user
    ON core.device_tokens (user_id) WHERE is_active = true;

DROP TRIGGER IF EXISTS trigger_device_tokens_updated_at ON core.device_tokens;
CREATE TRIGGER trigger_device_tokens_updated_at
    BEFORE UPDATE ON core.device_tokens
    FOR EACH ROW
    EXECUTE FUNCTION core.update_updated_at_column();
