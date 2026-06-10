const passport = require('passport');
const { Api401Error, Api403Error } = require('../core/error.response');
const { t } = require('../utils/i18n');

const verifyToken = (req, res, next) => {
    passport.authenticate('jwt', { session: false }, (err, user, info) => {
        if (err) {
            return next(err);
        }

        if (!user) {
            // info chứa thông tin lỗi từ passport strategy
            const message = info?.message || t('please_login', req.lang);
            throw new Api401Error(message);
        }

        // Attach user vào request (bao gồm cả jti để logout)
        req.user = user;
        next();
    })(req, res, next);
};

const requireRole = (...roles) => {
    return (req, res, next) => {
        if (!req.user) {
            throw new Api401Error(t('please_login', req.lang));
        }

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
const optionalAuth = (req, res, next) => {
    passport.authenticate('jwt', { session: false }, (err, user) => {
        if (err) {
            return next(err);
        }
        // Attach user nếu có, không throw error nếu không có
        req.user = user || null;
        next();
    })(req, res, next);
};

module.exports = {
    verifyToken,
    requireRole,
    optionalAuth,
};
