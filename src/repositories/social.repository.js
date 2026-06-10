/**
 * Social Repository — Data Access Layer cho bảng auth.social_accounts
 *
 * Quản lý đăng nhập qua bên thứ 3: Google, Facebook, GitHub, Apple, Microsoft
 * 1 user có thể liên kết nhiều provider, nhưng mỗi provider chỉ 1 account.
 */

const db = require('../configs/database');

/**
 * Tìm social account theo provider + provider_id
 * (Dùng trong OAuth callback — tìm user đã liên kết provider này chưa)
 *
 * @param {string} provider — 'google', 'facebook', 'github', ...
 * @param {string} providerId — ID từ provider
 * @returns {Promise<object|null>}
 */
const findByProviderId = async (provider, providerId) => {
    const { rows } = await db.query(
        `SELECT sa.id, sa.user_id, sa.provider, sa.provider_id,
                sa.provider_email, sa.provider_name, sa.provider_avatar,
                sa.is_active, sa.last_used_at, sa.created_at
         FROM auth.social_accounts sa
         WHERE sa.provider = $1 AND sa.provider_id = $2 AND sa.is_active = true`,
        [provider, providerId]
    );
    return rows[0] || null;
};

/**
 * Tìm tất cả social accounts của 1 user
 * @param {number} userId
 * @returns {Promise<object[]>}
 */
const findByUserId = async (userId) => {
    const { rows } = await db.query(
        `SELECT id, provider, provider_id, provider_email, provider_name,
                provider_avatar, is_active, last_used_at, created_at
         FROM auth.social_accounts
         WHERE user_id = $1
         ORDER BY created_at DESC`,
        [userId]
    );
    return rows;
};

/**
 * Tạo liên kết social account mới
 *
 * @param {{
 *   userId: number,
 *   provider: string,
 *   providerId: string,
 *   providerEmail?: string,
 *   providerName?: string,
 *   providerAvatar?: string,
 *   accessToken?: string,
 *   refreshToken?: string,
 *   tokenExpiresAt?: Date,
 *   rawProfile?: object
 * }} data
 * @returns {Promise<object>}
 */
const create = async (data) => {
    const { rows } = await db.query(
        `INSERT INTO auth.social_accounts
             (user_id, provider, provider_id, provider_email, provider_name,
              provider_avatar, access_token, refresh_token, token_expires_at,
              raw_profile, last_used_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
         RETURNING id, user_id, provider, provider_id, provider_email,
                   provider_name, provider_avatar, is_active, created_at`,
        [
            data.userId,
            data.provider,
            data.providerId,
            data.providerEmail || null,
            data.providerName || null,
            data.providerAvatar || null,
            data.accessToken || null,
            data.refreshToken || null,
            data.tokenExpiresAt || null,
            JSON.stringify(data.rawProfile || {}),
        ]
    );
    return rows[0];
};

/**
 * Cập nhật thông tin social account (khi user login lại qua provider)
 *
 * @param {string} provider
 * @param {string} providerId
 * @param {{ providerEmail?: string, providerName?: string, providerAvatar?: string, accessToken?: string, refreshToken?: string, tokenExpiresAt?: Date, rawProfile?: object }} data
 * @returns {Promise<object|null>}
 */
const updateByProviderId = async (provider, providerId, data) => {
    const { rows } = await db.query(
        `UPDATE auth.social_accounts
         SET provider_email = COALESCE($3, provider_email),
             provider_name = COALESCE($4, provider_name),
             provider_avatar = COALESCE($5, provider_avatar),
             access_token = COALESCE($6, access_token),
             refresh_token = COALESCE($7, refresh_token),
             token_expires_at = COALESCE($8, token_expires_at),
             raw_profile = COALESCE($9, raw_profile),
             last_used_at = NOW()
         WHERE provider = $1 AND provider_id = $2
         RETURNING id, user_id, provider, provider_id, provider_email,
                   provider_name, provider_avatar, last_used_at`,
        [
            provider,
            providerId,
            data.providerEmail || null,
            data.providerName || null,
            data.providerAvatar || null,
            data.accessToken || null,
            data.refreshToken || null,
            data.tokenExpiresAt || null,
            data.rawProfile ? JSON.stringify(data.rawProfile) : null,
        ]
    );
    return rows[0] || null;
};

/**
 * Hủy liên kết social account (soft delete)
 * @param {number} userId
 * @param {string} provider
 * @returns {Promise<boolean>}
 */
const unlinkProvider = async (userId, provider) => {
    const { rowCount } = await db.query(
        `UPDATE auth.social_accounts
         SET is_active = false
         WHERE user_id = $1 AND provider = $2`,
        [userId, provider]
    );
    return rowCount > 0;
};

/**
 * Kiểm tra user đã liên kết provider nào chưa
 * @param {number} userId
 * @param {string} provider
 * @returns {Promise<boolean>}
 */
const hasProvider = async (userId, provider) => {
    const { rows } = await db.query(
        `SELECT 1 FROM auth.social_accounts
         WHERE user_id = $1 AND provider = $2 AND is_active = true`,
        [userId, provider]
    );
    return rows.length > 0;
};

module.exports = {
    findByProviderId,
    findByUserId,
    create,
    updateByProviderId,
    unlinkProvider,
    hasProvider,
};
