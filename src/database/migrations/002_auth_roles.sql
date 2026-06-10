-- ============================================================================
-- Migration 002: Create auth.roles
-- Mục đích: Bảng vai trò (role) — 4 vai trò chính của dự án giám sát
--           môi trường tỉnh Kon Tum
-- ============================================================================

CREATE TABLE IF NOT EXISTS auth.roles (
    -- ── Khóa chính ──────────────────────────────────────────────────────
    id              SERIAL PRIMARY KEY,

    -- Mã vai trò (dùng trong code, không thay đổi)
    code            VARCHAR(30) UNIQUE NOT NULL,

    -- ── Tên hiển thị (song ngữ) ─────────────────────────────────────────
    -- Tên tiếng Việt
    name_vi         VARCHAR(100) NOT NULL,
    -- Tên tiếng Anh
    name_en         VARCHAR(100),

    -- ── Mô tả chi tiết (song ngữ) ──────────────────────────────────────
    -- Mô tả tiếng Việt
    description_vi  TEXT,
    -- Mô tả tiếng Anh
    description_en  TEXT,

    -- ── Quyền hạn chi tiết (JSONB flexible) ─────────────────────────────
    -- Lưu danh sách quyền dạng JSON, dễ mở rộng mà không cần migration
    permissions     JSONB NOT NULL DEFAULT '{}',

    -- Thứ tự hiển thị (sort order trong UI)
    sort_order      INT NOT NULL DEFAULT 0,

    -- Role có đang được sử dụng không
    is_active       BOOLEAN NOT NULL DEFAULT true,

    -- ── Timestamps ─────────────────────────────────────────────────────
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Trigger: tự động cập nhật updated_at ────────────────────────────────
CREATE OR REPLACE FUNCTION auth.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_roles_updated_at ON auth.roles;
CREATE TRIGGER trigger_roles_updated_at
    BEFORE UPDATE ON auth.roles
    FOR EACH ROW
    EXECUTE FUNCTION auth.update_updated_at_column();

-- ═══════════════════════════════════════════════════════════════════════════
--  SEED DATA: 4 vai trò chính của dự án
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO auth.roles (code, name_vi, name_en, description_vi, description_en, sort_order)
VALUES
    -- ────────────────────────────────────────────────────────────────────
    -- 1. Quản trị hệ thống — Toàn quyền
    -- ────────────────────────────────────────────────────────────────────
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

    -- ────────────────────────────────────────────────────────────────────
    -- 2. UBND tỉnh — Xem tổng quan, phê duyệt, xuất báo cáo
    -- ────────────────────────────────────────────────────────────────────
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

    -- ────────────────────────────────────────────────────────────────────
    -- 3. Sở NN&MT — Nhập liệu, quản lý trạm, xử lý cảnh báo
    -- ────────────────────────────────────────────────────────────────────
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

    -- ────────────────────────────────────────────────────────────────────
    -- 4. Người dân — Chỉ xem thông tin công khai
    -- ────────────────────────────────────────────────────────────────────
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
