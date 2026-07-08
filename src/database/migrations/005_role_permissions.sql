-- ============================================================================
-- Migration 005: ROLE PERMISSIONS (RBAC for implemented resources)
-- Chuẩn hóa permissions JSONB theo các bảng/API đã hiện thực: auth, core, cms.
--
-- Idempotent: luôn cập nhật auth.roles.permissions về bộ quyền mong muốn.
-- ============================================================================

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
    "news": { "read": true, "create": true, "publish": true },
    "news_translations": { "read": true, "create": true },
    "comments": { "read": true },
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
