/**
 * Auth Service — Business Logic Layer cho xác thực
 *
 * Xử lý tất cả logic nghiệp vụ:
 * - Đăng ký tài khoản mới (email/password)
 * - Đăng nhập (email/password)
 * - Refresh access token
 * - Logout (blacklist + revoke)
 * - Đổi mật khẩu
 * - Google OAuth callback
 * - Lấy thông tin user hiện tại
 */

const userRepository = require('../repositories/user.repository');
const tokenRepository = require('../repositories/token.repository');
const socialRepository = require('../repositories/social.repository');
const { hashPassword, comparePassword, hashToken } = require('../utils/cryptoHelper');
const { generateTokenPair, generateAccessToken, verifyRefreshToken } = require('../utils/tokenManager');
const { Api400Error, Api401Error, Api409Error, Api404Error } = require('../core/error.response');
const { t } = require('../utils/i18n');

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

const register = async ({ email, password, fullName, phone }, context = {}) => {
    // 1. Kiểm tra email trùng
    const existingUser = await userRepository.findByEmail(email);
    if (existingUser) {
        throw new Api409Error(t('email_in_use', context.lang));
    }

    // 2. Hash mật khẩu
    const passwordHash = await hashPassword(password);

    // 3. Tạo user
    const user = await userRepository.create({
        email,
        passwordHash,
        fullName,
        phone,
    });

    // 4. Tạo tokens
    const tokens = generateTokenPair({
        userId: user.id,
        email: user.email,
        role: user.role,
    });

    // 5. Lưu refresh token hash
    const refreshTokenHash = hashToken(tokens.refreshToken);
    await tokenRepository.saveRefreshToken({
        userId: user.id,
        tokenHash: refreshTokenHash,
        deviceInfo: _buildDeviceInfo(context),
        expiresAt: tokens.refreshExpiresAt,
    });

    // 6. Cập nhật last login
    await userRepository.updateLoginSuccess(user.id, context.ipAddress);

    // 7. Log activity
    await _logActivity(user.id, 'register', 'success', context);

    return {
        user: _sanitizeUser(user, context.lang),
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
    };
};

/**
 * Đăng nhập bằng email/password
 *
 * Flow:
 * 1. Tìm user theo email
 * 2. Kiểm tra tài khoản active + không bị lock
 * 3. So sánh mật khẩu
 * 4. Reset login attempts + cập nhật last login
 * 5. Tạo tokens + lưu refresh token
 * 6. Log activity
 *
 * @param {{ email: string, password: string }} data
 * @param {{ ipAddress?: string, userAgent?: string }} context
 * @returns {Promise<{ user: object, accessToken: string, refreshToken: string }>}
 */
const login = async ({ email, password }, context = {}) => {
    // 1. Tìm user
    const user = await userRepository.findByEmail(email);
    if (!user) {
        // Log login failure (không có userId)
        await _logActivity(null, 'login_failed', 'failure', context, { email });
        throw new Api401Error(t('incorrect_credentials', context.lang));
    }

    // 2. Kiểm tra tài khoản
    if (!user.is_active) {
        await _logActivity(user.id, 'login_failed', 'failure', context, { reason: 'account_inactive' });
        throw new Api401Error(t('account_disabled', context.lang));
    }

    // Kiểm tra lock
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
        const remainingMinutes = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
        await _logActivity(user.id, 'login_failed', 'failure', context, { reason: 'account_locked' });
        throw new Api401Error(
            t('account_locked_mins', context.lang, { mins: remainingMinutes })
        );
    }

    // 3. Kiểm tra password
    if (!user.password_hash) {
        throw new Api401Error(t('google_only', context.lang));
    }

    const isPasswordValid = await comparePassword(password, user.password_hash);
    if (!isPasswordValid) {
        // Tăng login attempts
        const result = await userRepository.incrementLoginAttempts(user.id, MAX_LOGIN_ATTEMPTS, LOCK_MINUTES);
        const attemptsLeft = MAX_LOGIN_ATTEMPTS - (result?.login_attempts || 0);

        await _logActivity(user.id, 'login_failed', 'failure', context, {
            reason: 'wrong_password',
            attemptsLeft,
        });

        if (result?.locked_until) {
            await _logActivity(user.id, 'account_locked', 'success', context);
            throw new Api401Error(
                t('account_locked_limit', context.lang, { mins: LOCK_MINUTES, attempts: MAX_LOGIN_ATTEMPTS })
            );
        }

        throw new Api401Error(
            attemptsLeft > 0
                ? t('incorrect_credentials_attempts', context.lang, { attempts: attemptsLeft })
                : t('incorrect_credentials', context.lang)
        );
    }

    // 4. Reset login attempts + cập nhật last login
    await userRepository.updateLoginSuccess(user.id, context.ipAddress);

    // 5. Tạo tokens
    const tokens = generateTokenPair({
        userId: user.id,
        email: user.email,
        role: user.role,
    });

    const refreshTokenHash = hashToken(tokens.refreshToken);
    await tokenRepository.saveRefreshToken({
        userId: user.id,
        tokenHash: refreshTokenHash,
        deviceInfo: _buildDeviceInfo(context),
        expiresAt: tokens.refreshExpiresAt,
    });

    // 6. Log activity
    await _logActivity(user.id, 'login', 'success', context);

    return {
        user: _sanitizeUser(user, context.lang),
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
    };
};

