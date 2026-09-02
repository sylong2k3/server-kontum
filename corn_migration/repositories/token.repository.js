const db = require('../configs/database');

const saveRefreshToken = async ({ userId, tokenHash, deviceInfo, expiresAt }) => {
    const { rows } = await db.query(
        `INSERT INTO auth.refresh_tokens (user_id, token_hash, device_info, expires_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id, user_id, created_at, expires_at`,
        [userId, tokenHash, JSON.stringify(deviceInfo || {}), expiresAt]
    );
    return rows[0];
};

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

const deleteRefreshToken = async (tokenHash) => {
    const { rowCount } = await db.query(
        `DELETE FROM auth.refresh_tokens WHERE token_hash = $1`,
        [tokenHash]
    );
    return rowCount > 0;
};

const deleteAllUserTokens = async (userId) => {
    const { rowCount } = await db.query(
        `DELETE FROM auth.refresh_tokens WHERE user_id = $1`,
        [userId]
    );
    return rowCount;
};

const revokeRefreshToken = async (tokenHash) => {
    const { rowCount } = await db.query(
        `UPDATE auth.refresh_tokens SET is_revoked = true WHERE token_hash = $1`,
        [tokenHash]
    );
    return rowCount > 0;
};

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

const addToBlacklist = async (jti, expiresAt) => {
    await db.query(
        `INSERT INTO auth.token_blacklist (jti, expires_at)
         VALUES ($1, $2)
         ON CONFLICT (jti) DO NOTHING`,
        [jti, expiresAt]
    );
};

const isBlacklisted = async (jti) => {
    const { rows } = await db.query(
        `SELECT 1 FROM auth.token_blacklist WHERE jti = $1`,
        [jti]
    );
    return rows.length > 0;
};

const savePasswordResetToken = async ({ userId, tokenHash, expiresAt, requestIp }) => {
    const { rows } = await db.query(
        `INSERT INTO auth.password_reset_tokens (user_id, token_hash, expires_at, request_ip)
         VALUES ($1, $2, $3, $4)
         RETURNING id, user_id, expires_at, created_at`,
        [userId, tokenHash, expiresAt, requestIp || null]
    );
    return rows[0];
};

const findValidPasswordResetToken = async (tokenHash) => {
    const { rows } = await db.query(
        `SELECT id, user_id, token_hash, expires_at, used_at, created_at
         FROM auth.password_reset_tokens
         WHERE token_hash = $1
           AND used_at IS NULL
           AND expires_at > NOW()`,
        [tokenHash]
    );
    return rows[0] || null;
};

const markPasswordResetTokenUsed = async (id) => {
    await db.query(
        `UPDATE auth.password_reset_tokens SET used_at = NOW() WHERE id = $1`,
        [id]
    );
};

const invalidateUserResetTokens = async (userId) => {
    const { rowCount } = await db.query(
        `UPDATE auth.password_reset_tokens
         SET used_at = NOW()
         WHERE user_id = $1 AND used_at IS NULL`,
        [userId]
    );
    return rowCount;
};

const countRecentResetRequests = async (userId, withinMinutes = 15) => {
    const { rows } = await db.query(
        `SELECT COUNT(*)::int AS count
         FROM auth.password_reset_tokens
         WHERE user_id = $1
           AND created_at > NOW() - INTERVAL '1 minute' * $2`,
        [userId, withinMinutes]
    );
    return rows[0]?.count || 0;
};

const saveEmailVerificationToken = async ({ userId, tokenHash, expiresAt, requestIp }) => {
    const { rows } = await db.query(
        `INSERT INTO auth.email_verification_tokens (user_id, token_hash, expires_at, request_ip)
         VALUES ($1, $2, $3, $4)
         RETURNING id, user_id, expires_at, created_at`,
        [userId, tokenHash, expiresAt, requestIp || null]
    );
    return rows[0];
};

