const userRepository = require('../repositories/user.repository');
const tokenRepository = require('../repositories/token.repository');
const socialRepository = require('../repositories/social.repository');
const { hashPassword, comparePassword, hashToken, generateRandomToken } = require('../utils/cryptoHelper.util');
const { generateTokenPair, verifyRefreshToken } = require('../utils/tokenManager.util');
const { Api400Error, Api401Error, Api403Error, Api409Error, Api404Error } = require('../core/error.response');
const { sendPasswordResetEmail, sendVerificationEmail } = require('../utils/mailer.util');
const { t } = require('../utils/i18n.util');

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const RESET_TOKEN_EXPIRES_MINUTES = parseInt(process.env.RESET_TOKEN_EXPIRES_MINUTES, 10) || 15;
const RESET_MAX_REQUESTS_PER_WINDOW = parseInt(process.env.RESET_MAX_REQUESTS, 10) || 3;
const OAUTH_CODE_EXPIRES_SECONDS = parseInt(process.env.OAUTH_CODE_EXPIRES_SECONDS, 10) || 60;

const REQUIRE_EMAIL_VERIFICATION = process.env.REQUIRE_EMAIL_VERIFICATION !== 'false';
const EMAIL_VERIFICATION_EXPIRES_MINUTES = parseInt(process.env.EMAIL_VERIFICATION_EXPIRES_MINUTES, 10) || 60;
const EMAIL_VERIFICATION_MAX_REQUESTS = parseInt(process.env.EMAIL_VERIFICATION_MAX_REQUESTS, 10) || 3;

const DUMMY_PASSWORD_HASH = '$2b$12$12l7tm6QooEdqRW4HUyj9uFsD0VvZqZh8YrVLdjN2No.SKaXrfhl6';

const PG_UNIQUE_VIOLATION = '23505';

const register = async ({ email, password, fullName, phone }, context = {}) => {
    const existingUser = await userRepository.findByEmail(email);
    if (existingUser) {
        throw new Api409Error(t('email_in_use', context.lang));
    }

    const passwordHash = await hashPassword(password);

    let user;
    try {
        user = await userRepository.create({ email, passwordHash, fullName, phone });
    } catch (err) {
        if (err.code === PG_UNIQUE_VIOLATION) {
            throw new Api409Error(t('email_in_use', context.lang));
        }
        throw err;
    }

    if (REQUIRE_EMAIL_VERIFICATION) {
        await _createAndSendVerification(user, context);
        await _logActivity(user.id, 'register', 'success', context, { requiresVerification: true });

        return {
            user: _sanitizeUser(user, context.lang),
            requiresVerification: true,
        };
    }

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

    await userRepository.updateLoginSuccess(user.id, context.ipAddress);
    await _logActivity(user.id, 'register', 'success', context);

    return {
        user: _sanitizeUser(user, context.lang),
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        requiresVerification: false,
    };
};