/**
 * Refresh access token
 *
 * Flow:
 * 1. Verify refresh token JWT
 * 2. Hash token → tìm trong DB
 * 3. Kiểm tra user vẫn active
 * 4. Tạo access token mới
 * 5. Log activity
 *
 * @param {string} refreshToken — Refresh token string
 * @param {{ ipAddress?: string, userAgent?: string }} context
 * @returns {Promise<{ accessToken: string, user: object }>}
 */
const refresh = async (refreshToken, context = {}) => {
    // 1. Verify JWT
    let decoded;
    try {
        decoded = verifyRefreshToken(refreshToken);
    } catch (err) {
        throw new Api401Error(t('invalid_refresh_token', context.lang));
    }

    // 2. Tìm trong DB
    const tokenHash = hashToken(refreshToken);
    const storedToken = await tokenRepository.findRefreshToken(tokenHash);
    if (!storedToken) {
        throw new Api401Error(t('refresh_token_revoked', context.lang));
    }

    // 3. Kiểm tra user
    const user = await userRepository.findById(decoded.userId);
    if (!user || !user.is_active) {
        // Revoke token nếu user không còn active
        await tokenRepository.revokeRefreshToken(tokenHash);
        throw new Api401Error(t('account_disabled', context.lang));
    }

    // 4. Tạo access token mới
    const accessTokenData = generateAccessToken({
        userId: user.id,
        email: user.email,
        role: user.role,
    });

    // 5. Log activity
    await _logActivity(user.id, 'refresh_token', 'success', context);

    return {
        accessToken: accessTokenData.token,
        user: _sanitizeUser(user, context.lang),
    };
};

/**
 * Logout — Blacklist access token + Revoke refresh token
 *
 * @param {{ jti: string, accessExpiresAt?: Date }} accessTokenInfo
 * @param {string} [refreshToken] — Nếu có, revoke refresh token
 * @param {number} userId
 * @param {{ ipAddress?: string, userAgent?: string }} context
 * @returns {Promise<void>}
 */
const logout = async (accessTokenInfo, refreshToken, userId, context = {}) => {
    // Blacklist access token (dùng JTI)
    if (accessTokenInfo.jti) {
        // Tính expiresAt từ JWT hoặc dùng mặc định 7 ngày
        const expiresAt = accessTokenInfo.accessExpiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await tokenRepository.addToBlacklist(accessTokenInfo.jti, expiresAt);
    }

    // Revoke refresh token nếu có
    if (refreshToken) {
        const tokenHash = hashToken(refreshToken);
        await tokenRepository.deleteRefreshToken(tokenHash);
    }

    // Log activity
    await _logActivity(userId, 'logout', 'success', context);
};

/**
 * Đổi mật khẩu — Yêu cầu xác nhận mật khẩu cũ
 *
 * Flow:
 * 1. Tìm user + kiểm tra có password (không phải Google-only)
 * 2. Verify mật khẩu cũ
 * 3. Hash mật khẩu mới
 * 4. Cập nhật trong DB
 * 5. Xóa tất cả refresh tokens (force re-login tất cả devices)
 * 6. Log activity
 *
 * @param {number} userId
 * @param {{ oldPassword: string, newPassword: string }} data
 * @param {{ ipAddress?: string, userAgent?: string }} context
 * @returns {Promise<{ message: string }>}
 */
const changePassword = async (userId, { oldPassword, newPassword }, context = {}) => {
    // 1. Tìm user
    const user = await userRepository.findById(userId);
    if (!user) {
        throw new Api404Error(t('user_not_found', context.lang));
    }

    if (!user.password_hash) {
        throw new Api400Error(
            t('google_no_password', context.lang)
        );
    }

    // 2. Verify mật khẩu cũ
    const isOldPasswordValid = await comparePassword(oldPassword, user.password_hash);
    if (!isOldPasswordValid) {
        await _logActivity(userId, 'change_password', 'failure', context, { reason: 'wrong_old_password' });
        throw new Api401Error(t('incorrect_old_password', context.lang));
    }

    // 3. Kiểm tra mật khẩu mới khác mật khẩu cũ
    const isSamePassword = await comparePassword(newPassword, user.password_hash);
    if (isSamePassword) {
        throw new Api400Error(t('same_password', context.lang));
    }

    // 4. Hash + cập nhật
    const newPasswordHash = await hashPassword(newPassword);
    await userRepository.updatePassword(userId, newPasswordHash);

    // 5. Xóa tất cả refresh tokens → force re-login
    await tokenRepository.deleteAllUserTokens(userId);

    // 6. Log activity
    await _logActivity(userId, 'change_password', 'success', context);

    return { message: t('password_changed_success', context.lang) };
};

