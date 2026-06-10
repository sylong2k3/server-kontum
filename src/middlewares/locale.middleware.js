/**
 * Locale Middleware — Detect request language (vi/en)
 */

const localeMiddleware = (req, res, next) => {
    // 1. Get from query parameter '?lang=' or 'Accept-Language' header
    let lang = req.query.lang || req.headers['accept-language'] || 'vi';

    // Normalize
    if (lang.startsWith('en')) {
        lang = 'en';
    } else {
        lang = 'vi';
    }

    // Attach to request
    req.lang = lang;
    next();
};

module.exports = localeMiddleware;