const login = async ({ email, password }, context = {}) => {
    const user = await userRepository.findByEmail(email);
    if (!user) {
        await comparePassword(password, DUMMY_PASSWORD_HASH);
        await _logActivity(null, 'login_failed', 'failure', context, { email });
        throw new Api401Error(t('incorrect_credentials', context.lang));
    }

    if (!user.is_active) {
        await _logActivity(user.id, 'login_failed', 'failure', context, { reason: 'account_inactive' });
        throw new Api401Error(t('incorrect_credentials', context.lang));
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
        const remainingMinutes = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
        await _logActivity(user.id, 'login_failed', 'failure', context, { reason: 'account_locked' });
        throw new Api401Error(t('account_locked_mins', context.lang, { mins: remainingMinutes }));
    }

    if (!user.password_hash) {
        await _logActivity(user.id, 'login_failed', 'failure', context, { reason: 'google_only' });
        throw new Api401Error(t('incorrect_credentials', context.lang));
    }

    const isPasswordValid = await comparePassword(password, user.password_hash);
    if (!isPasswordValid) {
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

    if (REQUIRE_EMAIL_VERIFICATION && !user.email_verified) {
        await _logActivity(user.id, 'login_failed', 'failure', context, { reason: 'email_not_verified' });
        throw new Api403Error(t('email_not_verified', context.lang));
    }

    await userRepository.updateLoginSuccess(user.id, context.ipAddress);

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

    await _logActivity(user.id, 'login', 'success', context);

    return {
        user: _sanitizeUser(user, context.lang),
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
    };
};

const refresh = async (refreshToken, context = {}) => {
    let decoded;
    try {
        decoded = verifyRefreshToken(refreshToken);
    } catch (err) {
        throw new Api401Error(t('invalid_refresh_token', context.lang));
    }

    const tokenHash = hashToken(refreshToken);
    const storedToken = await tokenRepository.findRefreshToken(tokenHash);

    if (!storedToken) {
        if (decoded?.userId) {
            await tokenRepository.deleteAllUserTokens(decoded.userId);
            await _logActivity(decoded.userId, 'token_reuse_detected', 'failure', context);
        }
        throw new Api401Error(t('refresh_token_revoked', context.lang));
    }

    const user = await userRepository.findById(decoded.userId);
    if (!user || !user.is_active) {
        await tokenRepository.deleteRefreshToken(tokenHash);
        throw new Api401Error(t('account_disabled', context.lang));
    }

    await tokenRepository.deleteRefreshToken(tokenHash);

    const tokens = generateTokenPair({
        userId: user.id,
        email: user.email,
        role: user.role,
    });

    const newRefreshHash = hashToken(tokens.refreshToken);
    await tokenRepository.saveRefreshToken({
        userId: user.id,
        tokenHash: newRefreshHash,
        deviceInfo: storedToken.device_info || _buildDeviceInfo(context),
        expiresAt: tokens.refreshExpiresAt,
    });

    await _logActivity(user.id, 'refresh_token', 'success', context);

    return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: _sanitizeUser(user, context.lang),
    };
};

const logout = async (accessTokenInfo, refreshToken, userId, context = {}) => {
    if (accessTokenInfo.jti) {
        const expiresAt = accessTokenInfo.exp
            ? new Date(accessTokenInfo.exp * 1000)
            : new Date(Date.now() + 60 * 60 * 1000);
        await tokenRepository.addToBlacklist(accessTokenInfo.jti, expiresAt);
    }

    if (refreshToken) {
        const tokenHash = hashToken(refreshToken);
        await tokenRepository.deleteRefreshToken(tokenHash);
    }

    await _logActivity(userId, 'logout', 'success', context);
};

const changePassword = async (userId, { oldPassword, newPassword }, context = {}) => {
    const user = await userRepository.findById(userId);
    if (!user) {
        throw new Api404Error(t('user_not_found', context.lang));
    }

    if (!user.password_hash) {
        throw new Api400Error(t('google_no_password', context.lang));
    }

    const isOldPasswordValid = await comparePassword(oldPassword, user.password_hash);
    if (!isOldPasswordValid) {
        await _logActivity(userId, 'change_password', 'failure', context, { reason: 'wrong_old_password' });
        throw new Api401Error(t('incorrect_old_password', context.lang));
    }

    const isSamePassword = await comparePassword(newPassword, user.password_hash);
    if (isSamePassword) {
        throw new Api400Error(t('same_password', context.lang));
    }

    const newPasswordHash = await hashPassword(newPassword);
    await userRepository.updatePassword(userId, newPasswordHash);

    await tokenRepository.deleteAllUserTokens(userId);
    await _logActivity(userId, 'change_password', 'success', context);

    return { message: t('password_changed_success', context.lang) };
};

const setPassword = async (userId, { newPassword }, context = {}) => {
    const user = await userRepository.findById(userId);
    if (!user) {
        throw new Api404Error(t('user_not_found', context.lang));
    }

    if (!user.is_active) {
        throw new Api401Error(t('account_disabled', context.lang));
    }

    if (user.password_hash) {
        throw new Api400Error(t('password_already_set', context.lang));
    }

    const hasActiveSocialAccount = await socialRepository.hasActiveProvider(userId);
    if (!hasActiveSocialAccount) {
        throw new Api400Error(t('password_setup_not_allowed', context.lang));
    }

    const newPasswordHash = await hashPassword(newPassword);
    await userRepository.updatePassword(userId, newPasswordHash);
    await tokenRepository.deleteAllUserTokens(userId);
    await _logActivity(userId, 'set_password', 'success', context);

    return {
        message: t('password_set_success', context.lang),
        data: { has_password: true },
    };
};

