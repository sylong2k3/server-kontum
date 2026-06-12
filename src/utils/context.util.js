const getRequestContext = (req) => ({
    ipAddress: req.ip || req.connection?.remoteAddress,
    userAgent: req.get('user-agent'),
    lang: req.lang || 'vi',
});

module.exports = { getRequestContext };
