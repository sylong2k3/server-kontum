/**
 * Token Repository — Data Access Layer cho auth.refresh_tokens + auth.token_blacklist
 *
 * Quản lý:
 * - Refresh tokens: lưu/tìm/xóa hash refresh token
 * - Token blacklist: blacklist access token JTI khi logout
 * - Activity logs: ghi log hoạt động xác thực
 */

const db = require('../configs/database');

// ═══════════════════════════════════════════════════════════════════════════
//  REFRESH TOKENS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Lưu refresh token (đã hash) vào DB
 * @param {{ userId: number, tokenHash: string, deviceInfo?: object, expiresAt: Date }} data
 * @returns {Promise<object>}
 */
const saveRefreshToken = async ({ userId, tokenHash, deviceInfo, expiresAt }) => {
    const { rows } = await db.query(
        `INSERT INTO auth.refresh_tokens (user_id, token_hash, device_info, expires_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id, user_id, created_at, expires_at`,
        [userId, tokenHash, JSON.stringify(deviceInfo || {}), expiresAt]
    );
    return rows[0];
};

/**
 * Tìm refresh token theo hash (verify khi refresh)
 * @param {string} tokenHash — SHA-256 hash
 * @returns {Promise<object|null>}
 */
const findRefreshToken = async (tokenHash) => {
    const { rows } = await db.query(
        `SELECT id, user_id, token_hash, device_info, expires_at, is_revoked, created_at
         FROM auth.refresh_tokens
         WHERE token_hash = $1
           AND is_revoked = false
           AND expires_at > NOW()`,
        [tokenHash]
    );
    return rows[0] || null;
};

/**
 * Xóa refresh token (logout từ 1 device)
 * @param {string} tokenHash
 * @returns {Promise<boolean>} — true nếu đã xóa
 */
const deleteRefreshToken = async (tokenHash) => {
    const { rowCount } = await db.query(
        `DELETE FROM auth.refresh_tokens WHERE token_hash = $1`,
        [tokenHash]
    );
    return rowCount > 0;
};

/**
 * Xóa TẤT CẢ refresh tokens của user (force-logout tất cả devices)
 * @param {number} userId
 * @returns {Promise<number>} — Số tokens đã xóa
 */
const deleteAllUserTokens = async (userId) => {
    const { rowCount } = await db.query(
        `DELETE FROM auth.refresh_tokens WHERE user_id = $1`,
        [userId]
    );
    return rowCount;
};

/**
 * Revoke refresh token (soft delete — giữ lại record để audit)
 * @param {string} tokenHash
 * @returns {Promise<boolean>}
 */
const revokeRefreshToken = async (tokenHash) => {
    const { rowCount } = await db.query(
        `UPDATE auth.refresh_tokens SET is_revoked = true WHERE token_hash = $1`,
        [tokenHash]
    );
    return rowCount > 0;
};

/**
 * Lấy danh sách sessions (refresh tokens) của user
 * @param {number} userId
 * @returns {Promise<object[]>}
 */
const getUserSessions = async (userId) => {
    const { rows } = await db.query(
        `SELECT id, device_info, created_at, expires_at
         FROM auth.refresh_tokens
         WHERE user_id = $1 AND is_revoked = false AND expires_at > NOW()
         ORDER BY created_at DESC`,
        [userId]
    );
    return rows;
};

// ═══════════════════════════════════════════════════════════════════════════
//  TOKEN BLACKLIST
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Thêm access token JTI vào blacklist (logout)
 * @param {string} jti — JWT ID
 * @param {Date} expiresAt — Thời điểm token hết hạn
 * @returns {Promise<void>}
 */
const addToBlacklist = async (jti, expiresAt) => {
    await db.query(
        `INSERT INTO auth.token_blacklist (jti, expires_at)
         VALUES ($1, $2)
         ON CONFLICT (jti) DO NOTHING`,
        [jti, expiresAt]
    );
};

/**
 * Kiểm tra JTI có trong blacklist không
 * @param {string} jti
 * @returns {Promise<boolean>}
 */
const isBlacklisted = async (jti) => {
    const { rows } = await db.query(
        `SELECT 1 FROM auth.token_blacklist WHERE jti = $1`,
        [jti]
    );
    return rows.length > 0;
};

// ═══════════════════════════════════════════════════════════════════════════
//  ACTIVITY LOGS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Ghi log hoạt động xác thực
 * @param {{ userId?: number, action: string, status?: string, ipAddress?: string, userAgent?: string, metadata?: object }} data
 * @returns {Promise<object>}
 */
const logActivity = async ({ userId, action, status = 'success', ipAddress, userAgent, metadata }) => {
    const { rows } = await db.query(
        `INSERT INTO auth.activity_logs (user_id, action, status, ip_address, user_agent, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, action, status, created_at`,
        [userId || null, action, status, ipAddress || null, userAgent || null, JSON.stringify(metadata || {})]
    );
    return rows[0];
};

// ═══════════════════════════════════════════════════════════════════════════
//  CLEANUP (chạy định kỳ)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Xóa tất cả tokens hết hạn (refresh tokens + blacklist)
 * Chạy qua cron job hoặc khi server idle
 * @returns {Promise<{ refreshDeleted: number, blacklistDeleted: number }>}
 */
const cleanupExpired = async () => {
    const refreshResult = await db.query(
        `DELETE FROM auth.refresh_tokens WHERE expires_at < NOW() OR is_revoked = true`
    );

    const blacklistResult = await db.query(
        `DELETE FROM auth.token_blacklist WHERE expires_at < NOW()`
    );

    return {
        refreshDeleted: refreshResult.rowCount,
        blacklistDeleted: blacklistResult.rowCount,
    };
};

module.exports = {
    // Refresh tokens
    saveRefreshToken,
    findRefreshToken,
    deleteRefreshToken,
    deleteAllUserTokens,
    revokeRefreshToken,
    getUserSessions,

    // Blacklist
    addToBlacklist,
    isBlacklisted,

    // Activity logs
    logActivity,

    // Cleanup
    cleanupExpired,
};