const forgotPassword = async ({ email }, context = {}) => {
    const genericMessage = t('reset_email_sent', context.lang);
    const user = await userRepository.findByEmail(email);

    if (!user || !user.is_active) {
        await _logActivity(user?.id || null, 'password_reset_request', 'failure', context, {
            email,
            reason: user ? 'inactive' : 'not_found',
        });
        return { message: genericMessage };
    }

    if (!user.password_hash) {
        await _logActivity(user.id, 'password_reset_request', 'failure', context, { reason: 'google_only' });
        return { message: genericMessage };
    }

    const recentCount = await tokenRepository.countRecentResetRequests(user.id, RESET_TOKEN_EXPIRES_MINUTES);
    if (recentCount >= RESET_MAX_REQUESTS_PER_WINDOW) {
        await _logActivity(user.id, 'password_reset_request', 'failure', context, { reason: 'rate_limited' });
        return { message: genericMessage };
    }

    await tokenRepository.invalidateUserResetTokens(user.id);

    const rawToken = generateRandomToken(32);
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRES_MINUTES * 60 * 1000);

    await tokenRepository.savePasswordResetToken({
        userId: user.id,
        tokenHash,
        expiresAt,
        requestIp: context.ipAddress,
    });

    const frontendUrl = process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:3000';
    const resetUrl = `${frontendUrl}/auth/reset-password?token=${rawToken}`;

    try {
        await sendPasswordResetEmail({
            to: user.email,
            fullName: user.full_name,
            resetUrl,
            expiresMinutes: RESET_TOKEN_EXPIRES_MINUTES,
            lang: context.lang,
        });
    } catch (err) {
        console.error('[AUTH] Failed to send reset email:', err.message);
    }

    await _logActivity(user.id, 'password_reset_request', 'success', context);

    return { message: genericMessage };
};

const resetPassword = async ({ token, newPassword }, context = {}) => {
    const tokenHash = hashToken(token);
    const resetToken = await tokenRepository.findValidPasswordResetToken(tokenHash);
    if (!resetToken) {
        await _logActivity(null, 'password_reset_failed', 'failure', context, { reason: 'invalid_or_expired' });
        throw new Api400Error(t('invalid_reset_token', context.lang));
    }

    const user = await userRepository.findById(resetToken.user_id);
    if (!user || !user.is_active) {
        await _logActivity(resetToken.user_id, 'password_reset_failed', 'failure', context, { reason: 'inactive' });
        throw new Api400Error(t('invalid_reset_token', context.lang));
    }

    if (user.password_hash) {
        const isSamePassword = await comparePassword(newPassword, user.password_hash);
        if (isSamePassword) {
            throw new Api400Error(t('same_password', context.lang));
        }
    }

    const newPasswordHash = await hashPassword(newPassword);
    await userRepository.updatePassword(user.id, newPasswordHash);

    await tokenRepository.markPasswordResetTokenUsed(resetToken.id);
    await tokenRepository.invalidateUserResetTokens(user.id);
    await tokenRepository.deleteAllUserTokens(user.id);

    await _logActivity(user.id, 'password_reset', 'success', context);

    return { message: t('password_reset_success', context.lang) };
};

const verifyEmail = async ({ token }, context = {}) => {
    const tokenHash = hashToken(token);
    const verifToken = await tokenRepository.findValidEmailVerificationToken(tokenHash);
    if (!verifToken) {
        throw new Api400Error(t('invalid_verification_token', context.lang));
    }

    const user = await userRepository.findById(verifToken.user_id);
    if (!user || !user.is_active) {
        throw new Api400Error(t('invalid_verification_token', context.lang));
    }

    await userRepository.markEmailVerified(user.id);
    await tokenRepository.markEmailVerificationTokenUsed(verifToken.id);
    await tokenRepository.invalidateUserEmailVerificationTokens(user.id);

    await _logActivity(user.id, 'email_verified', 'success', context);

    return { message: t('email_verified_success', context.lang) };
};