const findValidEmailVerificationToken = async (tokenHash) => {
    const { rows } = await db.query(
        `SELECT id, user_id, token_hash, expires_at, used_at, created_at
         FROM auth.email_verification_tokens
         WHERE token_hash = $1
           AND used_at IS NULL
           AND expires_at > NOW()`,
        [tokenHash]
    );
    return rows[0] || null;
};

const markEmailVerificationTokenUsed = async (id) => {
    await db.query(
        `UPDATE auth.email_verification_tokens SET used_at = NOW() WHERE id = $1`,
        [id]
    );
};

const invalidateUserEmailVerificationTokens = async (userId) => {
    const { rowCount } = await db.query(
        `UPDATE auth.email_verification_tokens
         SET used_at = NOW()
         WHERE user_id = $1 AND used_at IS NULL`,
        [userId]
    );
    return rowCount;
};

const countRecentEmailVerificationRequests = async (userId, withinMinutes = 15) => {
    const { rows } = await db.query(
        `SELECT COUNT(*)::int AS count
         FROM auth.email_verification_tokens
         WHERE user_id = $1
           AND created_at > NOW() - INTERVAL '1 minute' * $2`,
        [userId, withinMinutes]
    );
    return rows[0]?.count || 0;
};

const saveOAuthExchangeCode = async ({ codeHash, userId, accessToken, refreshToken, isNewUser, expiresAt }) => {
    await db.query(
        `INSERT INTO auth.oauth_exchange_codes
             (code_hash, user_id, access_token, refresh_token, is_new_user, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [codeHash, userId, accessToken, refreshToken, isNewUser || false, expiresAt]
    );
};

const consumeOAuthExchangeCode = async (codeHash) => {
    const { rows } = await db.query(
        `DELETE FROM auth.oauth_exchange_codes
         WHERE code_hash = $1 AND expires_at > NOW()
         RETURNING user_id, access_token, refresh_token, is_new_user`,
        [codeHash]
    );
    return rows[0] || null;
};

const logActivity = async ({ userId, action, status = 'success', ipAddress, userAgent, metadata }) => {
    const { rows } = await db.query(
        `INSERT INTO auth.activity_logs (user_id, action, status, ip_address, user_agent, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, action, status, created_at`,
        [userId || null, action, status, ipAddress || null, userAgent || null, JSON.stringify(metadata || {})]
    );
    return rows[0];
};

const cleanupExpired = async () => {
    const refreshResult = await db.query(
        `DELETE FROM auth.refresh_tokens WHERE expires_at < NOW() OR is_revoked = true`
    );

    const blacklistResult = await db.query(
        `DELETE FROM auth.token_blacklist WHERE expires_at < NOW()`
    );

    const resetResult = await db.query(
        `DELETE FROM auth.password_reset_tokens WHERE expires_at < NOW() OR used_at IS NOT NULL`
    );

    const emailVerifResult = await db.query(
        `DELETE FROM auth.email_verification_tokens WHERE expires_at < NOW() OR used_at IS NOT NULL`
    );

    const oauthCodeResult = await db.query(
        `DELETE FROM auth.oauth_exchange_codes WHERE expires_at < NOW()`
    );

    return {
        refreshDeleted: refreshResult.rowCount,
        blacklistDeleted: blacklistResult.rowCount,
        resetDeleted: resetResult.rowCount,
        emailVerifDeleted: emailVerifResult.rowCount,
        oauthCodeDeleted: oauthCodeResult.rowCount,
    };
};

module.exports = {
    saveRefreshToken,
    findRefreshToken,
    deleteRefreshToken,
    deleteAllUserTokens,
    revokeRefreshToken,
    getUserSessions,

    addToBlacklist,
    isBlacklisted,

    savePasswordResetToken,
    findValidPasswordResetToken,
    markPasswordResetTokenUsed,
    invalidateUserResetTokens,
    countRecentResetRequests,

    saveEmailVerificationToken,
    findValidEmailVerificationToken,
    markEmailVerificationTokenUsed,
    invalidateUserEmailVerificationTokens,
    countRecentEmailVerificationRequests,

    saveOAuthExchangeCode,
    consumeOAuthExchangeCode,

    logActivity,

    cleanupExpired,
};
