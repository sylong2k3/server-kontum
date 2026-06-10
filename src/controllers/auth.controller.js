const authService = require('../services/auth.service');
const { OK, CREATED } = require('../core/success.response');
const { getRequestContext } = require('../utils/context');
const { t } = require('../utils/i18n');

/**
 * POST /api/v1/auth/register
 * Body: { email, password, fullName, phone? }
 */
const register = async (req, res) => {
    const { email, password, fullName, phone } = req.body;
    const context = getRequestContext(req);

    const result = await authService.register(
        { email, password, fullName, phone },
        context
    );
    CREATED(res, t('register_success', req.lang), result);
};

/**
 * POST /api/v1/auth/login
 * Body: { email, password }
 */
const login = async (req, res) => {
    const { email, password } = req.body;
    const context = getRequestContext(req);

    const result = await authService.login({ email, password }, context);

    OK(res, t('login_success', req.lang), result);
};

/**
 * POST /api/v1/auth/refresh
 * Body: { refreshToken }
 */
const refreshToken = async (req, res) => {
    const { refreshToken } = req.body;
    const context = getRequestContext(req);

    const result = await authService.refresh(refreshToken, context);

    OK(res, t('refresh_success', req.lang), result);
};

/**
 * POST /api/v1/auth/logout
 * Headers: Authorization: Bearer <accessToken>
 * Body: { refreshToken? }
 */
const logout = async (req, res) => {
    const { refreshToken } = req.body;
    const context = getRequestContext(req);

    // req.user.jti được attach bởi passport JWT strategy
    const accessTokenInfo = {
        jti: req.user.jti,
    };

    await authService.logout(accessTokenInfo, refreshToken, req.user.id, context);

    OK(res, t('logout_success', req.lang));
};

/**
 * POST /api/v1/auth/change-password
 * Headers: Authorization: Bearer <accessToken>
 * Body: { oldPassword, newPassword }
 */
const changePassword = async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    const context = getRequestContext(req);

    const result = await authService.changePassword(
        req.user.id,
        { oldPassword, newPassword },
        context
    );

    OK(res, result.message);
};

/**
 * GET /api/v1/auth/me
 * Headers: Authorization: Bearer <accessToken>
 */
const getMe = async (req, res) => {
    const context = getRequestContext(req);
    const user = await authService.getMe(req.user.id, context);

    OK(res, t('get_me_success', req.lang), { user });
};

/**
 * GET /api/v1/auth/google
 * Redirect đến Google consent screen
 * (Handled trực tiếp bởi passport trong routes)
 */

/**
 * GET /api/v1/auth/google/callback
 * Google redirect về đây sau khi user cho phép
 */
const googleCallback = async (req, res) => {
    const context = getRequestContext(req);

    // req.user chứa Google profile (từ passport Google strategy)
    const result = await authService.googleAuthCallback(req.user, context);

    // Redirect về frontend với tokens trong query params
    // Frontend sẽ đọc tokens và lưu vào localStorage/cookie
    const frontendUrl = process.env.APP_URL || 'http://localhost:3000';
    const params = new URLSearchParams({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        isNewUser: result.isNewUser.toString(),
    });

    res.redirect(`${frontendUrl}/auth/callback?${params.toString()}`);
};

/**
 * POST /api/v1/auth/google/mobile
 * Body: { idToken }
 */
const googleMobileLogin = async (req, res) => {
    const { idToken } = req.body;
    const context = getRequestContext(req);

    const result = await authService.googleMobileLogin({ idToken }, context);

    OK(res, t('login_success', req.lang), result);
};

module.exports = {
    register,
    login,
    refreshToken,
    logout,
    changePassword,
    getMe,
    googleCallback,
    googleMobileLogin,
};