const resendVerification = async ({ email }, context = {}) => {
    const genericMessage = t('verification_email_sent', context.lang);
    const user = await userRepository.findByEmail(email);

    if (!user || !user.is_active || user.email_verified) {
        return { message: genericMessage };
    }

    const recentCount = await tokenRepository.countRecentEmailVerificationRequests(
        user.id,
        EMAIL_VERIFICATION_EXPIRES_MINUTES
    );
    if (recentCount >= EMAIL_VERIFICATION_MAX_REQUESTS) {
        return { message: genericMessage };
    }

    await _createAndSendVerification(user, context);

    return { message: genericMessage };
};

const googleAuthCallback = async (googleProfile, context = {}) => {
    let user;
    let isNewUser = false;

    const existingSocial = await socialRepository.findByProviderId('google', googleProfile.googleId);

    if (existingSocial) {
        user = await userRepository.findById(existingSocial.user_id);

        await socialRepository.updateByProviderId('google', googleProfile.googleId, {
            providerEmail: googleProfile.email,
            providerName: googleProfile.fullName,
            providerAvatar: googleProfile.avatarUrl,
        });
    } else {
        user = await userRepository.findByEmail(googleProfile.email);

        if (user) {
            await socialRepository.create({
                userId: user.id,
                provider: 'google',
                providerId: googleProfile.googleId,
                providerEmail: googleProfile.email,
                providerName: googleProfile.fullName,
                providerAvatar: googleProfile.avatarUrl,
            });

            if (!user.avatar_url && googleProfile.avatarUrl) {
                await userRepository.updateAvatar(user.id, googleProfile.avatarUrl);
            }

            await _logActivity(user.id, 'social_link', 'success', context, { provider: 'google' });
        } else {
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

    if (!user || !user.is_active) {
        throw new Api401Error(t('account_disabled', context.lang));
    }

    if (!user.email_verified) {
        await userRepository.markEmailVerified(user.id);
        user.email_verified = true;
    }

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

    await userRepository.updateLoginSuccess(user.id, context.ipAddress);
    await _logActivity(user.id, 'social_login', 'success', context, { provider: 'google' });

    return {
        user: _sanitizeUser(user, context.lang),
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        isNewUser,
    };
};

const createOAuthExchangeCode = async (authResult) => {
    const rawCode = generateRandomToken(32);
    const codeHash = hashToken(rawCode);
    const expiresAt = new Date(Date.now() + OAUTH_CODE_EXPIRES_SECONDS * 1000);

    await tokenRepository.saveOAuthExchangeCode({
        codeHash,
        userId: authResult.user.id,
        accessToken: authResult.accessToken,
        refreshToken: authResult.refreshToken,
        isNewUser: authResult.isNewUser,
        expiresAt,
    });

    return rawCode;
};

const exchangeOAuthCode = async ({ code }, context = {}) => {
    const codeHash = hashToken(code);
    const record = await tokenRepository.consumeOAuthExchangeCode(codeHash);

    if (!record) {
        throw new Api400Error(t('invalid_oauth_code', context.lang));
    }

    return {
        accessToken: record.access_token,
        refreshToken: record.refresh_token,
        isNewUser: record.is_new_user,
    };
};

const getMe = async (userId, context = {}) => {
    const user = await userRepository.findByIdSafe(userId);
    if (!user) {
        throw new Api404Error(t('user_not_found', context.lang));
    }
    return _sanitizeUser(user, context.lang);
};

const updateMe = async (userId, data, file, context = {}) => {
    const user = await userRepository.findById(userId);
    if (!user) {throw new Api404Error(t('user_not_found', context.lang));}

    let avatarUrl = data.avatarUrl;
    if (file) {
        avatarUrl = `${file._relativeDir}/${file.filename}`;
    }

    const normalized = {
        ...data,
        phone: data.phone !== undefined ? (data.phone === '' ? null : data.phone) : undefined,
        avatarUrl: avatarUrl !== undefined ? (avatarUrl === '' ? null : avatarUrl) : undefined,
    };

    const updated = await userRepository.updateProfile(userId, normalized);
    if (!updated) {
        // user đã xác nhận tồn tại ở trên → null nghĩa là expectedUpdatedAt lệch (conflict)
        if (normalized.expectedUpdatedAt) { throw new Api409Error(t('optimistic_lock_conflict', context.lang)); }
        throw new Api404Error(t('user_not_found', context.lang));
    }
    await _logActivity(userId, 'update_profile', 'success', context);
    return _sanitizeUser(updated, context.lang);
};

const _sanitizeUser = (user, lang = 'vi') => {
    const roleName = lang === 'en'
        ? (user.role_name_en || user.role_name_vi)
        : user.role_name_vi;

    return {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        phone: user.phone,
        avatar_url: user.avatar_url,
        role: {
            code: user.role,
            name: roleName,
            permissions: user.role_permissions || {},
        },
        is_active: user.is_active,
        email_verified: user.email_verified,
        must_change_password: user.must_change_password || false,
        has_password: Boolean(user.password_hash),
    };
};

const _buildDeviceInfo = (context) => {
    return {
        ip: context.ipAddress || null,
        userAgent: context.userAgent || null,
        loginAt: new Date().toISOString(),
    };
};

const _createAndSendVerification = async (user, context = {}) => {
    await tokenRepository.invalidateUserEmailVerificationTokens(user.id);

    const rawToken = generateRandomToken(32);
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_EXPIRES_MINUTES * 60 * 1000);

    await tokenRepository.saveEmailVerificationToken({
        userId: user.id,
        tokenHash,
        expiresAt,
        requestIp: context.ipAddress,
    });

    const frontendUrl = process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:3000';
    const verifyUrl = `${frontendUrl}/auth/verify-email?token=${rawToken}`;

    try {
        await sendVerificationEmail({
            to: user.email,
            fullName: user.full_name,
            verifyUrl,
            expiresMinutes: EMAIL_VERIFICATION_EXPIRES_MINUTES,
            lang: context.lang,
        });
    } catch (err) {
        console.error('[AUTH] Failed to send verification email:', err.message);
    }

    await _logActivity(user.id, 'email_verification_sent', 'success', context);
};

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
        console.error('[AUTH] Activity log failed:', err.message);
    }
};

