const db = require('../configs/database');

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

const unlinkProvider = async (userId, provider) => {
    const { rowCount } = await db.query(
        `UPDATE auth.social_accounts
         SET is_active = false
         WHERE user_id = $1 AND provider = $2`,
        [userId, provider]
    );
    return rowCount > 0;
};

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
