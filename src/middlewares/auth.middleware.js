const passport = require('passport');
const { Api401Error, Api403Error } = require('../core/error.response');
const { t } = require('../utils/i18n');

const verifyToken = (req, res, next) => {
    passport.authenticate('jwt', { session: false }, (err, user, info) => {
        if (err) return next(err);
        if (!user) throw new Api401Error(info?.message || t('please_login', req.lang));
        req.user = user;
        next();
    })(req, res, next);
};

const requireRole = (...roles) => {
    return (req, res, next) => {
        if (!req.user) throw new Api401Error(t('please_login', req.lang));
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
        if (err) return next(err);
        req.user = user || null;
        next();
    })(req, res, next);
};

const hasPermission = (permissions, resource, action) => {
    if (!permissions || typeof permissions !== 'object') return false;
    const resourcePerms = permissions[resource];
    if (!resourcePerms || typeof resourcePerms !== 'object') return false;
    return resourcePerms[action] === true;
};

const requirePermission = (resource, action) => {
    return (req, res, next) => {
        if (!req.user) throw new Api401Error(t('please_login', req.lang));
        if (req.user.role === 'system_admin') return next();
        if (!hasPermission(req.user.role_permissions, resource, action)) {
            throw new Api403Error(
                t('no_permission_resource', req.lang, { resource, action })
            );
        }
        next();
    };
};

module.exports = { verifyToken, requireRole, optionalAuth, hasPermission, requirePermission };