const googleMobileLogin = async ({ idToken }, context = {}) => {
    let payload;
    try {
        const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
        if (!response.ok) {
            throw new Error('Google tokeninfo verification failed');
        }
        payload = await response.json();
    } catch (err) {
        throw new Api401Error(t('invalid_token', context.lang));
    }

    const allowedAudiences = [
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_ANDROID_CLIENT_ID,
        process.env.GOOGLE_IOS_CLIENT_ID
    ].filter(Boolean);

    if (!allowedAudiences.includes(payload.aud)) {
        throw new Api401Error(t('invalid_token', context.lang));
    }

    const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
    if (!validIssuers.includes(payload.iss)) {
        throw new Api401Error(t('invalid_token', context.lang));
    }

    if (!payload.exp || Number(payload.exp) * 1000 < Date.now()) {
        throw new Api401Error(t('invalid_token', context.lang));
    }

    if (!payload.email || (payload.email_verified !== true && payload.email_verified !== 'true')) {
        throw new Api401Error(t('invalid_token', context.lang));
    }

    const googleProfile = {
        googleId: payload.sub,
        email: payload.email,
        fullName: payload.name || payload.email.split('@')[0],
        avatarUrl: payload.picture || null,
    };

    return googleAuthCallback(googleProfile, context);
};

module.exports = {
    register,
    login,
    refresh,
    logout,
    changePassword,
    setPassword,
    forgotPassword,
    resetPassword,
    verifyEmail,
    resendVerification,
    googleAuthCallback,
    createOAuthExchangeCode,
    exchangeOAuthCode,
    googleMobileLogin,
    getMe,
    updateMe,
};