/**
 * Google OAuth callback — Tìm hoặc tạo user từ Google profile
 *
 * Flow (dùng bảng auth.social_accounts):
 * 1. Tìm social account theo provider='google' + provider_id
 * 2. Nếu đã liên kết → lấy user, cập nhật thông tin provider
 * 3. Nếu chưa → tìm user theo email
 *    a. Email tồn tại → tạo social account liên kết
 *    b. Email chưa có → tạo user mới + social account
 * 4. Tạo tokens
 *
 * @param {{ googleId: string, email: string, fullName: string, avatarUrl?: string }} googleProfile
 * @param {{ ipAddress?: string, userAgent?: string }} context
 * @returns {Promise<{ user: object, accessToken: string, refreshToken: string, isNewUser: boolean }>}
 */
const googleAuthCallback = async (googleProfile, context = {}) => {
    let user;
    let isNewUser = false;

    // 1. Tìm social account đã liên kết
    const existingSocial = await socialRepository.findByProviderId('google', googleProfile.googleId);

    if (existingSocial) {
        // 2. Đã liên kết → lấy user + cập nhật thông tin provider
        user = await userRepository.findById(existingSocial.user_id);

        await socialRepository.updateByProviderId('google', googleProfile.googleId, {
            providerEmail: googleProfile.email,
            providerName: googleProfile.fullName,
            providerAvatar: googleProfile.avatarUrl,
        });
    } else {
        // 3. Chưa liên kết → tìm user theo email
        user = await userRepository.findByEmail(googleProfile.email);

        if (user) {
            // 3a. User tồn tại → tạo social account liên kết
            await socialRepository.create({
                userId: user.id,
                provider: 'google',
                providerId: googleProfile.googleId,
                providerEmail: googleProfile.email,
                providerName: googleProfile.fullName,
                providerAvatar: googleProfile.avatarUrl,
            });

            // Cập nhật avatar nếu chưa có
            if (!user.avatar_url && googleProfile.avatarUrl) {
                await userRepository.updateAvatar(user.id, googleProfile.avatarUrl);
            }

            await _logActivity(user.id, 'social_link', 'success', context, { provider: 'google' });
        } else {
            // 3b. User chưa tồn tại → tạo user mới + social account
            user = await userRepository.create({
                email: googleProfile.email,
                fullName: googleProfile.fullName,
                avatarUrl: googleProfile.avatarUrl,
                roleCode: 'citizen',
            });

            await socialRepository.create({
                userId: user.id,
                provider: 'google',
                providerId: googleProfile.googleId,
                providerEmail: googleProfile.email,
                providerName: googleProfile.fullName,
                providerAvatar: googleProfile.avatarUrl,
            });

            isNewUser = true;
            await _logActivity(user.id, 'register', 'success', context, { method: 'google' });
        }
    }

    // Kiểm tra active
    if (!user || !user.is_active) {
        throw new Api401Error(t('account_disabled', context.lang));
    }

    // 4. Tạo tokens
    const tokens = generateTokenPair({
        userId: user.id,
        email: user.email,
        role: user.role,
    });

    const refreshTokenHash = hashToken(tokens.refreshToken);
    await tokenRepository.saveRefreshToken({
        userId: user.id,
        tokenHash: refreshTokenHash,
        deviceInfo: _buildDeviceInfo(context),
        expiresAt: tokens.refreshExpiresAt,
    });

    // Cập nhật last login
    await userRepository.updateLoginSuccess(user.id, context.ipAddress);
    await _logActivity(user.id, 'social_login', 'success', context, { provider: 'google' });

    return {
        user: _sanitizeUser(user, context.lang),
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        isNewUser,
    };
};

/**
 * Lấy thông tin user hiện tại (cho endpoint /me)
 * @param {number} userId
 * @param {object} context
 * @returns {Promise<object>}
 */
const getMe = async (userId, context = {}) => {
    const user = await userRepository.findByIdSafe(userId);
    if (!user) {
        throw new Api404Error(t('user_not_found', context.lang));
    }
    return _sanitizeUser(user, context.lang);
};

// ═══════════════════════════════════════════════════════════════════════════
//  PRIVATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Loại bỏ các field nhạy cảm trước khi trả về client
 */
const _sanitizeUser = (user, lang = 'vi') => {
    const { password_hash, login_attempts, locked_until, ...safeUser } = user;
    safeUser.role_name = lang === 'en' ? (safeUser.role_name_en || safeUser.role_name_vi) : safeUser.role_name_vi;
    return safeUser;
};

/**
 * Build device info từ request context
 */
const _buildDeviceInfo = (context) => {
    return {
        ip: context.ipAddress || null,
        userAgent: context.userAgent || null,
        loginAt: new Date().toISOString(),
    };
};

/**
 * Ghi log activity (fire-and-forget, không throw nếu lỗi)
 */
const _logActivity = async (userId, action, status, context = {}, metadata = {}) => {
    try {
        await tokenRepository.logActivity({
            userId,
            action,
            status,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadata,
        });
    } catch (err) {
        // Không throw — log activity failure không nên break main flow
        console.error('[AUTH] Activity log failed:', err.message);
    }
};

module.exports = {
    register,
    login,
    refresh,
    logout,
    changePassword,
    googleAuthCallback,
    getMe,
};
