/**
 * User Repository — Data Access Layer cho bảng auth.users + auth.roles
 *
 * Schema mới:
 * - auth.roles: bảng vai trò (code, name_vi, name_en, permissions)
 * - auth.users: FK role_id → auth.roles
 * - auth.social_accounts: tách riêng (xem social.repository.js)
 */

const db = require('../configs/database');

// ═══════════════════════════════════════════════════════════════════════════
//  USER QUERIES
// ═══════════════════════════════════════════════════════════════════════════

// Chuỗi SELECT chung — JOIN roles để lấy role code + name
const USER_SELECT = `
    SELECT u.id, u.email, u.password_hash, u.full_name, u.phone, u.avatar_url,
           u.role_id, r.code AS role, r.name_vi AS role_name_vi, r.name_en AS role_name_en, r.permissions AS role_permissions,
           u.is_active, u.login_attempts, u.locked_until,
           u.password_changed_at, u.last_login_at, u.last_login_ip,
           u.created_at, u.updated_at
    FROM auth.users u
    INNER JOIN auth.roles r ON u.role_id = r.id
`;

/**
 * Tìm user theo ID
 * @param {number} id
 * @returns {Promise<object|null>}
 */
const findById = async (id) => {
    const { rows } = await db.query(
        `${USER_SELECT} WHERE u.id = $1`,
        [id]
    );
    return rows[0] || null;
};

/**
 * Tìm user theo email
 * @param {string} email
 * @returns {Promise<object|null>}
 */
const findByEmail = async (email) => {
    const { rows } = await db.query(
        `${USER_SELECT} WHERE LOWER(u.email) = LOWER($1)`,
        [email]
    );
    return rows[0] || null;
};

/**
 * Tạo user mới
 * @param {{ email: string, passwordHash?: string, fullName: string, phone?: string, roleCode?: string, avatarUrl?: string }} data
 * @returns {Promise<object>} — User vừa tạo (kèm role info)
 */
const create = async ({ email, passwordHash, fullName, phone, roleCode = 'citizen', avatarUrl }) => {
    const { rows } = await db.query(
        `INSERT INTO auth.users (email, password_hash, full_name, phone, avatar_url, role_id)
         VALUES (
             $1, $2, $3, $4, $5,
             (SELECT id FROM auth.roles WHERE code = $6)
         )
         RETURNING id, email, full_name, phone, avatar_url, role_id, is_active, created_at, updated_at`,
        [email, passwordHash || null, fullName, phone || null, avatarUrl || null, roleCode]
    );

    // Fetch lại kèm role info
    if (rows[0]) {
        return findById(rows[0].id);
    }
    return rows[0];
};

/**
 * Cập nhật password
 * @param {number} userId
 * @param {string} newPasswordHash
 * @returns {Promise<object>}
 */
const updatePassword = async (userId, newPasswordHash) => {
    const { rows } = await db.query(
        `UPDATE auth.users
         SET password_hash = $2, password_changed_at = NOW()
         WHERE id = $1
         RETURNING id, email, full_name, password_changed_at, updated_at`,
        [userId, newPasswordHash]
    );
    return rows[0] || null;
};

/**
 * Cập nhật thông tin đăng nhập thành công
 * (reset login_attempts, ghi last_login)
 * @param {number} userId
 * @param {string} ipAddress
 */
const updateLoginSuccess = async (userId, ipAddress) => {
    await db.query(
        `UPDATE auth.users
         SET login_attempts = 0, locked_until = NULL,
             last_login_at = NOW(), last_login_ip = $2
         WHERE id = $1`,
        [userId, ipAddress]
    );
};

/**
 * Tăng số lần đăng nhập sai + lock nếu vượt ngưỡng
 * @param {number} userId
 * @param {number} maxAttempts — Mặc định: 5
 * @param {number} lockMinutes — Mặc định: 15
 * @returns {Promise<{ login_attempts: number, locked_until: Date|null }>}
 */
const incrementLoginAttempts = async (userId, maxAttempts = 5, lockMinutes = 15) => {
    const { rows } = await db.query(
        `UPDATE auth.users
         SET login_attempts = login_attempts + 1,
             locked_until = CASE
                 WHEN login_attempts + 1 >= $2
                 THEN NOW() + INTERVAL '${lockMinutes} minutes'
                 ELSE locked_until
             END
         WHERE id = $1
         RETURNING login_attempts, locked_until`,
        [userId, maxAttempts]
    );
    return rows[0] || null;
};

/**
 * Cập nhật avatar
 * @param {number} userId
 * @param {string} avatarUrl
 */
const updateAvatar = async (userId, avatarUrl) => {
    await db.query(
        `UPDATE auth.users SET avatar_url = $2 WHERE id = $1`,
        [userId, avatarUrl]
    );
};

/**
 * Lấy thông tin user an toàn (không có password_hash) — cho endpoint /me
 * @param {number} userId
 * @returns {Promise<object|null>}
 */
const findByIdSafe = async (userId) => {
    const { rows } = await db.query(
        `SELECT u.id, u.email, u.full_name, u.phone, u.avatar_url,
                u.role_id, r.code AS role, r.name_vi AS role_name_vi, r.name_en AS role_name_en, r.permissions AS role_permissions,
                u.is_active, u.last_login_at, u.created_at, u.updated_at,
                (
                    SELECT json_agg(json_build_object(
                        'provider', sa.provider,
                        'provider_email', sa.provider_email,
                        'linked_at', sa.created_at
                    ))
                    FROM auth.social_accounts sa
                    WHERE sa.user_id = u.id AND sa.is_active = true
                ) AS social_accounts
         FROM auth.users u
         INNER JOIN auth.roles r ON u.role_id = r.id
         WHERE u.id = $1`,
        [userId]
    );
    return rows[0] || null;
};

// ═══════════════════════════════════════════════════════════════════════════
//  ROLE QUERIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Lấy role theo code
 * @param {string} code — 'admin', 'editor', 'viewer'
 * @returns {Promise<object|null>}
 */
const findRoleByCode = async (code) => {
    const { rows } = await db.query(
        `SELECT id, code, name_vi, name_en, description_vi, description_en, permissions, sort_order, is_active
         FROM auth.roles WHERE code = $1`,
        [code]
    );
    return rows[0] || null;
};

/**
 * Lấy tất cả roles
 * @returns {Promise<object[]>}
 */
const findAllRoles = async () => {
    const { rows } = await db.query(
        `SELECT id, code, name_vi, name_en, description_vi, description_en, permissions, sort_order, is_active
         FROM auth.roles
         WHERE is_active = true
         ORDER BY sort_order ASC`
    );
    return rows;
};

module.exports = {
    findById,
    findByEmail,
    create,
    updatePassword,
    updateLoginSuccess,
    incrementLoginAttempts,
    updateAvatar,
    findByIdSafe,
    findRoleByCode,
    findAllRoles,
};
