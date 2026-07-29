const passport = require('passport');
const { Api401Error, Api403Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');

const verifyToken = (req, res, next) => {
    passport.authenticate('jwt', { session: false }, (err, user, info) => {
        if (err) {return next(err);}
        if (!user) {return next(new Api401Error(info?.message || t('please_login', req.lang)));}
        req.user = user;
        return next();
    })(req, res, next);
};

const requireRole = (...roles) => {
    return (req, res, next) => {
        if (!req.user) {throw new Api401Error(t('please_login', req.lang));}
        if (!roles.includes(req.user.role)) {
            throw new Api403Error(
                t('no_permission', req.lang, {
                    roles: roles.join(req.lang === 'en' ? ' or ' : ' hoặc ')
                })
            );
        }
        next();
    };
};

const enforcePasswordChange = (req, res, next) => {
    if (!req.user) {throw new Api401Error(t('please_login', req.lang));}
    if (req.user.must_change_password === true) {
        throw new Api403Error(
            t('password_change_required', req.lang),
            ['PASSWORD_CHANGE_REQUIRED']
        );
    }
    next();
};

const optionalAuth = (req, res, next) => {
    passport.authenticate('jwt', { session: false }, (err, user, info) => {
        if (err) {return next(err);}
        // Có gửi Authorization nhưng JWT không hợp lệ (hết hạn/bị thu hồi/user
        // bị khoá) — phải trả 401 thật để AuthInterceptor phía client tự
        // refresh token, thay vì âm thầm hạ xuống guest khiến các endpoint
        // yêu cầu định danh (vd. ensureOwnerIdentity trong feedback.service.js)
        // báo lỗi khó hiểu "thiếu x-anonymous-id".
        if (!user && req.headers.authorization) {
            return next(new Api401Error(info?.message || t('please_login', req.lang)));
        }
        req.user = user || null;
        next();
    })(req, res, next);
};

const hasPermission = (permissions, resource, action) => {
    if (!permissions || typeof permissions !== 'object') {return false;}
    const resourcePerms = permissions[resource];
    if (!resourcePerms || typeof resourcePerms !== 'object') {return false;}
    return resourcePerms[action] === true;
};

const requirePermission = (resource, action) => {
    return (req, res, next) => {
        if (!req.user) {throw new Api401Error(t('please_login', req.lang));}
        if (req.user.role === 'system_admin') {return next();}
        if (!hasPermission(req.user.role_permissions, resource, action)) {
            throw new Api403Error(
                t('no_permission_resource', req.lang, { resource, action })
            );
        }
        next();
    };
};

module.exports = { verifyToken, requireRole, enforcePasswordChange, optionalAuth, hasPermission, requirePermission };
