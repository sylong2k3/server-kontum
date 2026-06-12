const localeMiddleware = (req, res, next) => {
    let lang = req.query.lang || req.headers['accept-language'] || 'vi';
    if (lang.startsWith('en')) {
        lang = 'en';
    } else {
        lang = 'vi';
    }
    req.lang = lang;
    next();
};

module.exports = localeMiddleware;
